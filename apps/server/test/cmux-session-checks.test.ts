import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_CHECKS_SETTING, SESSION_UNKNOWN_REPO_TEXT, type SessionCheck } from "@mc/core";
import { afterEach, expect, it, vi } from "vitest";
import type { Cmux } from "../src/runtime/cmux.ts";
import {
  type ChecksAgent,
  type ChecksCmux,
  type ChecksWorkspace,
  checkoutOf,
  createSessionChecks,
  liveAgentOf,
  lowPriorityPrefix,
  type SessionChecks,
  type SessionChecksDeps,
} from "../src/sessions/checks.ts";
import { createSessions } from "../src/sessions/sessions.ts";
import { Store } from "../src/store.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const PRINT_AND_FAIL = `node ${join(FIXTURES, "print-and-fail.mjs")}`;
const SHORT = `node -e "setTimeout(()=>{},300)"`;
const LONG = `node -e "setTimeout(()=>{},20000)"`;
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const dirs: string[] = [];
const running: SessionChecks[] = [];
afterEach(async () => {
  for (const c of running.splice(0)) await c.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A git repo with one commit, by its real path. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-checks-")));
  dirs.push(dir);
  const main = join(dir, "pricing");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@example.com");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "README.md"), "hello\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "first");
  return main;
}

/** cmux in memory: what the checks read, and every message they send. */
function fakeCmux(workspaces: ChecksWorkspace[], agents: ChecksAgent[]) {
  const state = {
    up: "up" as "up" | "down" | "denied",
    workspaces,
    agents,
    messages: [] as { to: string; from: string; text: string }[],
  };
  const cmux: ChecksCmux = {
    ping: async () => state.up,
    workspaces: async () => state.workspaces.map((w) => ({ ...w })),
    agents: async () => state.agents.map((a) => ({ ...a })),
    agentMessage: async (to, text, from) => {
      state.messages.push({ to, from, text });
    },
  };
  const lifecycle = (ws: string, l: ChecksAgent["lifecycle"]) => {
    for (const a of state.agents) if (a.workspaceId === ws) a.lifecycle = l;
  };
  return { state, cmux, lifecycle };
}

const agent = (ws: string, cwd: string, lifecycle: ChecksAgent["lifecycle"] = "running") => ({
  sessionId: `s-${ws}`,
  lifecycle,
  pid: null,
  workspaceId: ws,
  transcriptPath: null,
  cwd,
});

function setup(
  workspaces: ChecksWorkspace[],
  agents: ChecksAgent[],
  over: Partial<SessionChecksDeps> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "mc-checks-store-"));
  dirs.push(dir);
  const store = new Store(join(dir, "store.sqlite"));
  const fake = fakeCmux(workspaces, agents);
  const notify = vi.fn();
  const sidebarNotify = vi.fn(async () => {});
  const checks = createSessionChecks({
    cmux: fake.cmux,
    store,
    seatIds: () => ["GUIDO-1"],
    crewRoots: () => [],
    configuredChecks: () => [],
    notify,
    sidebarNotify,
    lowPriority: [],
    load: () => 0,
    cores: () => 8,
    watchMs: 50,
    ...over,
  });
  running.push(checks);
  return { ...fake, store, notify, sidebarNotify, checks };
}

/** Turns the repo on with these page commands, as the Sessions page does. */
async function turnOn(checks: SessionChecks, main: string, commands: string[], on = true) {
  await checks.repos([{ repoKey: main }]);
  checks.setRepo(main, { on, commands }, "operator");
}

const ticks = async (checks: SessionChecks, n: number) => {
  for (let i = 0; i < n; i++) await checks.tick();
};

const stateOf = (checks: SessionChecks, ws: string): SessionCheck["state"] | null =>
  checks.checkOf(ws)?.state ?? null;

it("a turned-on repo's session that edits a file and goes idle shows a passed check", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  await turnOn(t.checks, main, [SHORT]);
  await t.checks.tick();
  writeFileSync(join(main, "price.ts"), "export const p = 1;\n");
  t.lifecycle(WS_A, "idle");
  const idleAt = Date.now();
  t.checks.start();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("passed"), {
    timeout: 300 + 10_000,
    interval: 25,
  });
  expect(Date.now() - idleAt).toBeLessThan(300 + 10_000);
  expect(t.checks.lastResult(WS_A)).toMatchObject({ ok: true });
  const first = t.checks.checkOf(WS_A);
  // an unchanged second piece of work runs nothing
  t.lifecycle(WS_A, "running");
  await new Promise((r) => setTimeout(r, 200));
  t.lifecycle(WS_A, "idle");
  await new Promise((r) => setTimeout(r, 400));
  expect(t.checks.checkOf(WS_A)).toEqual(first);
  expect(t.state.messages).toEqual([]);
});

it("the Sessions view shows the row's passed check and its repo's switch, from the page's own read", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  const cmux = {
    ...t.cmux,
    statuses: async () => ({}),
    readScreen: async () => "",
    inbox: async () => [],
  } as unknown as Cmux;
  const sessions = createSessions({
    cmux,
    store: t.store,
    seatIds: () => ["GUIDO-1"],
    checks: t.checks,
    tellApps: false,
    now: (() => {
      // each read is fresh: the view's 2 s cache would hide the check moving on
      let at = Date.now();
      return () => (at += 5000);
    })(),
  });
  const first = await sessions.view();
  if (!first.ok) throw new Error(first.error);
  expect(first.sessions[0]).toMatchObject({ repo: "pricing", repoKey: main, check: null });
  expect(first.repos).toEqual([
    { repo: main, name: "pricing", on: false, source: null, commands: [], pageCommands: [] },
  ]);
  t.checks.setRepo(main, { on: true, commands: [SHORT] }, "operator");
  await t.checks.tick();
  writeFileSync(join(main, "price.ts"), "export const p = 1;\n");
  t.lifecycle(WS_A, "idle");
  const idleAt = Date.now();
  t.checks.start();
  await vi.waitFor(
    async () => {
      const v = await sessions.view();
      expect(v.ok && v.sessions[0]?.check?.state).toBe("passed");
    },
    { timeout: 300 + 10_000, interval: 50 },
  );
  expect(Date.now() - idleAt).toBeLessThan(300 + 10_000);
  const last = await sessions.view();
  expect(last.ok && last.repos).toEqual([
    {
      repo: main,
      name: "pricing",
      on: true,
      source: "page",
      commands: [SHORT],
      pageCommands: [SHORT],
    },
  ]);
});

it("a failing check sends one message with the command and its last 40 lines, and one notice", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  await turnOn(t.checks, main, [PRINT_AND_FAIL]);
  await t.checks.tick();
  writeFileSync(join(main, "price.ts"), "export const p = 1;\n");
  t.lifecycle(WS_A, "idle");
  t.checks.start();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("failed"), { timeout: 10_000 });
  expect(t.state.messages).toHaveLength(1);
  const [m] = t.state.messages;
  expect(m?.to).toBe(WS_A);
  expect(m?.from).toBe("Mission Control");
  expect(m?.text).toContain(`\`${PRINT_AND_FAIL}\` failed with exit code 2`);
  expect(m?.text).toContain("Its last 40 lines:");
  expect(m?.text).toMatch(/line 21\n/);
  expect(m?.text).toMatch(/line 60$/);
  expect(m?.text).not.toMatch(/line 20\n/);
  expect(t.notify).toHaveBeenCalledTimes(1);
  expect(t.notify).toHaveBeenCalledWith(
    `Checks failed in cmux session "pricing": ${PRINT_AND_FAIL}`,
  );
  expect(t.sidebarNotify).toHaveBeenCalledWith(
    WS_A,
    `Checks failed in cmux session "pricing": ${PRINT_AND_FAIL}`,
  );
  expect(t.store.hubEvents(0).map((e) => e.text)).toContain(
    `Checks failed in cmux session "pricing": ${PRINT_AND_FAIL}`,
  );
  expect(t.checks.checkOf(WS_A)).toMatchObject({ command: PRINT_AND_FAIL, why: "idle" });
  expect(t.checks.lastResult(WS_A)).toMatchObject({ ok: false, command: PRINT_AND_FAIL });
});

it("a repo not turned on never runs a check by itself", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  await ticks(t.checks, 5);
  expect(t.checks.checkOf(WS_A)).toBeNull();
  // page commands set, still off
  await turnOn(t.checks, main, [SHORT], false);
  t.lifecycle(WS_A, "running");
  await t.checks.tick();
  writeFileSync(join(main, "b.ts"), "2\n");
  t.lifecycle(WS_A, "idle");
  await ticks(t.checks, 5);
  expect(t.checks.checkOf(WS_A)).toBeNull();
  expect(t.state.messages).toEqual([]);
});

it("a crew workspace in a turned-on repo runs nothing, by itself or when asked", async () => {
  const main = repo();
  const crewRoot = realpathSync(mkdtempSync(join(tmpdir(), "mc-checks-crew-")));
  dirs.push(crewRoot);
  const crewTop = join(crewRoot, "wt");
  git(main, "worktree", "add", "-q", "-b", "crew", crewTop);
  const t = setup(
    [
      { id: WS_A, name: "GUIDO-1 · PR 12", cwd: main },
      { id: WS_B, name: "someone", cwd: crewTop },
    ],
    [agent(WS_A, main), agent(WS_B, crewTop)],
    { crewRoots: () => [crewRoot] },
  );
  await turnOn(t.checks, main, [SHORT]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  writeFileSync(join(crewTop, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  t.lifecycle(WS_B, "idle");
  await ticks(t.checks, 5);
  expect(t.checks.checkOf(WS_A)).toBeNull();
  expect(t.checks.checkOf(WS_B)).toBeNull();
  expect(await t.checks.run(WS_A)).toBe("crew");
  expect(await t.checks.run(WS_B)).toBe("crew");
});

it("two sessions going idle together run their checks one after the other", async () => {
  const main = repo();
  const second = join(main, "..", "pricing-2");
  git(main, "worktree", "add", "-q", "-b", "two", second);
  const log = join(main, "..", "spans.log");
  const span = `node ${join(FIXTURES, "check-span.mjs")} ${log}`;
  const t = setup(
    [
      { id: WS_A, name: "pricing", cwd: main },
      { id: WS_B, name: "pricing two", cwd: second },
    ],
    [agent(WS_A, main), agent(WS_B, second)],
  );
  await turnOn(t.checks, main, [span]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  writeFileSync(join(second, "b.ts"), "2\n");
  t.lifecycle(WS_A, "idle");
  t.lifecycle(WS_B, "idle");
  t.checks.start();
  await vi.waitFor(
    () => {
      expect(stateOf(t.checks, WS_A)).toBe("passed");
      expect(stateOf(t.checks, WS_B)).toBe("passed");
    },
    { timeout: 10_000 },
  );
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines.map((l) => l.split(" ")[0])).toEqual(["start", "end", "start", "end"]);
  const at = lines.map((l) => Number(l.split(" ")[1]));
  expect(at[2]).toBeGreaterThanOrEqual(at[1] as number);
  // each ran in its own checkout
  expect(new Set(lines.map((l) => l.split(" ")[2])).size).toBe(2);
});

it("a session that starts working again stops its check, with no message", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  await turnOn(t.checks, main, [LONG]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  t.checks.start();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("running"), { timeout: 5000 });
  t.lifecycle(WS_A, "running");
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("stopped"), { timeout: 5000 });
  expect(t.state.messages).toEqual([]);
  expect(t.notify).not.toHaveBeenCalled();
  expect(t.checks.lastResult(WS_A)).toBeNull();
});

it("a check past its time is stopped and reported as timed out", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)], {
    timeoutMs: 200,
  });
  await turnOn(t.checks, main, [LONG]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  t.checks.start();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("timed-out"), { timeout: 8000 });
  expect(t.state.messages).toHaveLength(1);
  expect(t.state.messages[0]?.text).toContain(`\`${LONG}\` was stopped after`);
  expect(t.notify).toHaveBeenCalledWith(`Checks timed out in cmux session "pricing": ${LONG}`);
  expect(t.checks.lastResult(WS_A)).toMatchObject({ ok: false, command: LONG });
});

it("checks run at low priority and wait while the Mac is busy", async () => {
  expect(lowPriorityPrefix("darwin")).toEqual(["/usr/sbin/taskpolicy", "-b"]);
  expect(lowPriorityPrefix("linux")).toEqual(["nice", "-n", "19"]);
  const main = repo();
  let load = 9;
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main, "idle")], {
    load: () => load,
    cores: () => 8,
  });
  await turnOn(t.checks, main, [SHORT]);
  expect(await t.checks.run(WS_A)).toBe("queued");
  await ticks(t.checks, 3);
  expect(t.checks.checkOf(WS_A)).toMatchObject({ state: "queued", why: "operator" });
  load = 2;
  await t.checks.tick();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("passed"), { timeout: 5000 });
});

it("the operator can run a repo's checks from the row, switch or not, and is told when there are none", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main, "idle")]);
  await t.checks.repos([{ repoKey: main }]);
  expect(await t.checks.run(WS_A)).toBe("no-checks");
  await turnOn(t.checks, main, [SHORT], false);
  expect(await t.checks.run(WS_A)).toBe("queued");
  await vi.waitFor(
    async () => {
      await t.checks.tick();
      expect(stateOf(t.checks, WS_A)).toBe("passed");
    },
    { timeout: 5000 },
  );
});

it("keeps one switch and page list per repo, only for a repo a session is in", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  expect(() => t.checks.setRepo(main, { on: true }, "operator")).toThrow(SESSION_UNKNOWN_REPO_TEXT);
  expect(await t.checks.repos([{ repoKey: main }, { repoKey: null }])).toEqual([
    { repo: main, name: "pricing", on: false, source: null, commands: [], pageCommands: [] },
  ]);
  t.checks.setRepo(main, { on: true, commands: [SHORT] }, "operator");
  expect(await t.checks.repos([{ repoKey: main }])).toEqual([
    {
      repo: main,
      name: "pricing",
      on: true,
      source: "page",
      commands: [SHORT],
      pageCommands: [SHORT],
    },
  ]);
  expect(t.store.hubEvents(0).map((e) => e.text)).toContain(
    `Checks turned on for repo "pricing" by operator`,
  );
  t.checks.setRepo(main, { on: false }, "operator");
  expect(t.store.hubEvents(0).map((e) => e.text)).toContain(
    `Checks turned off for repo "pricing" by operator`,
  );
  // a damaged setting reads as nothing turned on
  t.store.setSetting(SESSION_CHECKS_SETTING, "{not json");
  expect((await t.checks.repos([{ repoKey: main }]))[0]).toMatchObject({ on: false });
});

it("prefers the hub config's checks for the repo over the page's list", async () => {
  const main = repo();
  git(main, "remote", "add", "origin", "https://github.com/Example/Pricing.git");
  const configuredChecks = vi.fn((github: string) =>
    github === "example/pricing" ? ["pnpm -s lint"] : [],
  );
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)], {
    configuredChecks,
  });
  await turnOn(t.checks, main, [SHORT]);
  expect((await t.checks.repos([{ repoKey: main }]))[0]).toMatchObject({
    source: "config",
    commands: ["pnpm -s lint"],
    pageCommands: [SHORT],
  });
});

it("runs the repo's own checks from origin/HEAD over the working copy, the hub config and the page", async () => {
  const main = repo();
  const block = (command: string) =>
    `# Pricing\n\n## Mission Control\n\n\`\`\`yaml\nmc:\n  checks: ["${command}"]\n\`\`\`\n`;
  writeFileSync(join(main, "CLAUDE.md"), block("touch ran-origin"));
  git(main, "add", "CLAUDE.md");
  git(main, "commit", "-q", "-m", "checks");
  git(main, "remote", "add", "origin", "https://github.com/Example/Pricing.git");
  git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // the session edits its working copy's block; origin/HEAD still names the repo's checks
  writeFileSync(join(main, "CLAUDE.md"), block("touch ran-working"));
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main, "idle")], {
    configuredChecks: (github) => (github === "example/pricing" ? ["touch ran-config"] : []),
  });
  await turnOn(t.checks, main, ["touch ran-page"]);
  expect((await t.checks.repos([{ repoKey: main }]))[0]).toMatchObject({
    source: "repo",
    commands: ["touch ran-origin"],
    pageCommands: ["touch ran-page"],
  });
  expect(await t.checks.run(WS_A)).toBe("queued");
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("passed"), { timeout: 5000 });
  expect(t.checks.checkOf(WS_A)?.command).toBe("touch ran-origin");
  const ran = (f: string) => {
    try {
      statSync(join(main, f));
      return true;
    } catch {
      return false;
    }
  };
  expect(["ran-origin", "ran-working", "ran-config", "ran-page"].filter(ran)).toEqual([
    "ran-origin",
  ]);
});

it("finds a folder's checkout and main checkout, a worktree's included", async () => {
  const main = repo();
  const wt = join(main, "..", "pricing-wt");
  git(main, "worktree", "add", "-q", "-b", "wt", wt);
  mkdirSync(join(wt, "src"));
  expect(await checkoutOf(join(wt, "src"))).toEqual({ top: wt, main });
  expect(await checkoutOf(main)).toEqual({ top: main, main });
  expect(await checkoutOf("/dev")).toBeNull();
});

it("reads a workspace's live agent: the most pressing one not known dead", () => {
  const a = agent(WS_A, "/x", "idle");
  const b = { ...agent(WS_A, "/x", "needsInput"), pid: 12 };
  expect(liveAgentOf([a, b], WS_A, () => true)?.lifecycle).toBe("needsInput");
  expect(liveAgentOf([a, b], WS_A, () => false)?.lifecycle).toBe("idle");
  expect(liveAgentOf([a, b], WS_B, () => true)).toBeNull();
});

it("a check whose program cannot start fails with the shell's not-found code", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main, "idle")], {
    lowPriority: ["/nonexistent/low-priority"],
  });
  await turnOn(t.checks, main, [SHORT]);
  expect(await t.checks.run(WS_A)).toBe("queued");
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("failed"), { timeout: 5000 });
  expect(t.state.messages[0]?.text).toContain("failed with exit code 127. Its last line:\n\nspawn");
});

it("a repo switched off while its check waits or runs never runs it by itself", async () => {
  const main = repo();
  let load = 9;
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)], {
    load: () => load,
  });
  await turnOn(t.checks, main, [PRINT_AND_FAIL]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  await t.checks.tick();
  expect(stateOf(t.checks, WS_A)).toBe("queued");
  t.checks.setRepo(main, { on: false }, "operator");
  load = 2;
  await ticks(t.checks, 3);
  await new Promise((r) => setTimeout(r, 1500));
  expect(t.state.messages).toEqual([]);
  expect(stateOf(t.checks, WS_A)).not.toBe("failed");

  // and a running one is stopped
  t.checks.setRepo(main, { on: true, commands: [LONG] }, "operator");
  t.lifecycle(WS_A, "running");
  await t.checks.tick();
  writeFileSync(join(main, "b.ts"), "2\n");
  t.lifecycle(WS_A, "idle");
  await t.checks.tick();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("running"), { timeout: 5000 });
  t.checks.setRepo(main, { on: false }, "operator");
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("stopped"), { timeout: 5000 });
  expect(t.state.messages).toEqual([]);
});

it("an operator's run on a session already working is not stopped when the watcher first sees it", async () => {
  const main = repo();
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main, "running")]);
  await turnOn(t.checks, main, [LONG], false);
  expect(await t.checks.run(WS_A)).toBe("queued");
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("running"), { timeout: 5000 });
  await t.checks.tick();
  await new Promise((r) => setTimeout(r, 300));
  expect(stateOf(t.checks, WS_A)).toBe("running");
});

it("reads the checkout's state without writing its index", async () => {
  const main = repo();
  const index = join(main, ".git", "index");
  utimesSync(index, 1000, 1000);
  const later = Date.now() / 1000 + 60;
  utimesSync(join(main, "README.md"), later, later);
  const t = setup([{ id: WS_A, name: "pricing", cwd: main }], [agent(WS_A, main)]);
  await turnOn(t.checks, main, [SHORT]);
  await t.checks.tick();
  writeFileSync(join(main, "a.ts"), "1\n");
  t.lifecycle(WS_A, "idle");
  t.checks.start();
  await vi.waitFor(() => expect(stateOf(t.checks, WS_A)).toBe("passed"), { timeout: 10_000 });
  expect(statSync(index).mtimeMs).toBe(1_000_000);
});
