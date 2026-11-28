import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATOR_HEADER,
  SESSION_BUSY_TEXT,
  SESSION_CHECKS_SETTING,
  SESSION_CREW_CHECKS_TEXT,
  SESSION_FOLDER_TEXT,
  SESSION_NO_CHECKS_TEXT,
  SESSION_ROLE_TEXT,
  SESSION_UNKNOWN_REPO_TEXT,
  SESSIONS_OFF_TEXT,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, buildApp, LOOP_WRITES_DISABLED } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { CmuxError } from "../src/runtime/cmux.ts";
import { CrewAppError } from "../src/sessions/apps.ts";
import { createSessionChecks, type SessionChecks } from "../src/sessions/checks.ts";
import { createSessions } from "../src/sessions/sessions.ts";
import { Store } from "../src/store.ts";
import { commandOf, type FakeCmux, type FakeState, fakeCmux } from "./fake-cmux-harness.ts";

const PRICING = "11111111-1111-4111-8111-111111111111";
const WAITING = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const KEY = "operator-key";
/** The hub's own role prompts. */
const ROLES_DIR = fileURLToPath(new URL("../../../roles", import.meta.url));
const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

let dir: string;
let store: Store;
let fake: FakeCmux;
let app: FastifyInstance;

const STATE: FakeState = {
  workspaces: [
    { id: PRICING, name: "pricing" },
    { id: WAITING, name: "GUIDO-1 · PR 12" },
  ],
  sessions: [
    {
      session_id: "s2",
      lifecycle: "needsInput",
      pid: null,
      workspace_id: WAITING,
      transcript_path: null,
    },
  ],
  statuses: { [PRICING]: { app: "http://localhost:5173" } },
};

function start(over: Partial<AppDeps> = {}) {
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    operatorToken: KEY,
    sessions: createSessions({
      cmux: fake.cmux,
      store,
      seatIds: () => ["GUIDO-1"],
      probe: async () => true,
      rolesDir: ROLES_DIR,
    }),
    tokens: {
      resolve: (t: string) => (t === "seat-token" ? { seatId: "s", runId: "r" } : null),
    } as never,
    ...over,
  });
}
const as = (headers: Record<string, string>) => ({
  get: (url: string) => app.inject({ method: "GET", url, headers }),
  post: (url: string, payload: object = {}) =>
    app.inject({ method: "POST", url, headers, payload }),
});
const operator = () => as({ [OPERATOR_HEADER]: KEY });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-sessions-api-"));
  store = new Store(join(dir, "mc.sqlite"));
  fake = fakeCmux(dir, structuredClone(STATE));
  start();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the sessions routes", () => {
  it("lists every workspace for the operator only", async () => {
    const r = await operator().get("/api/sessions");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
    expect(
      r
        .json()
        .sessions.map((s: { name: string }) => s.name)
        .sort(),
    ).toEqual(["GUIDO-1 · PR 12", "pricing"]);
    expect((await as({}).get("/api/sessions")).statusCode).toBe(401);
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.get("/api/sessions")).statusCode).toBe(403);
  });

  it("focus selects the workspace", async () => {
    expect((await operator().post(`/api/sessions/${PRICING}/focus`)).statusCode).toBe(200);
    expect(fake.state().selected).toEqual([PRICING]);
    expect(fake.state().calls).toContainEqual(["select-workspace", "--workspace", PRICING]);
    expect((await as({}).post(`/api/sessions/${PRICING}/focus`)).statusCode).toBe(401);
    expect((await operator().post(`/api/sessions/${UNKNOWN}/focus`)).statusCode).toBe(404);
    // a malformed id never reaches cmux
    expect((await operator().post("/api/sessions/workspace:1/focus")).statusCode).toBe(404);
    expect(fake.state().selected).toEqual([PRICING]);
  });

  it("focus fails when cmux cannot be brought to the front", async () => {
    await app.close();
    fake = fakeCmux(dir, structuredClone(STATE), ["/usr/bin/false"]);
    start();
    const r = await operator().post(`/api/sessions/${PRICING}/focus`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/bring to front failed/);
    expect(fake.state().selected).toEqual([PRICING]);
  });

  it("send pastes the text then Enter", async () => {
    const r = await operator().post(`/api/sessions/${PRICING}/send`, { text: "hello" });
    expect(r.statusCode).toBe(200);
    expect(fake.state().sent).toEqual([{ ws: PRICING, text: "hello", paste: true }]);
    expect(fake.state().keys).toEqual([{ ws: PRICING, key: "enter", force: false }]);
    expect(store.hubEvents(0).map((e) => e.text)).toEqual([
      'Wrote to cmux session "pricing" (5 characters), asked by operator',
    ]);
    // a question open: nothing is typed
    const busy = await operator().post(`/api/sessions/${WAITING}/send`, { text: "yes" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: SESSION_BUSY_TEXT });
    fake.patch((s) => {
      s.busy = true;
    });
    const dialog = await operator().post(`/api/sessions/${PRICING}/send`, { text: "again" });
    expect(dialog.statusCode).toBe(409);
    expect(fake.state().sent).toHaveLength(1);
    expect(store.hubEvents(0)).toHaveLength(1);
  });

  it("refuses an empty or too long text and an unknown session", async () => {
    for (const text of ["", "  ", "x".repeat(4001)])
      expect((await operator().post(`/api/sessions/${PRICING}/send`, { text })).statusCode).toBe(
        400,
      );
    expect(
      (await operator().post(`/api/sessions/${UNKNOWN}/send`, { text: "hi" })).statusCode,
    ).toBe(404);
    expect(fake.state().sent ?? []).toEqual([]);
  });

  it("opens the session's app in its own browser pane", async () => {
    expect((await operator().post(`/api/sessions/${PRICING}/app`)).statusCode).toBe(200);
    expect(fake.state().panes).toEqual([
      { ws: PRICING, type: "browser", url: "http://localhost:5173" },
    ]);
    expect((await operator().post(`/api/sessions/${WAITING}/app`)).statusCode).toBe(400);
  });

  it("resets remembered sidebar fields when cmux writes turn on", async () => {
    await app.close();
    const reset = vi.fn();
    start({ onSessionSidebarChange: reset });
    expect((await operator().post("/api/sessions/sidebar", { on: false })).json()).toEqual({
      on: false,
    });
    expect(reset).not.toHaveBeenCalled();
    expect((await operator().post("/api/sessions/sidebar", { on: true })).json()).toEqual({
      on: true,
    });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("keeps the sidebar setting operator-only", async () => {
    expect((await operator().post("/api/sessions/sidebar", { on: false })).json()).toEqual({
      on: false,
    });
    expect((await operator().get("/api/sessions/sidebar")).json()).toEqual({ on: false });
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.get("/api/sessions/sidebar")).statusCode).toBe(403);
    expect(
      (await operator().post("/api/sessions/sidebar", { on: false, extra: true })).statusCode,
    ).toBe(400);
  });

  it("lists the roles and the sessions' folders", async () => {
    fake.patch((s) => {
      for (const w of s.workspaces ?? []) w.cwd = dir;
    });
    const r = await operator().get("/api/sessions/roles");
    expect(r.statusCode).toBe(200);
    expect(r.json().roles).toEqual(["AUDIT", "FAO", "FLIGHT", "GUIDO", "INCO", "RETRO"]);
    expect(r.json().folders).toEqual([dir]);
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.get("/api/sessions/roles")).statusCode).toBe(403);
  });

  it("a failed start closes only the workspace it opened, never a same-named older one", async () => {
    // Claude quits at its trust prompt in the new workspace; "pricing" is the operator's own
    fake.patch((s) => {
      s.screen = "Claude Code will exit: this folder isn't trusted.\n% ";
    });
    const input = { folder: dir, worktree: false, role: "GUIDO", message: "m", name: "pricing" };
    const r = await operator().post("/api/sessions", input);
    expect(r.statusCode).toBe(503);
    // the one closed is the workspace this open made; the operator's own "pricing" stays open
    const closed = fake.state().closed ?? [];
    expect(closed).toHaveLength(1);
    expect(closed[0]).not.toBe(PRICING);
    expect(fake.state().workspaces?.map((w) => w.id)).toContain(PRICING);
  });

  it("two opens at once with the same name each get, and close, only their own workspace", async () => {
    const input = { folder: dir, worktree: false, role: "GUIDO", message: "m" };
    fake.patch((s) => {
      s.screen = "│ ❯ │\n  ? for shortcuts\n";
    });
    const both = await Promise.all([
      operator().post("/api/sessions", input),
      operator().post("/api/sessions", input),
    ]);
    expect(both.map((r) => r.statusCode)).toEqual([201, 201]);
    const ids = both.map((r) => r.json().id);
    expect(new Set(ids).size).toBe(2);
    // both starts fail: each closes the workspace it made, and nothing else
    fake.patch((s) => {
      s.screen = "Claude Code will exit: this folder isn't trusted.\n% ";
    });
    const failed = await Promise.all([
      operator().post("/api/sessions", input),
      operator().post("/api/sessions", input),
    ]);
    expect(failed.map((r) => r.statusCode)).toEqual([503, 503]);
    const closed = fake.state().closed ?? [];
    expect(closed).toHaveLength(2);
    expect(new Set(closed).size).toBe(2);
    for (const id of [...ids, PRICING]) expect(closed).not.toContain(id);
  });

  it("POST /api/sessions opens a workspace", async () => {
    const input = { folder: dir, worktree: false, role: "GUIDO", message: "Fix the login test" };
    // the new Claude comes up at its input prompt
    fake.patch((s) => {
      s.screen = "│ ❯ │\n  ? for shortcuts\n";
    });
    const r = await operator().post("/api/sessions", input);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: expect.stringMatching(/ \(GUIDO\)$/) });
    expect(fake.log().map(commandOf)).toContain("new-workspace");
    const listed = await operator().get("/api/sessions");
    expect(listed.json().sessions.find((s: { id: string }) => s.id === r.json().id)).toMatchObject({
      owner: "operator",
    });
    expect(
      store
        .hubEvents(0)
        .map((e) => e.text)
        .join("\n"),
    ).not.toContain("Fix the login test");

    const bad = async (over: object, error: string) => {
      const res = await operator().post("/api/sessions", { ...input, ...over });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error });
    };
    await bad({ folder: "relative/path" }, SESSION_FOLDER_TEXT);
    await bad({ role: "NOBODY" }, SESSION_ROLE_TEXT);
    expect((await operator().post("/api/sessions", { ...input, message: "" })).statusCode).toBe(
      400,
    );
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.post("/api/sessions", input)).statusCode).toBe(403);
  });

  it("answers 503 on a hub without cmux sessions", async () => {
    await app.close();
    start({ sessions: undefined });
    const r = await operator().get("/api/sessions");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: SESSIONS_OFF_TEXT });
  });
});

describe("the session checks routes", () => {
  let main: string;
  let checks: SessionChecks;

  /** A git repo `pricing`, the PRICING workspace in it, and the checks service on the same cmux. */
  beforeEach(async () => {
    await app.close();
    main = join(realpathSync(dir), "pricing");
    mkdirSync(main);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: main });
    git("init", "-q", "-b", "main");
    writeFileSync(join(main, "README.md"), "hello\n");
    const state = structuredClone(STATE);
    for (const w of state.workspaces ?? []) w.cwd = main;
    fake = fakeCmux(dir, state);
    checks = createSessionChecks({
      cmux: fake.cmux,
      store,
      seatIds: () => ["GUIDO-1"],
      crewRoots: () => [],
      configuredChecks: () => [],
      notify: () => {},
      lowPriority: [],
      load: () => 0,
      cores: () => 8,
    });
    start({
      sessions: createSessions({
        cmux: fake.cmux,
        store,
        seatIds: () => ["GUIDO-1"],
        probe: async () => true,
        checks,
      }),
      sessionChecks: checks,
    });
  });
  afterEach(async () => {
    await checks.stop();
  });

  it("lists the operator's repo with its switch off, and switches it on with page commands", async () => {
    const view = (await operator().get("/api/sessions")).json();
    expect(view.repos).toEqual([
      { repo: main, name: "pricing", on: false, source: null, commands: [], pageCommands: [] },
    ]);
    const row = view.sessions.find((s: { name: string }) => s.name === "pricing");
    expect(row).toMatchObject({ repo: "pricing", repoKey: main, check: null });
    const set = await operator().post("/api/sessions/checks", {
      repo: main,
      on: true,
      commands: ["node -v"],
    });
    expect(set.statusCode).toBe(200);
    expect(JSON.parse(store.getSetting(SESSION_CHECKS_SETTING) ?? "{}")).toEqual({
      [main]: { on: true, commands: ["node -v"] },
    });
    expect(store.hubEvents(0).map((e) => e.text)).toContain(
      'Checks turned on for repo "pricing" by operator',
    );
  });

  it("refuses an unknown repo, a chained or long command, too many, and a seat's token", async () => {
    await operator().get("/api/sessions");
    const unknown = await operator().post("/api/sessions/checks", { repo: "/nowhere", on: true });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: SESSION_UNKNOWN_REPO_TEXT });
    for (const commands of [["a && b"], ["x".repeat(201)], Array(11).fill("pnpm -s lint"), [""]])
      expect(
        (await operator().post("/api/sessions/checks", { repo: main, commands })).statusCode,
      ).toBe(400);
    expect(
      (await operator().post("/api/sessions/checks", { repo: main, extra: 1 })).statusCode,
    ).toBe(400);
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.post("/api/sessions/checks", { repo: main, on: true })).statusCode).toBe(
      403,
    );
    expect((await seat.post(`/api/sessions/${PRICING}/checks`)).statusCode).toBe(403);
    expect(store.getSetting(SESSION_CHECKS_SETTING)).toBeNull();
  });

  it("runs a row's checks when asked, or says why not", async () => {
    const none = await operator().post(`/api/sessions/${PRICING}/checks`);
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: SESSION_NO_CHECKS_TEXT });
    const crew = await operator().post(`/api/sessions/${WAITING}/checks`);
    expect(crew.statusCode).toBe(400);
    expect(crew.json()).toEqual({ error: SESSION_CREW_CHECKS_TEXT });
    expect((await operator().post(`/api/sessions/${UNKNOWN}/checks`)).statusCode).toBe(404);
    expect((await operator().post("/api/sessions/workspace:1/checks")).statusCode).toBe(404);
    expect((await operator().post(`/api/sessions/${PRICING}/checks`, { x: 1 })).statusCode).toBe(
      400,
    );
    await operator().get("/api/sessions");
    // the switch stays off: an operator's run ignores it
    await operator().post("/api/sessions/checks", { repo: main, commands: ["node -v"] });
    const ran = await operator().post(`/api/sessions/${PRICING}/checks`);
    expect(ran.statusCode).toBe(200);
    expect(checks.checkOf(PRICING)).toMatchObject({ why: "operator" });
  });

  it("answers 503 for the checks routes on a hub without them", async () => {
    await app.close();
    start({ sessionChecks: undefined });
    expect((await operator().post(`/api/sessions/${PRICING}/checks`)).statusCode).toBe(503);
    expect((await operator().post("/api/sessions/checks", { repo: main })).statusCode).toBe(503);
  });
});

describe("the crew app routes", () => {
  const VIEW = [
    {
      id: "guido-eb",
      name: "guido-eb · ebull",
      repo: "ebull",
      seat: "guido-eb",
      running: true,
      apps: [
        { url: "http://127.0.0.1:5173", answers: true },
        { url: "http://127.0.0.1:5174", answers: false },
      ],
    },
  ];
  const apps = () => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    status: vi.fn(async () => ""),
    tick: vi.fn(async () => {}),
    view: vi.fn(() => VIEW),
  });
  const restart = async (crewApps: ReturnType<typeof apps> | undefined) => {
    await app.close();
    start({ crewApps });
  };

  it("lists each seat's app, its addresses and whether they answer, for the operator only", async () => {
    await restart(apps());
    const r = await operator().get("/api/sessions/apps");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(VIEW);
    expect((await as({}).get("/api/sessions/apps")).statusCode).toBe(401);
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.get("/api/sessions/apps")).statusCode).toBe(403);
  });

  it("starts and stops one seat's app", async () => {
    const crewApps = apps();
    await restart(crewApps);
    const started = await operator().post("/api/sessions/apps/guido-eb/start");
    expect(started.statusCode).toBe(200);
    expect(started.json()).toEqual({ ok: true });
    expect(crewApps.start).toHaveBeenCalledWith("guido-eb");
    const stopped = await operator().post("/api/sessions/apps/guido-eb/stop");
    expect(stopped.statusCode).toBe(200);
    expect(crewApps.stop).toHaveBeenCalledWith("guido-eb");
  });

  it("refuses preview start and stop without touching cmux apps", async () => {
    const crewApps = apps();
    await app.close();
    start({ crewApps, noLoopWrites: true });
    for (const action of ["start", "stop"] as const) {
      const response = await operator().post(`/api/sessions/apps/guido-eb/${action}`);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: LOOP_WRITES_DISABLED });
    }
    expect(crewApps.start).not.toHaveBeenCalled();
    expect(crewApps.stop).not.toHaveBeenCalled();
  });

  it("refuses a seat's token, a body, an unknown action and an unknown seat", async () => {
    const crewApps = apps();
    await restart(crewApps);
    const seat = as({ [OPERATOR_HEADER]: KEY, authorization: "Bearer seat-token" });
    expect((await seat.post("/api/sessions/apps/guido-eb/start")).statusCode).toBe(403);
    expect((await as({}).post("/api/sessions/apps/guido-eb/start")).statusCode).toBe(401);
    const body = await operator().post("/api/sessions/apps/guido-eb/start", { now: true });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ error: "Send an empty object." });
    const action = await operator().post("/api/sessions/apps/guido-eb/restart");
    expect(action.statusCode).toBe(404);
    expect(action.json()).toEqual({ error: "No app action has that name." });
    const unknown = await operator().post("/api/sessions/apps/guido-zz/start");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "No crew app runs for that seat." });
    expect(crewApps.start).not.toHaveBeenCalled();
  });

  it("answers 503 without the crew app service, and an empty list", async () => {
    await restart(undefined);
    expect((await operator().get("/api/sessions/apps")).json()).toEqual([]);
    const r = await operator().post("/api/sessions/apps/guido-eb/start");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: SESSIONS_OFF_TEXT });
  });

  it("says why a start was refused, and answers 503 when cmux fails", async () => {
    const crewApps = apps();
    crewApps.start.mockRejectedValueOnce(new CrewAppError("No live cmux workspace for this seat."));
    crewApps.stop.mockRejectedValueOnce(new CmuxError("cmux close-surface failed"));
    await restart(crewApps);
    const refused = await operator().post("/api/sessions/apps/guido-eb/start");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "No live cmux workspace for this seat." });
    const failed = await operator().post("/api/sessions/apps/guido-eb/stop");
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "cmux close-surface failed" });
  });
});
