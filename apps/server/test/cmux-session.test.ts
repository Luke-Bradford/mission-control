import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CMUX_DOWN_TEXT,
  CMUX_REFUSED_TEXT,
  type Cmux,
  CmuxError,
  createCmux,
} from "../src/runtime/cmux.ts";
import {
  attachCmuxSession,
  CMUX_ENDED,
  CMUX_START_FAILED,
  cmuxMessageText,
  envFileText,
  launcherScript,
  startCmuxSession,
} from "../src/runtime/cmux-session.ts";
import type { CrewSession } from "../src/runtime/session.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));

let root: string;
let stateFile: string;
/** What fake-cmux.mjs keeps (see its header); a test reads a field only once the fake has made it. */
interface FakeState {
  workspaces: { id: string; name: string; cwd: string; command: string }[];
  sessions: {
    session_id: string;
    lifecycle: string;
    pid: number;
    workspace_id: string;
    transcript_path: string;
  }[];
  sent: { ws: string; text: string; paste: boolean }[];
  keys: { ws: string; key: string; force: boolean }[];
  closed: string[];
  screens: Record<string, string>;
  calls: string[][];
  down: boolean;
  [k: string]: unknown;
}
const state = (): FakeState => JSON.parse(readFileSync(stateFile, "utf8"));
const patch = (fn: (s: FakeState) => void) => {
  const s = state();
  fn(s);
  writeFileSync(stateFile, JSON.stringify(s));
};
const wait = async (cond: () => boolean, ms = 4000) => {
  for (const t0 = Date.now(); !cond(); ) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const fake = (opts?: Parameters<typeof createCmux>[2]): Cmux =>
  createCmux([process.execPath, FAKE, "--state", stateFile], () => {}, opts);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-cmux-"));
  stateFile = join(root, "state.json");
  writeFileSync(stateFile, JSON.stringify({ transcriptDir: root, autoClaude: true }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("launcherScript", () => {
  it("launcher runs claude by name", () => {
    const text = launcherScript({
      command: "claude",
      args: ["--settings", `{"a":"it's"}`, "--session-id", "abc"],
      env: { PATH: "/x", HOME: "/h", TMPDIR: "/t" },
      nodeDir: "/node/bin",
      envFile: null,
    });
    expect(text).toContain(
      "exec 'claude' '--settings' '{\"a\":\"it'\\''s\"}' '--session-id' 'abc'",
    );
    expect(text).toContain(`export PATH='/node/bin'":$PATH"`);
    expect(text).toContain("export HOME='/h'");
    expect(text).not.toContain("export PATH='/x'");
  });

  it("sources an env file and removes it before the exec", () => {
    const text = launcherScript({
      command: "claude",
      args: [],
      env: {},
      nodeDir: "/n",
      envFile: "/run/env",
    });
    expect(text.indexOf(". '/run/env'")).toBeGreaterThan(-1);
    expect(text.indexOf("rm -f '/run/env'")).toBeGreaterThan(text.indexOf(". '/run/env'"));
    expect(text.indexOf("exec ")).toBeGreaterThan(text.indexOf("rm -f"));
    expect(envFileText({ TOKEN: "a'b", "bad name": "x" })).toBe("export TOKEN='a'\\''b'\n");
  });
});

describe("createCmux", () => {
  it("refuses a cmux that says access denied", async () => {
    patch((s) => {
      s.denied = true;
    });
    await expect(fake().ensure()).rejects.toThrow(CMUX_REFUSED_TEXT);
  });

  it("starts cmux when there is no socket, and fails when it will not come", async () => {
    patch((s) => {
      s.down = true;
    });
    await fake({
      open: [process.execPath, FAKE, "--state", stateFile, "open"],
      startWaitMs: 3000,
    }).ensure();
    expect(state().down).toBe(false);
    patch((s) => {
      s.down = true;
    });
    await expect(fake({ open: ["/usr/bin/true"], startWaitMs: 600 }).ensure()).rejects.toThrow(
      CMUX_DOWN_TEXT,
    );
    await expect(
      fake({ open: ["/usr/bin/true"], startWaitMs: 100 }).ensure(),
    ).rejects.toBeInstanceOf(CmuxError);
  });

  it("closes with force, and without it when cmux has none", async () => {
    const cmux = fake();
    await cmux.close("w1");
    expect(state().closed).toEqual(["w1"]);
    patch((s) => {
      s.noForce = true;
    });
    await cmux.close("w2");
    expect(state().closed).toEqual(["w1", "w2"]);
  });

  it("knows the workspace it made among same-named ones", async () => {
    patch((s) => {
      s.autoClaude = false;
    });
    const cmux = fake();
    const first = await cmux.newWorkspace({ name: "n", cwd: root, command: "x" });
    const second = await cmux.newWorkspace({
      name: "n",
      cwd: root,
      command: "x",
      exclude: new Set([first]),
    });
    expect(second).not.toBe(first);
  });
});

interface Harness {
  session: CrewSession;
  events: SessionEvent[];
  transcript: string;
  workspace: () => string;
  claudeLog: string;
  setLifecycle: (l: string, pid?: number) => void;
  claudeLines: (...lines: unknown[]) => void;
  sessionId: string;
  saved: unknown[];
}

function start(overrides: Partial<Parameters<typeof startCmuxSession>[0]> = {}): Harness {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const launcherDir = join(root, "run");
  // the fake reads the launcher for its session id, so give it the id in the args
  const transcript = join(root, "run.jsonl");
  const saved: unknown[] = [];
  const session = startCmuxSession({
    cmux: fake({ findWaitMs: 2000 }),
    name: "writer-1 · repo#1",
    cwd: root,
    command: "claude",
    args: ["--session-id", sessionId],
    env: { HOME: root },
    dir: launcherDir,
    transcriptPath: transcript,
    cliSessionId: sessionId,
    messageDir: join(root, "messages"),
    nodeDir: "/node/bin",
    save: (v) => saved.push(v),
    pollMs: 20,
    startWaitMs: 3000,
    ...overrides,
  });
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  return {
    session,
    events,
    transcript,
    workspace: () => state().workspaces[0].id,
    claudeLog: join(root, `${sessionId}.jsonl`),
    setLifecycle: (l, pid) =>
      patch((s) => {
        s.sessions[0].lifecycle = l;
        if (pid !== undefined) s.sessions[0].pid = pid;
      }),
    claudeLines: (...lines) =>
      appendFileSync(
        join(root, `${sessionId}.jsonl`),
        `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      ),
    sessionId,
    saved,
  };
}

// the fake's Claude process is the vitest worker: alive for the whole test
const ALIVE = process.pid;

describe("startCmuxSession", () => {
  it("opens a workspace on the cwd with a private launcher and goes ready", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start({ privateEnv: { FLIGHT_TOKEN: "secret" } });
    await h.session.ready;
    const ws = state().workspaces[0];
    expect(ws.name).toBe("writer-1 · repo#1");
    expect(ws.cwd).toBe(root);
    expect(statSync(join(root, "run", "launch.zsh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "run", "env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "run", "launch.zsh"), "utf8")).toContain(
      "exec 'claude' '--session-id'",
    );
    expect(h.session.pid).toBe(ALIVE);
    expect(h.saved).toEqual([
      { workspace: ws.id, pid: null },
      { workspace: ws.id, pid: ALIVE },
    ]);
    await h.session.close();
  });

  it("answers the folder-trust prompt", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.autoClaude = false;
    });
    const h = start();
    await wait(() => state().workspaces?.length === 1);
    patch((s) => {
      s.screens = {
        [s.workspaces[0].id]: "Do you trust the files in this folder?\n 1. Yes, proceed",
      };
    });
    await wait(() => (state().keys ?? []).length > 0);
    expect(state().keys[0]).toMatchObject({ key: "enter", force: false });
    await h.session.close();
  });

  it("ends with a reason when Claude never shows", async () => {
    patch((s) => {
      s.autoClaude = false;
    });
    const h = start({ startWaitMs: 150 });
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(state().closed).toHaveLength(1);
    const exit = h.events.find((e) => e.kind === "exit");
    expect(exit).toMatchObject({ reason: CMUX_START_FAILED });
    expect(h.session.alive).toBe(false);
    expect(() => h.session.send("late")).toThrow("session ended");
  });

  it("sends a one-line message as it is and a long one through a file", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    h.session.send("hello there");
    h.session.send("line one\nline two");
    await wait(() => (state().sent ?? []).length === 2);
    const sent = state().sent;
    expect(sent[0]).toMatchObject({ text: "hello there", paste: true });
    const file = join(root, "messages", "1.md");
    expect(sent[1].text).toBe(cmuxMessageText(file));
    expect(readFileSync(file, "utf8")).toBe("line one\nline two");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await wait(
      () => (state().keys ?? []).filter((k: { key: string }) => k.key === "enter").length === 2,
    );
    await h.session.close();
  });

  it("holds a message while a dialog is open, and never forces it", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.busy = true;
    });
    const h = start();
    await h.session.ready;
    h.session.send("wait for me");
    await new Promise((r) => setTimeout(r, 300));
    expect(state().sent ?? []).toEqual([]);
    expect(JSON.stringify(state().calls)).not.toContain('--force","--');
    patch((s) => {
      s.busy = false;
    });
    await wait(() => (state().sent ?? []).length === 1, 6000);
    await h.session.close();
  });

  it("follows cmux's state: turn start, needs input, result; and copies the transcript", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("running");
    h.claudeLines(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "abcd" }] },
      },
    );
    await wait(() => h.events.some((e) => e.kind === "tool-result"));
    await wait(() => h.events.some((e) => e.kind === "turn-start"));
    expect(h.events.find((e) => e.kind === "tool-result")).toMatchObject({
      toolUseId: "t1",
      bytes: 4,
    });
    h.setLifecycle("needsInput");
    await wait(() => h.events.some((e) => e.kind === "needs-input"));
    h.setLifecycle("idle");
    await wait(() => h.events.some((e) => e.kind === "result"));
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({ isError: false });
    const lines = readFileSync(h.transcript, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] as string)).toMatchObject({ type: "result", mc_cmux: true });
    expect(h.session.lines).toBe(3);
    expect(statSync(h.transcript).mode & 0o777).toBe(0o600);
    await h.session.close();
  });

  it("an operator's /clear keeps the run: a new session id is an init, not an exit", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    const fresh = "22222222-2222-4222-8222-222222222222";
    patch((s) => {
      s.sessions[0].session_id = fresh;
      s.sessions[0].transcript_path = join(root, "fresh.jsonl");
    });
    writeFileSync(
      join(root, "fresh.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: "x" } })}\n`,
    );
    await wait(() => h.events.some((e) => e.kind === "init"));
    expect(h.events.find((e) => e.kind === "init")).toMatchObject({ sessionId: fresh });
    await wait(() => h.session.lines === 1);
    expect(h.session.alive).toBe(true);
    expect(h.events.some((e) => e.kind === "exit")).toBe(false);
    await h.session.close();
  });

  it("a restored agent with a new pid is closed and asked to be retaken", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("idle", ALIVE + 1);
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toMatchObject({ retake: true });
    expect(state().closed).toHaveLength(1);
    expect(h.saved.at(-1)).toBeNull();
  });

  it("ends when the Claude process is gone", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("idle", 2 ** 22 + 12345);
    // a pid that is not ours and not alive: cmux's record changed, the process is not there
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toBeDefined();
    patch((s) => {
      s.sessions = [];
    });
  });

  it("ends when the record is gone", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    patch((s) => {
      s.sessions = [];
    });
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toMatchObject({
      reason: CMUX_ENDED,
      code: null,
    });
    // nothing of the workspace is left saved or open
    expect(h.saved.at(-1)).toBeNull();
    expect(state().closed).toHaveLength(1);
  });

  it("an operator closing the workspace leaves no saved workspace either", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    patch((s) => {
      s.workspaces = [];
      s.sessions = [];
    });
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.saved.at(-1)).toBeNull();
  });

  it("interrupts with escape, forced, and refuses what only print mode has", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    let done = false;
    await h.session.control("interrupt", { onSuccess: () => (done = true) });
    expect(done).toBe(true);
    expect(state().keys.at(-1)).toMatchObject({ key: "escape", force: true });
    await expect(h.session.control("get_usage")).rejects.toMatchObject({
      kind: "refused",
      message: "not available in cmux",
    });
    await h.session.close();
    await expect(h.session.control("interrupt")).rejects.toMatchObject({ kind: "ended" });
  });

  it("close closes the workspace, forgets it and emits an exit", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    const ws = state().workspaces[0].id;
    await expect(h.session.close()).resolves.toBeNull();
    expect(state().closed).toEqual([ws]);
    expect(h.saved.at(-1)).toBeNull();
    expect(h.events.filter((e) => e.kind === "exit")).toHaveLength(1);
  });

  it("a failed start is an exit with cmux's words", async () => {
    patch((s) => {
      s.denied = true;
    });
    const h = start();
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toMatchObject({
      reason: CMUX_REFUSED_TEXT,
    });
  });
});

/** What a restart's hub does: the run transcript so far, the saved source cursor, and a new attach. */
async function restartAfter(h: Harness, more: unknown[], run: string) {
  const saved = h.saved.at(-1) as {
    workspace: string;
    pid: number;
    source?: { path: string; lines: number };
  };
  h.session.detach();
  h.claudeLines(...more);
  const session = attachCmuxSession({
    cmux: fake(),
    name: "w",
    cwd: root,
    command: "claude",
    args: [],
    env: {},
    dir: join(root, "run"),
    transcriptPath: run,
    cliSessionId: h.sessionId,
    messageDir: join(root, "m"),
    workspace: saved.workspace,
    pid: saved.pid,
    source: saved.source ?? null,
    pollMs: 20,
  });
  const events: SessionEvent[] = [];
  session.on((e) => events.push(e));
  await wait(() => events.some((e) => e.kind === "attached"));
  session.detach();
}

describe("a restart reads Claude's transcript from where it left off", () => {
  it("after a completed turn, the result the hub made is not counted: the first new line is copied once", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("running");
    h.claudeLines({ type: "assistant", t: "a" }, { type: "assistant", t: "b" });
    await wait(() => h.events.some((e) => e.kind === "turn-start") && h.session.lines === 2);
    h.setLifecycle("idle");
    await wait(() => h.events.some((e) => e.kind === "result"));
    await restartAfter(h, [{ type: "assistant", t: "new" }], h.transcript);
    const copied = readFileSync(h.transcript, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(copied.map((l) => l.t ?? l.type)).toEqual(["a", "b", "result", "new"]);
  });

  it("after /clear, the old session's count does not skip the new transcript", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    h.claudeLines(
      { type: "assistant", t: "a" },
      { type: "assistant", t: "b" },
      { type: "assistant", t: "c" },
    );
    await wait(() => h.session.lines === 3);
    const fresh = "44444444-4444-4444-8444-444444444444";
    const freshFile = join(root, "fresh.jsonl");
    writeFileSync(freshFile, `${JSON.stringify({ type: "user", t: "x" })}\n`);
    patch((s) => {
      s.sessions[0].session_id = fresh;
      s.sessions[0].transcript_path = freshFile;
    });
    await wait(() => h.session.lines === 4);
    appendFileSync(freshFile, `${JSON.stringify({ type: "assistant", t: "y" })}\n`);
    await wait(() => h.session.lines === 5);
    appendFileSync(freshFile, `${JSON.stringify({ type: "assistant", t: "new" })}\n`);
    const h2 = { ...h, sessionId: fresh, claudeLines: () => {} } as Harness;
    await restartAfter(h2, [], h.transcript);
    const copied = readFileSync(h.transcript, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(copied.map((l) => l.t)).toEqual(["a", "b", "c", "x", "y", "new"]);
  });
});

describe("attachCmuxSession", () => {
  it("takes up a running workspace: skips the lines it has, says attached with the turn state", async () => {
    const transcriptPath = join(root, "claude.jsonl");
    const lines = ["a", "b", "c"].map((t) => JSON.stringify({ type: "assistant", t }));
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
    const run = join(root, "run.jsonl");
    writeFileSync(run, `${lines.slice(0, 2).join("\n")}\n`);
    patch((s) => {
      s.sessions = [
        {
          session_id: "sid",
          lifecycle: "running",
          pid: ALIVE,
          workspace_id: "ws-1",
          transcript_path: transcriptPath,
        },
      ];
    });
    const session = attachCmuxSession({
      cmux: fake(),
      name: "w",
      cwd: root,
      command: "claude",
      args: [],
      env: {},
      dir: join(root, "run"),
      transcriptPath: run,
      cliSessionId: "sid",
      messageDir: join(root, "m"),
      workspace: "ws-1",
      pid: ALIVE,
      source: { path: transcriptPath, lines: 2 },
      pollMs: 20,
    });
    const events: SessionEvent[] = [];
    session.on((e) => events.push(e));
    await wait(() => events.some((e) => e.kind === "attached"));
    expect(events.find((e) => e.kind === "attached")).toEqual({ kind: "attached", awaiting: true });
    expect(readFileSync(run, "utf8").trim().split("\n")).toHaveLength(3);
    expect(session.lines).toBe(3);
    session.detach();
  });
});
