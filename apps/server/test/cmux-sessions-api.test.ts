import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_HEADER, SESSION_BUSY_TEXT, SESSIONS_OFF_TEXT } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDeps, buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
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

  it("answers 503 on a hub without cmux sessions", async () => {
    await app.close();
    start({ sessions: undefined });
    const r = await operator().get("/api/sessions");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: SESSIONS_OFF_TEXT });
  });
});
