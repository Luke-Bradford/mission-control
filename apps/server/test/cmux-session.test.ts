import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@mc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CMUX_DOWN_TEXT, type Cmux } from "../src/runtime/cmux.ts";
import {
  attachCmuxSession,
  launcherScript,
  startCmuxSession,
} from "../src/runtime/cmux-session.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cmux launcher", () => {
  it("runs claude by name and sources then removes private environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
    dirs.push(dir);
    const envFile = join(dir, "env");
    const script = launcherScript({
      command: "claude",
      args: ["--settings", "/private/settings.json"],
      env: { PATH: "/operator/path", LANG: "en_GB.UTF-8" },
      nodeDir: "/node/bin",
      envFile,
    });
    expect(script).toContain("'claude' '--settings' '/private/settings.json'");
    expect(script).toContain("$PATH");
    expect(script).toContain(`source '${envFile}'`);
    expect(script).toContain(`rm -f '${envFile}'`);
  });

  // the launcher is a zsh script for a Mac; a runner without zsh cannot run it
  it.skipIf(!existsSync("/bin/zsh"))(
    "starts the CLI from a clean environment that keeps cmux's variables",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
      dirs.push(dir);
      const envFile = join(dir, "env");
      writeFileSync(envFile, "export PRIVATE_KEY='secret'\n");
      const file = join(dir, "launch.zsh");
      writeFileSync(
        file,
        launcherScript({
          command: "env",
          args: [],
          env: { PATH: "/operator/path", LANG: "en_GB.UTF-8", HOME: "/seat/home" },
          privateKeys: ["PRIVATE_KEY"],
          nodeDir: "/usr/bin",
          envFile,
        }),
        { mode: 0o700 },
      );
      const out = spawnSync("/bin/zsh", [file], {
        encoding: "utf8",
        env: {
          PATH: "/usr/bin:/bin",
          GH_TOKEN: "x",
          ANTHROPIC_API_KEY: "y",
          CMUX_SOCKET_PATH: "/s",
          TERM: "xterm",
        },
      }).stdout;
      expect(out).toContain("CMUX_SOCKET_PATH=/s");
      expect(out).toContain("TERM=xterm");
      expect(out).toContain("LANG=en_GB.UTF-8");
      expect(out).toContain("HOME=/seat/home");
      expect(out).toContain("PRIVATE_KEY=secret");
      expect(out).toContain("PATH=/usr/bin:/usr/bin:/bin");
      expect(out).not.toContain("GH_TOKEN");
      expect(out).not.toContain("ANTHROPIC_API_KEY");
      expect(existsSync(envFile)).toBe(false);
    },
  );

  it("copies the cmux transcript and follows a running, waiting and idle seat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
    dirs.push(dir);
    const source = join(dir, "claude.jsonl");
    const target = join(dir, "run.jsonl");
    let lifecycle: "idle" | "running" | "needsInput" = "running";
    const cmux: Cmux = {
      ensure: async () => {},
      newWorkspace: async () => "workspace-1",
      agents: async () => [
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          pid: 42,
          lifecycle,
          transcriptPath: source,
        },
      ],
      send: async () => "sent",
      sendKey: async () => {},
      readScreen: async () => "",
      close: async () => {},
    };
    appendFileSync(
      source,
      '{"type":"system","subtype":"init","session_id":"session-1","model":"sonnet"}\n',
    );
    const session = startCmuxSession({
      cmux,
      name: "GUIDO · mc#2194",
      cwd: dir,
      command: "claude",
      args: [],
      env: {},
      dir: join(dir, "run"),
      transcriptPath: target,
      cliSessionId: "session-1",
      messageDir: join(dir, "messages"),
      pollMs: 5,
    });
    const seen: string[] = [];
    session.on((event) => seen.push(event.kind));
    await session.ready;
    lifecycle = "needsInput";
    await new Promise((resolve) => setTimeout(resolve, 15));
    lifecycle = "idle";
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(seen).toContain("needs-input");
    expect(seen).toContain("result");
    expect(readFileSync(target, "utf8")).toContain('"mc_cmux":true');
    await session.close();
  });
});

it("keeps the workspace open across /clear and delivers multi-line messages by file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  const first = join(dir, "first.jsonl");
  const second = join(dir, "second.jsonl");
  const target = join(dir, "run.jsonl");
  appendFileSync(first, '{"type":"system","subtype":"init","session_id":"one"}\n');
  appendFileSync(second, '{"type":"system","subtype":"init","session_id":"two"}\n');
  let record = {
    workspaceId: "workspace-1",
    sessionId: "one",
    pid: 42,
    lifecycle: "running" as const,
    transcriptPath: first,
  };
  const sent: string[] = [];
  const keys: string[] = [];
  const cmux: Cmux = {
    ensure: async () => {},
    newWorkspace: async () => "workspace-1",
    agents: async () => [record],
    send: async (_workspace, text) => {
      sent.push(text);
      return "sent";
    },
    sendKey: async (_workspace, key) => {
      keys.push(key);
    },
    readScreen: async () => "",
    close: async () => {},
  };
  const session = startCmuxSession({
    cmux,
    name: "GUIDO · mc#2194",
    cwd: dir,
    command: "claude",
    args: [],
    env: {},
    dir: join(dir, "run"),
    transcriptPath: target,
    cliSessionId: "one",
    messageDir: join(dir, "messages"),
    pollMs: 5,
  });
  const inits: string[] = [];
  session.on((event) => {
    if (event.kind === "init") inits.push(event.sessionId);
  });
  session.send("first line\nsecond line");
  await session.ready;
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatch(/^Mission Control sent you a message\. Read .+ and act on it\.$/);
  const message = sent[0]?.match(/Read (.+) and act/)?.[1];
  expect(message).toBeDefined();
  expect(readFileSync(message as string, "utf8")).toBe("first line\nsecond line");
  expect(keys).toContain("enter");

  record = { ...record, sessionId: "two", transcriptPath: second };
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(inits).toContain("two");
  expect(readFileSync(target, "utf8")).toContain('"session_id":"two"');
  expect(existsSync(message as string)).toBe(true);
  await session.close();
});

it("waits for Claude to register, baselines idle, and keeps its source cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  const source = join(dir, "claude.jsonl");
  const target = join(dir, "run.jsonl");
  appendFileSync(source, '{"n":1}\n');
  const record = {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    pid: 42,
    lifecycle: "idle" as "idle" | "running",
    transcriptPath: source,
  };
  const started = Date.now();
  const exits: string[] = [];
  let screens = 0;
  const keys: string[] = [];
  const cmux: Cmux = {
    ensure: async () => {},
    newWorkspace: async () => "workspace-1",
    agents: async () => (Date.now() - started < 250 ? [] : [record]),
    send: async () => "sent",
    sendKey: async (_workspace, key) => {
      keys.push(key);
    },
    readScreen: async () => (++screens >= 3 ? "Trust this folder?" : ""),
    close: async () => {},
  };
  const session = startCmuxSession({
    cmux,
    name: "GUIDO · mc#2194",
    cwd: dir,
    command: "claude",
    args: [],
    env: {},
    dir: join(dir, "run"),
    transcriptPath: target,
    cliSessionId: "session-1",
    messageDir: join(dir, "messages"),
    pollMs: 5,
  });
  const seen: string[] = [];
  session.on((event) => {
    seen.push(event.kind);
    if (event.kind === "exit") exits.push(event.reason ?? "");
  });
  await session.ready;
  expect(seen).not.toContain("result");
  record.lifecycle = "running";
  await new Promise((resolve) => setTimeout(resolve, 15));
  record.lifecycle = "idle";
  appendFileSync(source, '{"n":2}\n{"n":3}\n');
  await vi.waitFor(() => expect(seen.filter((kind) => kind === "result")).toHaveLength(1));
  expect(readFileSync(target, "utf8")).toContain('{"n":2}');
  expect(readFileSync(target, "utf8")).toContain('{"n":3}');
  expect(exits).toEqual([]);
  expect(keys).toContain("enter");
  await session.close();
});

it("queues messages until Claude is ready and preserves their order after busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  let available = false;
  let first = true;
  const sent: string[] = [];
  const cmux: Cmux = {
    ensure: async () => {},
    newWorkspace: async () => "workspace-1",
    agents: async () =>
      available
        ? [
            {
              workspaceId: "workspace-1",
              sessionId: "session-1",
              pid: 42,
              lifecycle: "idle",
              transcriptPath: null,
            },
          ]
        : [],
    send: async (_workspace, text) => {
      if (first) {
        first = false;
        return "busy";
      }
      sent.push(text);
      return "sent";
    },
    sendKey: async () => {},
    readScreen: async () => "",
    close: async () => {},
  };
  const session = startCmuxSession({
    cmux,
    name: "GUIDO · mc#2194",
    cwd: dir,
    command: "claude",
    args: [],
    env: {},
    dir: join(dir, "run"),
    transcriptPath: join(dir, "run.jsonl"),
    cliSessionId: "session-1",
    messageDir: join(dir, "messages"),
    pollMs: 5,
  });
  session.send("first");
  session.send("second");
  expect(sent).toEqual([]);
  available = true;
  await vi.waitFor(() => expect(sent).toEqual(["first", "second"]), { timeout: 3000 });
  await session.close();
});

const stubCmux = (over: Partial<Cmux>): Cmux => ({
  ensure: async () => {},
  newWorkspace: async () => "workspace-1",
  agents: async () => [
    {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      pid: 42,
      lifecycle: "idle",
      transcriptPath: null,
    },
  ],
  send: async () => "sent",
  sendKey: async () => {},
  readScreen: async () => "",
  close: async () => {},
  ...over,
});
const stubSession = (dir: string, cmux: Cmux) =>
  startCmuxSession({
    cmux,
    name: "GUIDO · mc#2194",
    cwd: dir,
    command: "claude",
    args: [],
    env: {},
    dir: join(dir, "run"),
    transcriptPath: join(dir, "run.jsonl"),
    cliSessionId: "session-1",
    messageDir: join(dir, "messages"),
    pollMs: 5,
  });

it("retries a send error so the first message still arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  const sent: string[] = [];
  let failed = false;
  const session = stubSession(
    dir,
    stubCmux({
      send: async (_workspace, text) => {
        if (!failed) {
          failed = true;
          throw new Error("socket hiccup");
        }
        sent.push(text);
        return "sent";
      },
    }),
  );
  session.send("first");
  session.send("second");
  await vi.waitFor(() => expect(sent).toEqual(["first", "second"]), { timeout: 3000 });
  expect(session.alive).toBe(true);
  await session.close();
});

it("ends the session for recovery when a message cannot be delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  const closed: string[] = [];
  const session = stubSession(
    dir,
    stubCmux({
      send: async () => {
        throw new Error("socket gone");
      },
      close: async (workspace) => {
        closed.push(workspace);
      },
    }),
  );
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  session.send("first");
  await vi.waitFor(() => expect(session.alive).toBe(false), { timeout: 3000 });
  expect(closed).toEqual(["workspace-1"]);
  expect(events).toContainEqual(expect.objectContaining({ kind: "exit", retake: true }));
});

it("ends a registered seat whose cmux stops answering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  let calls = 0;
  const session = stubSession(
    dir,
    stubCmux({
      agents: async () => {
        if (++calls === 1)
          return [
            {
              workspaceId: "workspace-1",
              sessionId: "session-1",
              pid: 42,
              lifecycle: "running",
              transcriptPath: null,
            },
          ];
        throw new Error("socket gone");
      },
    }),
  );
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  await vi.waitFor(() => expect(session.alive).toBe(false), { timeout: 3000 });
  expect(events).toContainEqual(expect.objectContaining({ kind: "exit", retake: true }));
});

it("attaches an idle workspace as idle without a synthetic result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
  dirs.push(dir);
  const cmux: Cmux = {
    ensure: async () => {},
    newWorkspace: async () => "workspace-1",
    agents: async () => [
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        pid: 42,
        lifecycle: "idle",
        transcriptPath: null,
      },
    ],
    send: async () => "sent",
    sendKey: async () => {},
    readScreen: async () => "",
    close: async () => {},
  };
  const session = attachCmuxSession({
    cmux,
    workspace: "workspace-1",
    pid: 42,
    awaiting: false,
    savedState: "idle",
    from: 0,
    name: "GUIDO · mc#2194",
    cwd: dir,
    command: "claude",
    args: [],
    env: {},
    dir: join(dir, "run"),
    transcriptPath: join(dir, "run.jsonl"),
    cliSessionId: "session-1",
    messageDir: join(dir, "messages"),
    pollMs: 5,
  });
  const events: string[] = [];
  session.on((event) => events.push(event.kind));
  await session.ready;
  expect(events).toContain("attached");
  expect(events).not.toContain("result");
  await session.close();
});

describe("reconciling a saved seat state at attach", () => {
  const attachWith = async (saved: string, lifecycle: "idle" | "running" | "needsInput") => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
    dirs.push(dir);
    const cmux: Cmux = {
      ensure: async () => {},
      newWorkspace: async () => "workspace-1",
      agents: async () => [
        {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          pid: 42,
          lifecycle,
          transcriptPath: null,
        },
      ],
      send: async () => "sent",
      sendKey: async () => {},
      readScreen: async () => "",
      close: async () => {},
    };
    const session = attachCmuxSession({
      cmux,
      workspace: "workspace-1",
      pid: 42,
      awaiting: saved !== "idle",
      savedState: saved,
      from: 0,
      name: "GUIDO · mc#2194",
      cwd: dir,
      command: "claude",
      args: [],
      env: {},
      dir: join(dir, "run"),
      transcriptPath: join(dir, "run.jsonl"),
      cliSessionId: "session-1",
      messageDir: join(dir, "messages"),
      pollMs: 5,
    });
    const events: string[] = [];
    session.on((event) => events.push(event.kind));
    await session.ready;
    await session.close();
    return events;
  };

  it("starts a turn when a saved waiting seat is already running", async () => {
    expect(await attachWith("needs-input", "running")).toContain("turn-start");
  });

  it("starts a turn when a saved idle seat is already running", async () => {
    expect(await attachWith("idle", "running")).toContain("turn-start");
  });

  it("does not repeat the turn of a saved running seat", async () => {
    expect(await attachWith("running", "running")).not.toContain("turn-start");
  });
});

describe("cmux start failure", () => {
  it("keeps the setup text on the dead session so the start can refuse with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-session-"));
    dirs.push(dir);
    const cmux: Cmux = {
      ensure: async () => {
        throw new Error(CMUX_DOWN_TEXT);
      },
      newWorkspace: async () => "workspace-1",
      agents: async () => [],
      send: async () => "sent",
      sendKey: async () => {},
      readScreen: async () => "",
      close: async () => {},
    };
    const session = startCmuxSession({
      cmux,
      name: "n",
      cwd: dir,
      command: "claude",
      args: [],
      env: {},
      dir: join(dir, "run"),
      transcriptPath: join(dir, "run.jsonl"),
      cliSessionId: "s",
      messageDir: join(dir, "m"),
    });
    await session.ready;
    expect(session.alive).toBe(false);
    expect(session.failure).toBe(CMUX_DOWN_TEXT);
  });
});
