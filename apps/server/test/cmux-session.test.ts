import { spawn } from "node:child_process";
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
  CMUX_PID_FILE,
  CMUX_QUIT_EARLY,
  CMUX_START_FAILED,
  CMUX_TRUST_QUIT,
  cmuxMessageText,
  envFileText,
  isPermissionPrompt,
  launcherScript,
  startCmuxSession,
  trustMenu,
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
// generous: a loaded CI runner takes far longer to spawn each fake cmux call (the test timeout is 15 s)
const wait = async (cond: () => boolean, ms = 12_000) => {
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

/** A pid that has ended: a child that exited at once. */
const deadPid = () =>
  new Promise<number>((resolve) => {
    const c = spawn(process.execPath, ["-e", ""]);
    c.on("exit", () => resolve(c.pid as number));
  });

/** Claude's folder-trust prompt as cmux reads it, with the cursor on the option named. */
const trustScreen = (cursor: "no" | "yes") =>
  [
    "────────────────────────────────────────────────────────────",
    " Accessing workspace:",
    "",
    " /Users/someone/Dev/mc-crew/worktrees/mission-control/writer-1-2194",
    "",
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
    " well-known open source project, or work from your team). If not, take a moment to review",
    " what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    `${cursor === "no" ? " ❯" : "  "} 1. No, exit`,
    `${cursor === "yes" ? " ❯" : "  "} 2. Yes, I trust this folder`,
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

describe("trustMenu", () => {
  it("knows where the cursor is on the trust prompt's menu", () => {
    expect(trustMenu(trustScreen("no"))).toEqual({ onYes: false });
    expect(trustMenu(trustScreen("yes"))).toEqual({ onYes: true });
    expect(trustMenu("$ ls\nfile")).toBeNull();
    // the prompt's words with no live menu under them
    expect(trustMenu(" Quick safety check: Is this a project you trust?\n%")).toBeNull();
  });

  it("the launcher writes its pid, which its exec makes Claude's", () => {
    const text = launcherScript({
      command: "claude",
      args: [],
      env: {},
      nodeDir: "/n",
      envFile: null,
      pidFile: "/run/claude.pid",
    });
    expect(text).toContain("echo $$ > '/run/claude.pid'");
    expect(text.indexOf("exec ")).toBeGreaterThan(text.indexOf("echo $$"));
  });
});

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

  it("answers the folder-trust prompt: the cursor moved to Yes, and Enter only there", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.autoClaude = false;
      s.screen = trustScreen("no");
    });
    const h = start();
    // the launcher's pid: Claude, at its prompt
    writeFileSync(join(root, "run", CMUX_PID_FILE), `${ALIVE}\n`);
    await wait(() => (state().keys ?? []).length > 0);
    expect(state().keys[0]).toMatchObject({ key: "down", force: false });
    // the cursor still shows on "No, exit": no Enter
    await new Promise((r) => setTimeout(r, 200));
    expect(state().keys.some((k) => k.key === "enter")).toBe(false);
    patch((s) => {
      s.screen = trustScreen("yes");
    });
    await wait(() => state().keys.some((k) => k.key === "enter"));
    const enter = state().keys.findIndex((k) => k.key === "enter");
    expect(state().keys.slice(0, enter).every((k) => k.key === "down")).toBe(true);
    await h.session.close();
  });

  it("sends no key once Claude has quit at the trust prompt, and fails the start", async () => {
    patch((s) => {
      s.autoClaude = false;
      s.screen = `${trustScreen("no")}\nClaude Code didn't start because this folder isn't trusted.\n%`;
    });
    const h = start();
    writeFileSync(join(root, "run", CMUX_PID_FILE), `${await deadPid()}\n`);
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toMatchObject({ reason: CMUX_TRUST_QUIT });
    expect(state().closed).toHaveLength(1);
    expect(state().keys ?? []).toEqual([]);
    expect(h.session.alive).toBe(false);
  });

  it("fails the start when Claude's process is gone before its record", async () => {
    patch((s) => {
      s.autoClaude = false;
    });
    const h = start();
    writeFileSync(join(root, "run", CMUX_PID_FILE), `${await deadPid()}\n`);
    await wait(() => h.events.some((e) => e.kind === "exit"));
    expect(h.events.find((e) => e.kind === "exit")).toMatchObject({ reason: CMUX_QUIT_EARLY });
    expect(state().keys ?? []).toEqual([]);
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
    await wait(() => (state().sent ?? []).length === 1);
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

  it("refuses a tool permission prompt itself, so the seat never waits on a person for one", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.screen =
        "Bash command\n  rm -rf x\nDo you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)";
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("running");
    await wait(() => h.events.some((e) => e.kind === "turn-start"));
    h.setLifecycle("needsInput");
    await wait(() => (state().keys ?? []).some((k) => k.key === "escape"));
    expect(state().keys.find((k) => k.key === "escape")).toMatchObject({ force: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.events.some((e) => e.kind === "needs-input")).toBe(false);
    await h.session.close();
  });

  it("refuses a permission dialog whose question and refusal wrap over lines", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.screen =
        " Edit file\n\n Do you want to make this edit to\n /very/long/path/to/some/deeply/nested/file\n .ts?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session\n   3. No, and tell Claude what to do\n   differently (esc)";
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("needsInput");
    await wait(() => (state().keys ?? []).some((k) => k.key === "escape"));
    expect(state().keys.find((k) => k.key === "escape")).toMatchObject({ force: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.events.some((e) => e.kind === "needs-input")).toBe(false);
    await h.session.close();
  });

  it("looks again on every waiting poll: a dialog that becomes a permission prompt is refused", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.screen = "Thinking…";
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("needsInput");
    await wait(() => h.events.some((e) => e.kind === "needs-input"));
    patch((s) => {
      s.screen =
        " Bash command\n   ls\n Do you want to proceed?\n ❯ 1. Yes\n   3. No, and tell Claude what to do differently (esc)";
    });
    await wait(() => (state().keys ?? []).some((k) => k.key === "escape"));
    await h.session.close();
  });

  it("leaves a plain question that starts 'Do you want to proceed' to the operator", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.screen = "Do you want to proceed with the migration now?\n❯ 1. Yes, migrate\n  2. No, wait";
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("needsInput");
    await wait(() => h.events.some((e) => e.kind === "needs-input"));
    expect((state().keys ?? []).some((k) => k.key === "escape")).toBe(false);
    await h.session.close();
  });

  it("knows Claude's permission dialog by its fixed options, not by its question alone", () => {
    const dialog =
      " Bash command\n\n   rm -rf build\n   Remove the build folder\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm commands in /w\n   3. No, and tell Claude what to do differently (esc)";
    expect(isPermissionPrompt(dialog)).toBe(true);
    expect(isPermissionPrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toBe(false);
    expect(isPermissionPrompt("Do you want to proceed with the plan?")).toBe(false);
    expect(
      isPermissionPrompt(
        " Bash command\n Do you want to\n proceed?\n ❯ 1. Yes\n   3. No, and tell Claude\n   what to do differently (esc)",
      ),
    ).toBe(true);
  });

  it("leaves any other dialog to the operator", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
      s.screen = "Which approach do you want?\n❯ 1. A\n  2. B";
    });
    const h = start();
    await h.session.ready;
    h.setLifecycle("needsInput");
    await wait(() => h.events.some((e) => e.kind === "needs-input"));
    expect((state().keys ?? []).some((k) => k.key === "escape")).toBe(false);
    await h.session.close();
  });

  it("answers the context use from Claude's last top-level reply", async () => {
    patch((s) => {
      s.claudePid = ALIVE;
    });
    const h = start();
    await h.session.ready;
    await expect(h.session.control("get_context_usage")).rejects.toMatchObject({ kind: "refused" });
    const usage = (input: number, sidechain = false) => ({
      type: "assistant",
      ...(sidechain ? { isSidechain: true } : {}),
      message: {
        usage: {
          input_tokens: input,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 10,
        },
      },
    });
    h.claudeLines(usage(5), usage(99_999, true));
    await wait(() => h.session.lines === 2);
    await expect(h.session.control("get_context_usage")).resolves.toMatchObject({
      totalTokens: 115,
    });
    await h.session.close();
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

it("a session started with a saved source does not copy what the hub already has", async () => {
  patch((s) => {
    s.claudePid = ALIVE;
  });
  const sid = "11111111-1111-4111-8111-111111111111";
  const file = join(root, `${sid}.jsonl`);
  const old = ["1", "2"].map((t) => JSON.stringify({ type: "assistant", t }));
  writeFileSync(file, `${old.join("\n")}\n`);
  const run = join(root, "run.jsonl");
  writeFileSync(run, `${old.join("\n")}\n`);
  const h = start({ source: { path: file, lines: 2 } });
  await h.session.ready;
  appendFileSync(file, `${JSON.stringify({ type: "assistant", t: "3" })}\n`);
  await wait(() => readFileSync(run, "utf8").includes('"3"'));
  const copied = readFileSync(run, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(copied.map((l) => l.t)).toEqual(["1", "2", "3"]);
  await h.session.close();
});

it("after /clear to a transcript with as many lines as the old one, the fresh line is copied once", async () => {
  patch((s) => {
    s.claudePid = ALIVE;
  });
  const h = start();
  await h.session.ready;
  h.claudeLines({ type: "assistant", t: "old" });
  await wait(() => h.session.lines === 1);
  const freshFile = join(root, "fresh2.jsonl");
  writeFileSync(freshFile, `${JSON.stringify({ type: "user", t: "fresh" })}\n`);
  patch((s) => {
    s.sessions[0].session_id = "55555555-5555-4555-8555-555555555555";
    s.sessions[0].transcript_path = freshFile;
  });
  await wait(() => h.session.lines === 2);
  await new Promise((r) => setTimeout(r, 100));
  const h2 = {
    ...h,
    sessionId: "55555555-5555-4555-8555-555555555555",
    claudeLines: () => {},
  } as Harness;
  await restartAfter(h2, [], h.transcript);
  const copied = readFileSync(h.transcript, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(copied.map((l) => l.t)).toEqual(["old", "fresh"]);
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
