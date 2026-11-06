import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PACE, eligibleToStart, PACE_SETTING, type PaceSettings, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { activePace, paceStartCheck, paceView, readPaceSettings } from "../src/pace.ts";
import { Store } from "../src/store.ts";

const CONFIG = {
  crew: { sessions: [{ seats: [{ id: "guido-1" }, { id: "guido-2" }] }] },
} as unknown as CcConfig;
let dir: string;
let store: Store;
const T0 = Date.parse("2026-11-07T09:00:00Z");
const END = Date.parse("2026-11-09T06:00:00Z");
const WEEKEND: PaceSettings = {
  on: true,
  until: END,
  since: T0,
  labels: ["bug"],
  maxStarts: 2,
  note: "weekend",
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-pace-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const runFor = (ticket: string, at: number, reviewId: number | null = null): Run => ({
  id: `r-${ticket}-${at}`,
  agentId: "guido-1",
  repoId: "mc",
  seq: at,
  startedAt: at,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket,
  reviewId,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
});
const start = (ticket: string, at: number, reviewId: number | null = null) =>
  store.upsertRun(runFor(ticket, at, reviewId));
const card = (labels: string[]) => ({
  labels,
  assignees: [],
  blockedBy: [],
  size: "S",
  status: "Ready",
  state: "planned" as const,
  closed: false,
});
const gate = (labels: string[], now: number) =>
  eligibleToStart({
    repoId: "mc",
    issue: 9,
    card: card(labels),
    rules: { areas: {}, needs: [], templates: {} },
    seat: { call: "GUIDO-1", area: [], loop: "build" },
    login: null,
    hasRun: false,
    lane: undefined,
    laneDefault: false,
    body: null,
    closed: () => undefined,
    ...(paceStartCheck(store, CONFIG, now) ? { pace: paceStartCheck(store, CONFIG, now) } : {}),
  });

it("with no setting, no seat is held for pace", () => {
  expect(readPaceSettings(store)).toEqual(DEFAULT_PACE);
  expect(activePace(store, T0)).toBeNull();
  expect(paceStartCheck(store, CONFIG, T0)).toBeUndefined();
  expect(paceView(store, CONFIG, T0)).toBeNull();
  expect(gate(["feature"], T0)).toBeNull();
});

it("a corrupt row is normal, not a slowdown nobody asked for", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  store.setSetting(PACE_SETTING, "{");
  expect(activePace(store, T0)).toBeNull();
  expect(gate(["feature"], T0)).toBeNull();
});

it("in the slow mode only matching tickets start, and at the end time normal resumes", () => {
  store.setSetting(PACE_SETTING, JSON.stringify(WEEKEND));
  expect(gate(["bug"], T0 + 1)).toBeNull();
  expect(gate(["feature"], T0 + 1)).toMatch(/weekend/);
  expect(paceView(store, CONFIG, T0 + 1)).toMatchObject({
    note: "weekend",
    until: END,
    startsLeft: 2,
  });
  expect(gate(["feature"], END)).toBeNull();
  expect(paceView(store, CONFIG, END)).toBeNull();
});

it("holds starts once the allowed number have started since it was set, counting tickets not reviews", () => {
  store.setSetting(PACE_SETTING, JSON.stringify(WEEKEND));
  start("mc#1", T0 - 5); // before it was set
  start("mc#2", T0 + 10);
  start("mc#2", T0 + 20); // the same ticket again
  start("mc#3", T0 + 30, 4); // a review of someone's work
  expect(paceView(store, CONFIG, T0 + 40)?.startsLeft).toBe(1);
  start("mc#5", T0 + 50);
  expect(gate(["bug"], T0 + 60)).toMatch(/no starts left/);
  expect(gate(["bug"], END)).toBeNull();
});

it("observed loops' runs and a ticket started before the pace do not use up its starts", () => {
  store.setSetting(PACE_SETTING, JSON.stringify({ ...WEEKEND, maxStarts: 1 }));
  store.upsertRun({ ...runFor("shop-app#44", T0 + 5), id: "ta", agentId: "shop-app-ta" });
  start("mc#1", T0 - 5); // started before the pace ...
  start("mc#1", T0 + 6); // ... and handed to a seat during it
  expect(paceView(store, CONFIG, T0 + 10)?.startsLeft).toBe(1);
  start("mc#2", T0 + 20);
  expect(paceView(store, CONFIG, T0 + 30)?.startsLeft).toBe(0);
});
