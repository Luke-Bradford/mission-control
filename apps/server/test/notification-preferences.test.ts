import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import * as hud from "../src/hud.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "demo", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
let dir: string;
let store: Store;
let bus: ChangeBus;
let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const original = hud.attentionItems;
  vi.spyOn(hud, "attentionItems").mockImplementation((...args) =>
    original(...args).map((item) =>
      item.key === "note:stall" ? { ...item, kind: "stalled" } : item,
    ),
  );
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  dir = mkdtempSync(join(tmpdir(), "mc-local-notify-"));
  store = new Store(join(dir, "mc.sqlite"));
  bus = new ChangeBus();
  app = buildApp({ config, store, bus });
});
afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const preferences = async () => (await app.inject("/api/notification-preferences")).json();
const events = async () => (await app.inject("/api/notifications/events")).json();
const note = (key: string) => {
  store.raiseNote({
    key,
    kind: "question",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Choose the demo lane",
    at: Date.now(),
  });
  bus.emit("attention");
};

it("defaults to the catalogue categories and validates guarded preference writes", async () => {
  expect(await preferences()).toEqual({
    enabled: true,
    softChime: true,
    categories: {
      people: true,
      decisions: true,
      stalls: true,
      prs: true,
      capcom: true,
      awayDigest: true,
      quota: false,
      agentMessages: false,
    },
    quietHours: { start: "19:00", end: "08:00", timezone: "Europe/London", stallsBypass: true },
  });
  const p = await preferences();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/notification-preferences",
        payload: { ...p, quietHours: { ...p.quietHours, timezone: "bad" } },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/notification-preferences",
        headers: { origin: "https://evil.example" },
        payload: p,
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/notification-preferences",
        headers: { "content-type": "text/plain" },
        payload: "{}",
      })
    ).statusCode,
  ).toBe(415);
});

it("deduplicates unchanged items, persists across restarts and leaves attention open", async () => {
  const p = await preferences();
  p.softChime = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  await app.ready();
  note("demo");
  expect(await events()).toMatchObject([{ category: "decisions", text: "Choose the demo lane" }]);
  bus.emit("attention");
  expect(await events()).toHaveLength(1);
  expect((await app.inject("/api/attention")).json()).toMatchObject([{ acked: false }]);
  await app.close();
  store.close();
  store = new Store(join(dir, "mc.sqlite"));
  app = buildApp({ config, store, bus });
  await app.ready();
  bus.emit("attention");
  expect(await events()).toHaveLength(1);
  expect(await preferences()).toEqual(p);
});

it.each([
  ["2026-10-24T23:30:00Z", 0],
  ["2026-10-25T00:30:00Z", 0],
  ["2026-10-25T01:30:00Z", 0],
  ["2026-03-29T01:30:00Z", 0],
  ["2026-10-25T07:59:00Z", 0],
  ["2026-10-25T08:00:00Z", 1],
  ["2026-10-23T18:00:00Z", 0],
])("honours local midnight and DST at %s", async (time, count) => {
  vi.setSystemTime(new Date(time));
  await app.ready();
  note("demo");
  expect(await events()).toHaveLength(count);
  note("stall");
  expect(await events()).toHaveLength(count + 1);
});

it("filters disabled categories and enabled state without replaying suppressed items", async () => {
  const p = await preferences();
  p.categories.decisions = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("demo");
  expect(await events()).toEqual([]);
  p.categories.decisions = true;
  p.enabled = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("stall");
  expect(await events()).toEqual([]);
  p.enabled = true;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  bus.emit("attention");
  expect(await events()).toEqual([]);
});

it("emits a marked test with chime preference, invalidates and bounds the feed", async () => {
  const p = await preferences();
  p.softChime = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  const topics: string[] = [];
  const off = bus.subscribe((t) => topics.push(t));
  const response = await app.inject({
    method: "POST",
    url: "/api/notifications/test",
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ test: true, softChime: false, at: Date.now() });
  expect(topics).toContain("attention");
  for (let n = 0; n < 105; n++)
    await app.inject({ method: "POST", url: "/api/notifications/test", payload: {} });
  expect(await events()).toHaveLength(100);
  off();
});

it("notifies only above 90 percent and only once per quota crossing", async () => {
  const p = await preferences();
  p.categories.quota = true;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  for (const [index, pct] of [90, 91, 95, 89, 92].entries()) {
    store.addUsage({
      accountId: "demo",
      window: "5h",
      at: Date.now() + index,
      pct,
      resetAt: Date.now() + 100000,
      source: "demo",
    });
    bus.emit("limits");
    expect(await events()).toHaveLength([0, 1, 1, 1, 2][index]);
  }
});

it("includes every agent message when opted in, even without a direct ask", async () => {
  await app.close();
  const crewConfig: CcConfig = {
    ...config,
    crew: {
      worktrees: "/example",
      maxSeats: 1,
      sessions: [
        {
          id: "demo",
          repoId: "demo",
          checkout: "/example",
          seats: [{ id: "demo-seat", role: "FLIGHT", accountId: "demo", model: "opus", area: [] }],
        },
      ],
    },
  };
  app = buildApp({ config: crewConfig, store, bus });
  const p = await preferences();
  p.categories.agentMessages = true;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  store.addComms({
    at: Date.now(),
    from: "demo-seat",
    to: "CAPCOM",
    ticket: null,
    text: "Demo checks are complete",
  });
  bus.emit("agents");
  expect(await events()).toMatchObject([
    { category: "agentMessages", text: "Demo checks are complete" },
  ]);
  bus.emit("agents");
  expect(await events()).toHaveLength(1);
});

it("emits one away digest on return through settings invalidations", async () => {
  await app.ready();
  const away = {
    on: true,
    until: "",
    may: { pickUp: true, research: true, check: true, status: true, safePr: true },
  };
  await app.inject({ method: "POST", url: "/api/settings/away", payload: away });
  expect(await events()).toEqual([]);
  await app.inject({ method: "POST", url: "/api/settings/away", payload: { ...away, on: false } });
  expect(await events()).toMatchObject([{ category: "awayDigest" }]);
  bus.emit("settings");
  expect(await events()).toHaveLength(1);
});

it("supports same-day quiet windows and never replays suppressed transitions", async () => {
  const p = await preferences();
  p.quietHours = { ...p.quietHours, start: "12:00", end: "14:00", timezone: "UTC" };
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("quiet");
  expect(await events()).toEqual([]);
  vi.setSystemTime(new Date("2026-10-23T14:00:00Z"));
  bus.emit("attention");
  expect(await events()).toEqual([]);
  note("after");
  expect(await events()).toHaveLength(1);
  p.categories.stalls = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("stall");
  expect(await events()).toHaveLength(1);
  expect((await app.inject("/api/attention")).json()).toHaveLength(3);
});

it.each([
  [{ "content-type": "text/plain" }, "{}", 415],
  [{ origin: "https://evil.example" }, {}, 403],
] as const)("guards POST preference writes with %j", async (headers, payload, status) => {
  const p = await preferences();
  expect(
    (await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: "POST", url: "/api/notification-preferences", headers, payload }))
      .statusCode,
  ).toBe(status);
  expect(await preferences()).toEqual(p);
});

it("notifies again when a cleared stall reopens between reconciliations", async () => {
  await app.ready();
  note("stall");
  expect(await events()).toHaveLength(1);
  store.clearNote("stall", Date.now());
  vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
  note("stall");
  expect(await events()).toHaveLength(2);
  bus.emit("attention");
  expect(await events()).toHaveLength(2);
});
