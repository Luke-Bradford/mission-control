import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLIGHT_DOWN_NOTE_KEY, FLIGHT_NOTE_KEY, type NotificationCategory } from "@mc/core";
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
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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
const events = async () => {
  await app.ready();
  await vi.advanceTimersByTimeAsync(1000);
  return (await app.inject("/api/notifications/events")).json();
};
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
/** An item FLIGHT has briefed for the operator: the default notification. */
const ask = (key: string, question = "Which lane should the demo take?") => {
  note(key);
  store.addBrief({
    key: `note:${key}`,
    context: "The demo needs a lane.",
    ask: question,
    recommendation: "Take lane A.",
    options: [],
    basis: "product direction",
    at: Date.now(),
    for: "operator",
  });
  bus.emit("attention");
};
/** One of the notes that say FLIGHT is down, as the FLIGHT watch raises it. */
const flightDown = (key: string, text: string) => {
  store.raiseNote({
    key,
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text,
    at: Date.now(),
  });
  bus.emit("attention");
};
/** Turn on categories that are opt-in. */
const optIn = async (...categories: NotificationCategory[]) => {
  const p = await preferences();
  for (const c of categories) p.categories[c] = true;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  return p;
};

it("defaults to briefed asks, FLIGHT down and the away digest, and validates guarded writes", async () => {
  expect(await preferences()).toEqual({
    enabled: true,
    softChime: true,
    categories: {
      asks: true,
      flightDown: true,
      people: false,
      decisions: false,
      stalls: false,
      prs: false,
      capcom: false,
      awayDigest: true,
      quota: false,
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
  ask("demo");
  expect(await events()).toMatchObject([
    { category: "asks", text: "Which lane should the demo take?" },
  ]);
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
  await optIn("stalls");
  ask("demo");
  expect(await events()).toHaveLength(count);
  note("stall");
  expect(await events()).toHaveLength(count + 1);
});

it("filters disabled categories and enabled state without replaying suppressed items", async () => {
  const p = await optIn("stalls");
  p.categories.asks = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  ask("demo");
  expect(await events()).toEqual([]);
  p.categories.asks = true;
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
  const resetAt = Date.now() + 100000;
  for (const [index, pct] of [90, 91, 95, 89, 92].entries()) {
    store.addUsage({
      accountId: "demo",
      window: "5h",
      at: Date.now() + index,
      pct,
      resetAt,
      source: "demo",
    });
    bus.emit("limits");
    expect(await events()).toHaveLength([0, 1, 1, 1, 2][index]);
  }
});

it("notifies FLIGHT's @CAPCOM question, not direct-line narration, with @CAPCOM opted in", async () => {
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
  p.categories.capcom = true;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  store.addComms({
    at: Date.now() - 1,
    from: "CAPCOM",
    to: "demo-seat",
    ticket: null,
    text: "Status?",
  });
  store.addComms({
    at: Date.now(),
    from: "demo-seat",
    to: "CAPCOM",
    ticket: null,
    text: "Demo checks are complete",
  });
  store.addComms({
    at: Date.now(),
    from: "demo-seat",
    to: "peer",
    ticket: null,
    text: "@CAPCOM nothing needs you",
  });
  bus.emit("agents");
  // messages are not Needs you: narration and FLIGHT's summaries raise nothing to notify
  expect(await events()).toEqual([]);
  store.addComms({
    at: Date.now(),
    from: "demo-seat",
    to: "peer",
    ticket: null,
    text: "@CAPCOM review this?",
  });
  bus.emit("agents");
  expect(await events()).toMatchObject([{ category: "capcom", text: "@CAPCOM review this?" }]);
  bus.emit("agents");
  expect(await events()).toHaveLength(1);
  p.categories.capcom = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  store.addComms({
    at: Date.now(),
    from: "demo-seat",
    to: "peer",
    ticket: null,
    text: "@CAPCOM suppressed?",
  });
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

it("emits one digest when the away end date passes", async () => {
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/settings/away",
    payload: {
      on: true,
      until: "2026-10-23",
      may: { pickUp: true, research: true, check: true, status: true, safePr: true },
    },
  });
  expect(await events()).toEqual([]);
  vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
  bus.emit("settings");
  expect(await events()).toMatchObject([{ category: "awayDigest" }]);
  bus.emit("settings");
  expect(await events()).toHaveLength(1);
});

it("supports same-day quiet windows: an ask waits for them to end, nothing else replays", async () => {
  const p = await optIn("stalls", "decisions");
  p.quietHours = { ...p.quietHours, start: "12:00", end: "14:00", timezone: "UTC" };
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("raw");
  ask("quiet");
  expect(await events()).toEqual([]);
  vi.setSystemTime(new Date("2026-10-23T14:00:00Z"));
  bus.emit("attention");
  expect(await events()).toMatchObject([{ category: "asks" }]);
  bus.emit("attention");
  expect(await events()).toHaveLength(1);
  ask("after");
  expect(await events()).toHaveLength(2);
  p.categories.stalls = false;
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  note("stall");
  expect(await events()).toHaveLength(2);
  expect((await app.inject("/api/attention")).json()).toHaveLength(4);
});

it("notifies FLIGHT down through quiet hours", async () => {
  const p = await preferences();
  p.quietHours = { ...p.quietHours, start: "12:00", end: "14:00", timezone: "UTC" };
  await app.inject({ method: "POST", url: "/api/notification-preferences", payload: p });
  flightDown(FLIGHT_DOWN_NOTE_KEY, "FLIGHT is down: it is parked");
  expect(await events()).toMatchObject([{ category: "flightDown" }]);
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
  await optIn("stalls");
  note("stall");
  expect(await events()).toHaveLength(1);
  store.clearNote("stall", Date.now());
  vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
  note("stall");
  expect(await events()).toHaveLength(2);
  bus.emit("attention");
  expect(await events()).toHaveLength(2);
});

it("coalesces all notification topics off requests, runs at startup and keeps the trailing change", async () => {
  await app.ready();
  const attention = vi.mocked(hud.attentionItems);
  expect(attention).not.toHaveBeenCalled();
  await app.inject("/api/notifications/events");
  expect(attention).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(attention).toHaveBeenCalledTimes(1);
  for (const topic of [
    "attention",
    "agents",
    "limits",
    "boards",
    "escalations",
    "settings",
  ] as const)
    bus.emit(topic);
  await vi.advanceTimersByTimeAsync(999);
  expect(attention).toHaveBeenCalledTimes(1);
  ask("last");
  await vi.advanceTimersByTimeAsync(1);
  expect(attention).toHaveBeenCalledTimes(2);
  expect((await app.inject("/api/notifications/events")).json()).toMatchObject([
    { category: "asks", text: "Which lane should the demo take?" },
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(attention).toHaveBeenCalledTimes(2);
  bus.emit("agents");
  await app.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(attention).toHaveBeenCalledTimes(2);
});

it("notifies a briefed ask and FLIGHT going down, not stalls, PRs, blocked runs or raw asks", async () => {
  await app.ready();
  note("stall");
  store.raiseNote({
    key: "blocked:r1:0",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "mc#7 parked",
    at: Date.now(),
  });
  store.raiseNote({
    key: "review:r2",
    kind: "review",
    runId: null,
    seatId: null,
    repoId: null,
    text: "PR #9 is ready for review",
    at: Date.now(),
  });
  note("raw");
  bus.emit("attention");
  expect(await events()).toEqual([]);
  // FLIGHT's own triage (a brief for FLIGHT) is not an ask of the operator
  store.addBrief({
    key: "note:raw",
    context: "c",
    recommendation: "r",
    options: [],
    basis: "b",
    at: Date.now(),
    for: "flight",
  });
  bus.emit("attention");
  expect(await events()).toEqual([]);
  // the same item, once FLIGHT briefs it for the operator, is a new ask
  ask("raw", "Ship the demo lane today?");
  expect(await events()).toMatchObject([{ category: "asks", text: "Ship the demo lane today?" }]);
  // a refreshed brief with the same ask does not notify again; a changed ask does
  ask("raw", "Ship the demo lane today?");
  expect(await events()).toHaveLength(1);
  ask("raw", "Ship the demo lane tomorrow instead?");
  expect(await events()).toHaveLength(2);
  store.raiseNote({
    key: FLIGHT_NOTE_KEY,
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "FLIGHT could not be kept running",
    at: Date.now(),
  });
  bus.emit("attention");
  expect((await events()).slice(2)).toMatchObject([
    { category: "flightDown", text: "FLIGHT could not be kept running" },
  ]);
});

it("keeps an opt-in for stalls, PRs, blocked runs and raw decisions", async () => {
  await optIn("stalls", "prs", "decisions");
  note("stall");
  note("raw");
  store.raiseNote({
    key: "review:r2",
    kind: "review",
    runId: null,
    seatId: null,
    repoId: null,
    text: "PR #9 is ready for review",
    at: Date.now(),
  });
  bus.emit("attention");
  expect((await events()).map((e: { category: string }) => e.category).sort()).toEqual([
    "decisions",
    "prs",
    "stalls",
  ]);
});

it("resets categories saved before briefed asks, keeping the operator's own opt-ins and settings", async () => {
  const old = {
    enabled: false,
    categories: {
      people: true,
      decisions: true,
      stalls: true,
      prs: true,
      capcom: true,
      awayDigest: true,
      quota: true,
      agentMessages: false,
    },
    quietHours: { start: "20:00", end: "07:00", timezone: "UTC", stallsBypass: true },
    softChime: false,
  };
  store.setSetting("notification-preferences", JSON.stringify(old));
  const p = await preferences();
  expect(p).toMatchObject({
    enabled: false,
    softChime: false,
    quietHours: { start: "20:00", end: "07:00", timezone: "UTC" },
  });
  expect(Object.entries(p.categories).filter(([, on]) => on)).toEqual([
    ["asks", true],
    ["flightDown", true],
    ["awayDigest", true],
    ["quota", true],
  ]);
});

it("keeps an away-digest opt-out saved before briefed asks", async () => {
  store.setSetting(
    "notification-preferences",
    JSON.stringify({
      enabled: true,
      categories: {
        people: true,
        decisions: true,
        stalls: true,
        prs: true,
        capcom: true,
        awayDigest: false,
        quota: false,
        agentMessages: false,
      },
      quietHours: { start: "19:00", end: "08:00", timezone: "UTC", stallsBypass: true },
      softChime: true,
    }),
  );
  expect(Object.entries((await preferences()).categories).filter(([, on]) => on)).toEqual([
    ["asks", true],
    ["flightDown", true],
  ]);
});

it("keeps saved choices across a category added or removed later", async () => {
  store.setSetting(
    "notification-preferences",
    JSON.stringify({
      enabled: true,
      categories: { asks: false, people: true, awayDigest: false, retired: true },
      quietHours: { start: "19:00", end: "08:00", timezone: "UTC", stallsBypass: true },
      softChime: true,
    }),
  );
  const { categories } = await preferences();
  expect(categories).toMatchObject({
    asks: false,
    people: true,
    awayDigest: false,
    flightDown: true,
    stalls: false,
  });
  expect(categories).not.toHaveProperty("retired");
});

it("reads unparseable saved preferences as the defaults", async () => {
  store.setSetting("notification-preferences", "{not json");
  expect((await preferences()).categories.asks).toBe(true);
  ask("demo");
  expect(await events()).toMatchObject([{ category: "asks" }]);
});

it("notifies a new or changed ask on an item the operator already read", async () => {
  await app.ready();
  note("read");
  await app.inject({ method: "POST", url: "/api/attention/ack", payload: { keys: ["note:read"] } });
  vi.setSystemTime(new Date("2026-10-23T12:01:00Z"));
  ask("read", "Ship it today?");
  expect(await events()).toMatchObject([{ category: "asks", text: "Ship it today?" }]);
  expect((await app.inject("/api/attention")).json()[0].acked).toBe(false);
});

it("notifies each FLIGHT outage, even after the last one was read", async () => {
  await app.ready();
  flightDown(FLIGHT_NOTE_KEY, "FLIGHT could not be kept running: one");
  expect(await events()).toHaveLength(1);
  await app.inject({
    method: "POST",
    url: "/api/attention/ack",
    payload: { keys: [`note:${FLIGHT_NOTE_KEY}`] },
  });
  store.clearNote(FLIGHT_NOTE_KEY, Date.now());
  bus.emit("attention");
  await events();
  vi.setSystemTime(new Date("2026-10-23T13:00:00Z"));
  flightDown(FLIGHT_NOTE_KEY, "FLIGHT could not be kept running: two");
  expect((await events()).map((e: { text: string }) => e.text)).toEqual([
    "FLIGHT could not be kept running: one",
    "FLIGHT could not be kept running: two",
  ]);
});

it("counts FLIGHT down as FLIGHT down even with a brief on it", async () => {
  await app.ready();
  flightDown(FLIGHT_DOWN_NOTE_KEY, "FLIGHT is down: it is parked");
  store.addBrief({
    key: `note:${FLIGHT_DOWN_NOTE_KEY}`,
    context: "c",
    ask: "Unpark FLIGHT?",
    recommendation: "r",
    options: [],
    basis: "b",
    at: Date.now(),
    for: "operator",
  });
  bus.emit("attention");
  expect((await events()).map((e: { category: string }) => e.category)).toEqual(["flightDown"]);
});

it("adopts the new notification versions on Update without replaying open items", async () => {
  await app.close();
  ask("open");
  store.setSetting(
    "notification-events",
    JSON.stringify({
      seen: { "note:open": JSON.stringify(["question", "Choose the demo lane", Date.now()]) },
      events: [],
      away: false,
    }),
  );
  app = buildApp({ config, store, bus });
  expect(await events()).toEqual([]);
  ask("open", "A changed ask?");
  expect(await events()).toMatchObject([{ category: "asks", text: "A changed ask?" }]);
});
