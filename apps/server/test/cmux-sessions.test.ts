import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CMUX_REFUSED_TEXT } from "../src/runtime/cmux.ts";
import {
  CMUX_NOT_RUNNING_TEXT,
  CMUX_SLOW_TEXT,
  createSessions,
  lastAssistantText,
  lastScreenLine,
  repoOf,
  type SessionsDeps,
} from "../src/sessions/sessions.ts";
import { Store } from "../src/store.ts";
import { commandOf, type FakeState, fakeCmux } from "./fake-cmux-harness.ts";

const PRICING = "11111111-1111-4111-8111-111111111111";
const GUIDO = "22222222-2222-4222-8222-222222222222";
const SHELL = "33333333-3333-4333-8333-333333333333";

let dir: string;
let store: Store;
let projects: string;
let nowMs: number;

const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-sessions-"));
  store = new Store(join(dir, "mc.sqlite"));
  projects = join(dir, "projects");
  mkdirSync(join(projects, "p"), { recursive: true });
  nowMs = 1_800_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(state: FakeState, over: Partial<SessionsDeps> = {}) {
  const fake = fakeCmux(dir, state);
  const sessions = createSessions({
    cmux: fake.cmux,
    store,
    seatIds: () => ["GUIDO-1", "flight-1"],
    projectsDir: projects,
    alive: () => true,
    probe: async () => true,
    now: () => nowMs,
    ...over,
  });
  return { fake, sessions };
}

/** Three workspaces: a working Claude, one waiting on a question, and a plain shell. */
function threeSessions(): FakeState {
  const transcript = join(projects, "p", "s1.jsonl");
  writeFileSync(transcript, `${assistant("Looking at it")}\n${assistant("Tests pass")}\n`);
  return {
    workspaces: [
      { id: PRICING, name: "pricing", cwd: dir },
      { id: GUIDO, name: "GUIDO-1 · PR 12" },
      { id: SHELL, name: "dev server" },
    ],
    sessions: [
      {
        session_id: "s1",
        lifecycle: "running",
        pid: 101,
        workspace_id: PRICING,
        transcript_path: transcript,
      },
      {
        session_id: "s2",
        lifecycle: "needsInput",
        pid: 102,
        workspace_id: GUIDO,
        transcript_path: null,
      },
    ],
    screens: {
      [GUIDO]: "╭──────╮\n│ Allow this edit? │\n╰──────╯\n",
      [SHELL]: "$ npm install\nadded 3 packages\n$ npm run dev\n\n",
    },
  };
}

describe("sessions view", () => {
  it("lists every workspace with state, since and last line", async () => {
    const { fake, sessions } = setup(threeSessions());
    const t0 = Date.now();
    const view = await sessions.view();
    expect(Date.now() - t0).toBeLessThan(5000);
    if (!view.ok) throw new Error(view.error);
    const by = Object.fromEntries(view.sessions.map((r) => [r.name, r]));
    expect(by.pricing).toMatchObject({ state: "working", lastLine: "Tests pass", folder: dir });
    expect(by["GUIDO-1 · PR 12"]).toMatchObject({ state: "waiting", lastLine: "Allow this edit?" });
    expect(by["dev server"]).toMatchObject({
      state: "no-agent",
      lastLine: "$ npm run dev",
      since: nowMs,
    });
    // waiting first, then working, then no agent
    expect(view.sessions.map((r) => r.state)).toEqual(["waiting", "working", "no-agent"]);
    // reads only: no agent, no write
    expect(new Set(fake.log().map(commandOf))).toEqual(
      new Set(["ping", "list-workspaces", "sessions", "agent inbox", "list-status", "read-screen"]),
    );
  });

  it("a stalled status or screen read drops out by the deadline instead of holding the list", async () => {
    const fake = fakeCmux(dir, threeSessions());
    const stalled = new Proxy(fake.cmux, {
      get(target, key, receiver) {
        if (key === "statuses" || key === "readScreen")
          return (id: string, ...rest: unknown[]) =>
            id === SHELL
              ? new Promise(() => {})
              : (Reflect.get(target, key, receiver) as (...a: unknown[]) => unknown).call(
                  target,
                  id,
                  ...rest,
                );
        return Reflect.get(target, key, receiver);
      },
    });
    const { sessions } = setup(threeSessions(), { cmux: stalled, fieldDeadlineMs: 300 });
    const t0 = Date.now();
    const view = await sessions.view();
    expect(Date.now() - t0).toBeLessThan(2000);
    if (!view.ok) throw new Error(view.error);
    const by = Object.fromEntries(view.sessions.map((r) => [r.name, r]));
    expect(by["dev server"]).toMatchObject({ state: "no-agent", lastLine: null, status: null });
    expect(by["GUIDO-1 · PR 12"]).toMatchObject({ lastLine: "Allow this edit?" });
  });

  for (const key of ["ping", "workspaces", "agents", "inbox"] as const)
    it(`a stalled ${key} call still settles the view by its deadline`, async () => {
      const fake = fakeCmux(dir, threeSessions());
      const stalled = new Proxy(fake.cmux, {
        get(target, k, receiver) {
          if (k === key) return () => new Promise(() => {});
          return Reflect.get(target, k, receiver);
        },
      });
      const { sessions } = setup(threeSessions(), {
        cmux: stalled,
        fieldDeadlineMs: 200,
        viewDeadlineMs: 400,
      });
      const t0 = Date.now();
      const view = await sessions.view();
      expect(Date.now() - t0).toBeLessThan(2000);
      if (key === "inbox") {
        // the inbox is a field like any other: the list still comes back
        expect(view.ok).toBe(true);
      } else expect(view).toMatchObject({ ok: false, error: CMUX_SLOW_TEXT });
    });

  it("an operator's workspace is listed as theirs and never closed", async () => {
    const { fake, sessions } = setup(threeSessions());
    expect("close" in sessions).toBe(false);
    const view = await sessions.view();
    if (!view.ok) throw new Error(view.error);
    expect(view.sessions.find((r) => r.name === "pricing")?.owner).toBe("operator");
    expect(view.sessions.find((r) => r.name === "GUIDO-1 · PR 12")?.owner).toBe("crew");
    expect(fake.state().closed ?? []).toEqual([]);
    expect(fake.state().sent ?? []).toEqual([]);
    expect(fake.state().messages ?? []).toEqual([]);
  });

  it("keeps since while the state holds and resets it on a change; shares one read for 2 s", async () => {
    const { fake, sessions } = setup(threeSessions());
    const first = await sessions.view();
    if (!first.ok) throw new Error(first.error);
    const since = first.sessions.find((r) => r.id === SHELL)?.since;
    nowMs += 1000;
    expect(await sessions.view()).toBe(await sessions.view());
    nowMs += 60_000;
    const kept = await sessions.view();
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.sessions.find((r) => r.id === SHELL)?.since).toBe(since);
    fake.patch((s) => {
      s.sessions?.push({
        session_id: "s3",
        lifecycle: "idle",
        pid: 103,
        workspace_id: SHELL,
        transcript_path: null,
      });
    });
    nowMs += 60_000;
    // past the wrapper's own one-second share of `cmux sessions`, on the real clock
    await new Promise((r) => setTimeout(r, 1100));
    const changed = await sessions.view();
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.sessions.find((r) => r.id === SHELL)).toMatchObject({
      state: "idle",
      since: nowMs,
    });
  });

  it("an app status shows its address and whether it answers", async () => {
    const statuses = {
      [PRICING]: { app: "http://localhost:5173", task: "migrating prices" },
      [SHELL]: { app: "https://example.com" },
    };
    const probed: string[] = [];
    const up = setup(
      { ...threeSessions(), statuses },
      {
        probe: async (url) => {
          probed.push(url);
          return true;
        },
      },
    );
    const view = await up.sessions.view();
    if (!view.ok) throw new Error(view.error);
    const pricing = view.sessions.find((r) => r.id === PRICING);
    expect(pricing?.app).toEqual({ url: "http://localhost:5173", answers: true });
    expect(pricing?.status).toBe("migrating prices");
    expect(view.sessions.find((r) => r.id === SHELL)?.app).toEqual({
      url: "https://example.com",
      answers: null,
    });
    expect(probed).toEqual(["http://localhost:5173"]);

    rmSync(join(dir, "cmux-state.json.log"), { force: true });
    const down = setup({ ...threeSessions(), statuses }, { probe: async () => false });
    const off = await down.sessions.view();
    if (!off.ok) throw new Error(off.error);
    expect(off.sessions.find((r) => r.id === PRICING)?.app).toEqual({
      url: "http://localhost:5173",
      answers: false,
    });
  });

  it("twelve slow apps that are down all keep their address and read as not answering", async () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`,
    );
    const { sessions } = setup(
      {
        workspaces: ids.map((id, i) => ({ id, name: `app ${i}` })),
        sessions: [],
        screens: Object.fromEntries(ids.map((id) => [id, "$ npm run dev\n"])),
        statuses: Object.fromEntries(
          ids.map((id, i) => [id, { app: `http://localhost:${5100 + i}` }]),
        ),
      },
      { probe: () => new Promise((r) => setTimeout(() => r(false), 2000)) },
    );
    const t0 = Date.now();
    const view = await sessions.view();
    expect(Date.now() - t0).toBeLessThan(5000);
    if (!view.ok) throw new Error(view.error);
    expect(view.sessions).toHaveLength(12);
    for (const [i, id] of ids.entries())
      expect(view.sessions.find((r) => r.id === id)?.app).toEqual({
        url: `http://localhost:${5100 + i}`,
        answers: false,
      });
  }, 10_000);

  it("tells a session once when its app stops answering, and once when it is back", async () => {
    let answers = true;
    const { fake, sessions } = setup(
      { ...threeSessions(), statuses: { [PRICING]: { app: "http://127.0.0.1:5173" } } },
      { probe: async () => answers },
    );
    await sessions.view();
    expect(fake.state().messages ?? []).toEqual([]);
    answers = false;
    nowMs += 10_000;
    await sessions.view();
    nowMs += 10_000;
    await sessions.view();
    expect(fake.state().messages).toEqual([
      {
        to: PRICING,
        from: "Mission Control",
        text: "Your app at http://127.0.0.1:5173 has stopped answering.",
      },
    ]);
    answers = true;
    nowMs += 10_000;
    await sessions.view();
    expect(fake.state().messages?.map((m) => m.text)).toEqual([
      "Your app at http://127.0.0.1:5173 has stopped answering.",
      "Your app at http://127.0.0.1:5173 answers again.",
    ]);
    expect(store.hubEvents(0).map((e) => e.text)).toEqual([
      'Told cmux session "pricing" its app at http://127.0.0.1:5173 stopped answering',
      'Told cmux session "pricing" its app at http://127.0.0.1:5173 answers again',
    ]);
    // the terminal is never typed into
    expect(fake.state().sent ?? []).toEqual([]);
  });

  it("two overlapping reads tell a session once when its app stops, and once when it is back", async () => {
    let answers = true;
    const fake = fakeCmux(dir, {
      ...threeSessions(),
      statuses: { [PRICING]: { app: "http://127.0.0.1:5173" } },
    });
    // a slow message keeps both reads inside the notice at once
    const slow = new Proxy(fake.cmux, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver) as (...a: unknown[]) => Promise<unknown>;
        if (key !== "agentMessage") return v;
        return async (...a: unknown[]) => {
          await new Promise((r) => setTimeout(r, 50));
          return v.apply(target, a);
        };
      },
    });
    const { sessions } = setup(
      { ...threeSessions(), statuses: { [PRICING]: { app: "http://127.0.0.1:5173" } } },
      { cmux: slow, probe: async () => answers },
    );
    await sessions.view();
    const overlapping = async () => {
      const first = sessions.view();
      // past the shared read and the probe's cache, so the second is a read of its own
      nowMs += 10_000;
      const second = sessions.view();
      expect(second).not.toBe(first);
      await Promise.all([first, second]);
      nowMs += 10_000;
    };
    answers = false;
    nowMs += 10_000;
    await overlapping();
    answers = true;
    await overlapping();
    expect(fake.state().messages?.map((m) => m.text)).toEqual([
      "Your app at http://127.0.0.1:5173 has stopped answering.",
      "Your app at http://127.0.0.1:5173 answers again.",
    ]);
  });

  it("shows each session's unread messages and the newest one", async () => {
    const { sessions } = setup({
      ...threeSessions(),
      inbox: [
        { workspace_id: PRICING, text: "Rebase when free", state: "delivered" },
        { workspace_id: PRICING, text: "Older", state: "read" },
      ],
    });
    const view = await sessions.view();
    if (!view.ok) throw new Error(view.error);
    expect(view.sessions.find((r) => r.id === PRICING)?.inbox).toEqual({
      unread: 1,
      newest: "Rebase when free",
    });
    expect(view.sessions.find((r) => r.id === SHELL)?.inbox).toEqual({ unread: 0, newest: null });
  });

  it("says cmux is not running or refuses, and never starts it", async () => {
    const down = setup({ down: true });
    expect(await down.sessions.view()).toMatchObject({ ok: false, error: CMUX_NOT_RUNNING_TEXT });
    expect(down.fake.log().map(commandOf)).toEqual(["ping"]);
    rmSync(join(dir, "cmux-state.json.log"), { force: true });
    const denied = setup({ denied: true });
    expect(await denied.sessions.view()).toMatchObject({ ok: false, error: CMUX_REFUSED_TEXT });
  });

  it("reads no transcript outside Claude's projects folder", async () => {
    const outside = join(dir, "elsewhere.jsonl");
    writeFileSync(outside, `${assistant("secret words")}\n`);
    const { sessions } = setup({
      workspaces: [{ id: PRICING, name: "pricing" }],
      sessions: [
        {
          session_id: "s1",
          lifecycle: "idle",
          pid: 1,
          workspace_id: PRICING,
          transcript_path: outside,
        },
      ],
      screens: { [PRICING]: "> \n" },
    });
    const view = await sessions.view();
    if (!view.ok) throw new Error(view.error);
    expect(view.sessions[0]?.lastLine).toBe(">");
  });
});

describe("repoOf", () => {
  it("names the folder with a .git folder, and a worktree's main checkout", async () => {
    const main = join(dir, "shop-app");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    expect(await repoOf(join(main, "src", "deep"))).toBe("shop-app");
    const wt = join(dir, "worktrees", "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(await repoOf(wt)).toBe("shop-app");
    expect(await repoOf("/")).toBeNull();
  });
});

describe("last lines", () => {
  it("takes the last assistant text, skipping a cut first line and tool calls", () => {
    const tail = `{"partial": \n${assistant("First")}\n${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }] } })}\n${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`;
    expect(lastAssistantText(tail, true)).toBe("First");
    expect(lastAssistantText("", false)).toBeNull();
  });

  it("cuts a long line to 300 characters on one line", () => {
    expect(lastAssistantText(`${assistant(`a\n${"x".repeat(400)}`)}\n`, false)).toHaveLength(300);
    expect(lastScreenLine("  │ done │  \n\n")).toBe("done");
    expect(lastScreenLine("\n \n")).toBeNull();
  });
});
