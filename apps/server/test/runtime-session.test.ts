import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ControlSubtype, type SessionEvent, STDERR_TEXT_MAX } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CrewSession, startSession } from "../src/runtime/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const KEEPER = fileURLToPath(new URL("../src/runtime/keeper-cli.ts", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";

let dir: string;
let transcript: string;
let keeperDirs = 0;
const sessions: CrewSession[] = [];

/** What `startSession` needs besides the CLI: a keeper under node, in a folder of its own. */
const keeperInput = () => ({
  node: process.execPath,
  entry: KEEPER,
  dir: join(dir, `k${++keeperDirs}`),
  spawn: `spawn-${keeperDirs}`,
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-session-")));
  transcript = join(dir, "seat.jsonl");
  keeperDirs = 0;
});
afterEach(async () => {
  // Never leave a fake running: close politely, and the short grace below ends a HANG one.
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

function start(
  extra: { controlTimeoutMs?: number; stopGraceMs?: number; bootDelayMs?: number } = {},
) {
  const { bootDelayMs, ...input } = extra;
  const s = startSession({
    command: process.execPath,
    args: [
      FAKE,
      "--session-id",
      SID,
      ...(bootDelayMs ? ["--boot-delay", String(bootDelayMs)] : []),
    ],
    cwd: dir,
    transcriptPath: transcript,
    stopGraceMs: 300,
    ...keeperInput(),
    ...input,
  });
  sessions.push(s);
  const events: SessionEvent[] = [];
  s.on((e) => events.push(e));
  /** Resolves with the `n`th event (1-based) matching `pred`, counting ones already received. */
  const until = (pred: (e: SessionEvent) => boolean, n = 1) =>
    new Promise<SessionEvent>((resolve, reject) => {
      const check = () => {
        const hits = events.filter(pred);
        if (hits.length >= n) {
          off();
          clearTimeout(timer);
          resolve(hits[n - 1] as SessionEvent);
        }
      };
      const off = s.on(() => queueMicrotask(check));
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.kind))}`));
      }, 5000);
      check();
    });
  return { s, events, until };
}

const kinds = (events: SessionEvent[]) =>
  events.filter((e) => e.kind !== "output").map((e) => e.kind);
const lines = () => readFileSync(transcript, "utf8").split("\n").slice(0, -1);
const parsed = () => lines().map((l) => JSON.parse(l));
const isResult = (e: SessionEvent) => e.kind === "result";
const isExit = (e: SessionEvent) => e.kind === "exit";

describe("startSession against the fake CLI", () => {
  it("a turn emits init, turn-start and result, and the transcript holds every line", async () => {
    const { s, events, until } = start();
    expect(s.alive).toBe(true);
    await s.ready; // the keeper's hello names the CLI's pid
    expect(typeof s.pid).toBe("number");
    s.send("hello");
    await until(isResult);
    expect(kinds(events)).toEqual(["init", "rate-limit", "turn-start", "result"]);
    expect(events.find((e) => e.kind === "init")).toEqual({
      kind: "init",
      sessionId: SID,
      model: "claude-haiku-5-5",
    });
    expect(events.find(isResult)).toEqual({
      kind: "result",
      isError: false,
      stopReason: "end_turn",
    });
    expect(await s.close()).toBe(0);
    const types = parsed().map((l) => l.type);
    expect(types).toEqual(["system", "rate_limit_event", "assistant", "result"]);
    expect(events.filter((e) => e.kind === "output")).toHaveLength(4);
    expect(statSync(transcript).mode & 0o777).toBe(0o600);
  });

  it("writes the user line the CLI expects", async () => {
    const { s, until } = start();
    s.send('say "hi"\nthen stop');
    await until(isResult);
    const reply = parsed().find((l) => l.type === "assistant");
    expect(reply.message.content[0].text).toBe('echo: say "hi"\nthen stop');
  });

  it("appends to an existing transcript", async () => {
    writeFileSync(transcript, '{"type":"earlier"}\n');
    const { s, until } = start();
    s.send("hi");
    await until(isResult);
    await s.close();
    expect(lines()[0]).toBe('{"type":"earlier"}');
    expect(lines()).toHaveLength(5);
  });

  it("two sends 10 ms apart reach the CLI in order", async () => {
    const { s, until } = start();
    s.send("one");
    await new Promise((r) => setTimeout(r, 10));
    s.send("two");
    await until(isResult, 2);
    const texts = parsed()
      .filter((l) => l.type === "assistant")
      .map((l) => l.message.content[0].text);
    expect(texts).toEqual(["echo: one", "echo: two"]);
  });

  it("an interrupt during a tool call resolves and a result follows", async () => {
    const { s, events, until } = start();
    s.send("SLOW");
    await until((e) => e.kind === "turn-start");
    expect(await s.control("interrupt")).toEqual({ still_queued: [] });
    expect(await until(isResult)).toEqual({
      kind: "result",
      isError: true,
      stopReason: "tool_use",
    });
    expect(kinds(events)).toEqual(["init", "rate-limit", "turn-start", "tool-result", "result"]);
    expect(events.find((e) => e.kind === "tool-result")).toEqual({
      kind: "tool-result",
      toolUseId: "toolu_1",
    });
    // As the real CLI: the tool call is closed, then the interrupt is marked.
    const users = parsed()
      .filter((l) => l.type === "user")
      .map((l) => l.message.content[0]);
    expect(users[0].type).toBe("tool_result");
    expect(users[0].content).toContain("doesn't want to proceed");
    expect(users[1]).toEqual({ type: "text", text: "[Request interrupted by user for tool use]" });
    expect(parsed().at(-1)).toMatchObject({ subtype: "error_during_execution", is_error: true });
    // The next line starts a normal turn.
    s.send("again");
    await until(isResult, 2);
    expect(kinds(events)).toEqual([
      ...["init", "rate-limit", "turn-start", "tool-result", "result"],
      ...["init", "rate-limit", "turn-start", "result"],
    ]);
  });

  it("reports a tool call's end by its tool_use id, before the turn's result", async () => {
    const { s, events, until } = start();
    s.send("TOOLGAP");
    await until((e) => e.kind === "turn-start");
    s.send("cue: the call ends");
    const ended = await until((e) => e.kind === "tool-result");
    expect(ended).toEqual({ kind: "tool-result", toolUseId: "toolu_g" });
    expect(events.some(isResult)).toBe(false);
    s.send("cue: the turn ends");
    await until(isResult);
    // each cue is a user line written mid-turn, so the reply after it counts as a turn start
    expect(kinds(events)).toEqual([
      ...["init", "rate-limit", "turn-start", "tool-result", "turn-start", "result"],
    ]);
  });

  it("get_context_usage returns the categories", async () => {
    const { s } = start();
    const usage = (await s.control("get_context_usage")) as { categories: { name: string }[] };
    expect(usage.categories.map((c) => c.name)).toEqual(["System prompt", "Messages"]);
  });

  it("an unanswered control request rejects after the timeout", async () => {
    const { s, until } = start({ controlTimeoutMs: 200 });
    s.send("NOCONTROL");
    await until(isResult);
    const t0 = Date.now();
    await expect(s.control("get_context_usage")).rejects.toThrow("control timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(s.alive).toBe(true);
  });

  it("a process that dies mid-turn: exit 3, half line kept but not parsed, controls rejected", async () => {
    const { s, events, until } = start();
    s.send("NOCONTROL");
    await until(isResult);
    const pending = s.control("get_usage");
    s.send("DIE");
    await expect(pending).rejects.toThrow("session ended");
    expect(await until(isExit)).toEqual({ kind: "exit", code: 3, signal: null });
    expect(s.alive).toBe(false);
    // The cut line is valid JSON, so only "not parsed" keeps this result out of the events.
    expect(events.filter(isResult)).toHaveLength(1);
    expect(lines().at(-1)).toBe('{"type":"result","is_error":true,"stop_reason":"half"}');
    expect(readFileSync(transcript, "utf8").endsWith("\n")).toBe(true);
    // Events after the exit: none; a dead session refuses work without crashing.
    expect(events.at(-1)?.kind).toBe("exit");
    expect(() => s.send("hello")).toThrow("session ended");
    await expect(s.control("interrupt")).rejects.toThrow("session ended");
    expect(await s.close()).toBe(3);
  });

  it("close() resolves when the CLI exits on EOF", async () => {
    const { s, events, until } = start();
    // Wait until the CLI is up: the grace period runs from close(), so closing a node still
    // booting under load can reach SIGTERM before it reads EOF (exit code null, not 0).
    s.send("hello");
    await until(isResult);
    expect(await s.close()).toBe(0);
    expect(events.filter(isExit)).toEqual([{ kind: "exit", code: 0, signal: null }]);
    expect(s.alive).toBe(false);
    // Closing twice is harmless.
    expect(await s.close()).toBe(0);
  });

  // The grace runs from close(), not from the CLI being ready: a CLI that boots slower than the
  // grace gets SIGTERM before it reads EOF. This pins the race behind the #66 flake. The real flake
  // needed a boot slower than the 300 ms test grace, so only heavy load triggers it (a normal node
  // boot is about 50 ms).
  it("close() straight after start() of a CLI that boots slower than the grace ends by SIGTERM", async () => {
    const { s, events } = start({ stopGraceMs: 100, bootDelayMs: 600 });
    expect(await s.close()).toBeNull();
    expect(events.filter(isExit)).toEqual([{ kind: "exit", code: null, signal: "SIGTERM" }]);
  });

  it("close() resolves 0 for a slow-booting CLI once it is up", async () => {
    const { s, events, until } = start({ bootDelayMs: 600 });
    s.send("hello");
    await until(isResult);
    expect(await s.close()).toBe(0);
    expect(events.filter(isExit)).toEqual([{ kind: "exit", code: 0, signal: null }]);
  });

  it("close() sends SIGKILL after a second grace to a CLI that ignores SIGTERM", async () => {
    const { s, events, until } = start({ stopGraceMs: 200 });
    s.send("IGNORETERM");
    await until(isResult);
    const t0 = Date.now();
    expect(await s.close()).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);
    expect(events.filter(isExit)).toEqual([{ kind: "exit", code: null, signal: "SIGKILL" }]);
  });

  it("close() sends SIGTERM to a CLI that ignores EOF", async () => {
    const { s, events, until } = start({ stopGraceMs: 300 });
    s.send("HANG");
    await until(isResult);
    const t0 = Date.now();
    expect(await s.close()).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(events.filter(isExit)).toEqual([{ kind: "exit", code: null, signal: "SIGTERM" }]);
  });

  it("a non-JSON stdout line goes into the transcript and parses to nothing", async () => {
    const { s, events, until } = start();
    s.send("NONJSON");
    await until(isResult);
    expect(lines()).toContain("this line is not json");
    expect(kinds(events)).toEqual(["init", "rate-limit", "turn-start", "result"]);
    expect(events.filter((e) => e.kind === "output")).toHaveLength(lines().length);
  });

  it("a rate_limit_event becomes a rate-limit event with resetsAt in ms", async () => {
    const { s, until } = start();
    s.send("RATELIMIT");
    expect(await until((e) => e.kind === "rate-limit")).toEqual({
      kind: "rate-limit",
      status: "rejected",
      resetsAt: 1792310400 * 1000,
    });
  });

  it("stderr is cleaned and cut", async () => {
    const { s, until } = start();
    s.send("STDERR");
    const e = (await until((x) => x.kind === "stderr")) as { text: string };
    expect(e.text.startsWith("fake stderr x")).toBe(true);
    expect(e.text).not.toContain("\x1b");
    expect(e.text.length).toBe(STDERR_TEXT_MAX);
  });

  it("writing to a process that just died does not crash", async () => {
    const { s, events, until } = start();
    s.send("hi");
    await until(isResult);
    process.kill(s.pid as number, "SIGKILL");
    // No await since the kill: the exit cannot have been seen, so this send is to a dead process.
    const aliveAtSend = s.alive;
    s.send("x".repeat(65536));
    expect(aliveAtSend).toBe(true);
    expect(events.some(isExit)).toBe(false);
    // Until the exit is seen the session still looks alive: the writes hit a closed pipe.
    for (let i = 0; i < 50 && s.alive; i++) {
      s.send("x".repeat(65536));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await until(isExit)).toEqual({ kind: "exit", code: null, signal: "SIGKILL" });
  });

  it("an exit is reported even while a grandchild holds the pipes open", async () => {
    const { s, until } = start();
    const t0 = Date.now();
    s.send("ORPHAN");
    expect(await until(isExit)).toEqual({ kind: "exit", code: 0, signal: null });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("an error control response rejects with its message", async () => {
    const { s } = start();
    await expect(s.control("bogus" as ControlSubtype)).rejects.toThrow("unknown subtype bogus");
  });

  it("a transcript that cannot be opened throws before anything is spawned", () => {
    expect(() =>
      startSession({
        command: process.execPath,
        args: [FAKE],
        cwd: dir,
        transcriptPath: join(dir, "missing", "seat.jsonl"),
        ...keeperInput(),
      }),
    ).toThrow(/ENOENT/);
  });

  it("a command that cannot start reports stderr and exit, and close() resolves", async () => {
    const s = startSession({
      command: join(dir, "no-such-claude"),
      args: [],
      cwd: dir,
      transcriptPath: transcript,
      ...keeperInput(),
    });
    sessions.push(s);
    const events: SessionEvent[] = [];
    s.on((e) => events.push(e));
    await s.ready; // the keeper says whether the CLI started
    expect(s.alive).toBe(false);
    expect(await s.close()).toBeNull();
    expect(events.map((e) => e.kind)).toEqual(["stderr", "exit"]);
    expect(() => s.send("hi")).toThrow("session ended");
  });

  it("on() returns an unsubscribe, and a throwing listener does not stop the others", async () => {
    const { s, until } = start();
    const seen: string[] = [];
    s.on(() => {
      throw new Error("broken listener");
    });
    const off = s.on((e) => seen.push(e.kind));
    s.send("one");
    await until(isResult);
    off();
    s.send("two");
    await until(isResult, 2);
    expect(seen.filter((k) => k === "result")).toHaveLength(1);
  });

  it("turn-start: a user line written mid-turn starts a new one", async () => {
    const { s, events, until } = start();
    s.send("SLOW");
    await until((e) => e.kind === "turn-start");
    s.send("more");
    await until(isResult);
    // The fake folds "more" into the SLOW turn, as the real CLI does; the driver counts the
    // activity after the write as a new turn start.
    expect(kinds(events)).toEqual([
      ...["init", "rate-limit", "turn-start", "tool-result", "turn-start", "result"],
    ]);
    expect(parsed().at(-2).message.content[0].text).toBe("echo: SLOW + more");
  });

  it("turn-start: a heartbeat tool_progress is not turn activity, a plain one is", async () => {
    const { s, events, until } = start();
    s.send("PROGRESS");
    await until(isResult);
    const seq = events.map((e) => e.kind);
    // Lines: init, rate_limit_event, heartbeat, progress, assistant, result.
    const outputs = seq.flatMap((k, i) => (k === "output" ? [i] : []));
    expect(seq.indexOf("turn-start")).toBe((outputs[3] as number) + 1);
    expect(kinds(events)).toEqual(["init", "rate-limit", "turn-start", "result"]);
  });

  describe("bounded output", () => {
    const raw = (script: string, extra: Partial<Parameters<typeof startSession>[0]> = {}) => {
      const s = startSession({
        command: process.execPath,
        args: ["-e", script],
        cwd: dir,
        transcriptPath: transcript,
        stopGraceMs: 300,
        ...keeperInput(),
        ...extra,
      });
      sessions.push(s);
      const events: SessionEvent[] = [];
      const done = new Promise<void>((resolve) => {
        s.on((e) => {
          events.push(e);
          if (e.kind === "exit") resolve();
        });
      });
      return { events, done };
    };
    const stderrs = (events: SessionEvent[]) => events.filter((e) => e.kind === "stderr");

    it("drops a stdout line over the cap once, and the next line still lands", async () => {
      const ok = JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "m" });
      const { events, done } = raw(
        `process.stdout.write("x".repeat(100));
         setTimeout(() => process.stdout.write("y".repeat(100)), 50);
         setTimeout(() => process.stdout.write("z\\n" + ${JSON.stringify(ok)} + "\\n"), 100);`,
        { stdoutLineMax: 150 },
      );
      await done;
      expect(lines()).toEqual([ok]);
      expect(stderrs(events)).toEqual([
        { kind: "stderr", text: "a CLI output line over 64 MiB was dropped" },
      ]);
      expect(events.some((e) => e.kind === "init")).toBe(true);
    });

    // The outcomes below hold however the pipe splits the writes into chunks.
    const DROP = { kind: "stderr", text: "a CLI output line over 64 MiB was dropped" };
    const okLine = JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "m" });

    it("drops a complete over-cap line that arrives in one chunk with the next line", async () => {
      const { events, done } = raw(
        `process.stdout.write("x".repeat(200) + "\\n" + ${JSON.stringify(okLine)} + "\\n");`,
        { stdoutLineMax: 150 },
      );
      await done;
      expect(lines()).toEqual([okLine]);
      expect(stderrs(events)).toEqual([DROP]);
      expect(events.some((e) => e.kind === "init")).toBe(true);
    });

    it("keeps a line of exactly the cap and drops one of cap + 1", async () => {
      const { events, done } = raw(
        `process.stdout.write("a".repeat(150) + "\\n" + "b".repeat(151) + "\\n" + ${JSON.stringify(okLine)} + "\\n");`,
        { stdoutLineMax: 150 },
      );
      await done;
      expect(lines()).toEqual(["a".repeat(150), okLine]);
      expect(stderrs(events)).toEqual([DROP]);
    });

    it("keeps a partial line of exactly the cap when its newline comes in a later chunk", async () => {
      const { events, done } = raw(
        `process.stdout.write("a".repeat(150), () => process.stdout.write("\\n"));`,
        { stdoutLineMax: 150 },
      );
      await done;
      expect(lines()).toEqual(["a".repeat(150)]);
      expect(stderrs(events)).toEqual([]);
    });

    it("drops a line whose earlier partial data and newline chunk together pass the cap", async () => {
      const { events, done } = raw(
        `process.stdout.write("p".repeat(100), () => {
           process.stdout.write("q".repeat(60) + "\\n" + ${JSON.stringify(okLine)} + "\\n");
         });`,
        { stdoutLineMax: 150 },
      );
      await done;
      expect(lines()).toEqual([okLine]);
      expect(stderrs(events)).toEqual([DROP]);
    });

    it("trims an over-long stderr line to its last characters", async () => {
      const { events, done } = raw(
        `process.stderr.write("a".repeat(100) + "TAIL\\n"); process.stderr.write("b".repeat(100));`,
        { stderrLineMax: 10 },
      );
      await done;
      expect(stderrs(events)).toEqual([
        { kind: "stderr", text: "aaaaaaTAIL" },
        { kind: "stderr", text: "b".repeat(10) },
      ]);
    });
  });
});
