import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATOR_HEADER,
  SESSION_BUSY_TEXT,
  SESSION_CHECKS_SETTING,
  SESSION_CREW_CHECKS_TEXT,
  SESSION_NO_CHECKS_TEXT,
  SESSION_UNKNOWN_REPO_TEXT,
  SESSIONS_OFF_TEXT,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppDeps, buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { createSessionChecks, type SessionChecks } from "../src/sessions/checks.ts";
import { createSessions } from "../src/sessions/sessions.ts";
import { Store } from "../src/store.ts";
import { type FakeCmux, type FakeState, fakeCmux } from "./fake-cmux-harness.ts";

const PRICING = "11111111-1111-4111-8111-111111111111";
const WAITING = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "99999999-9999-4999-8999-999999999999";
const KEY = "operator-key";
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
