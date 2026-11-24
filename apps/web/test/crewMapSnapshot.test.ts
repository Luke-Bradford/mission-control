import type { CrewRow } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  CAPCOM,
  crewMapSnapshot,
  DEFAULT_CONTEXT_LIMIT,
  type OpenItem,
} from "../src/comms/crewMapSnapshot.ts";
import { seatRow } from "./fixtures.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const rows = [
  seatRow({ id: "flight-1", role: "FLIGHT" }),
  seatRow({ id: "guido-1" }),
  seatRow({ id: "inco-1", role: "INCO", area: ["apps/web/**"] }),
];
const ask = (id: string, from: string, to: string, waitedMs: number): OpenItem => ({
  id,
  label: "question",
  from,
  to,
  ticket: null,
  waitedMs,
});
const build = (over: Partial<Parameters<typeof crewMapSnapshot>[0]> = {}) =>
  crewMapSnapshot({ rows, flightId: "flight-1", feed: [], open: [], now: NOW, ok: true, ...over });
const digest = (over: Partial<NonNullable<CrewRow["digest"]>>) =>
  ({
    minuteTokens: [],
    contextTokens: null,
    contextWindow: null,
    liveTool: null,
    ...over,
  }) as CrewRow["digest"];

describe("the map's picture of the crew", () => {
  it("draws only the hub's crew, the operator and the hub: no made-up seats", () => {
    const snap = build();
    expect(snap.participants.map((p) => p.id)).toEqual([
      "flight-1",
      "guido-1",
      "inco-1",
      CAPCOM,
      "MC",
    ]);
    expect(snap.participants.find((p) => p.id === CAPCOM)?.state).toBe("nodata");
    expect(build({ rows: [] }).participants.map((p) => p.id)).toEqual([CAPCOM, "MC"]);
  });

  it("gives each seat its role from the config, not from its name", () => {
    const roles = Object.fromEntries(build().participants.map((p) => [p.id, p.role]));
    expect(roles).toMatchObject({ "flight-1": "flight", "guido-1": "server", "inco-1": "web" });
  });

  it("tells running, idle and stopped apart, and names a stuck seat instead of calling it stopped", () => {
    const states = (hud: CrewRow["hudState"], extra: Partial<CrewRow> = {}) => {
      const p = build({ rows: [seatRow({ id: "guido-1", hudState: hud, ...extra })] })
        .participants[0];
      return { state: p?.state, hold: p?.hold };
    };
    expect(states("running")).toEqual({ state: "running", hold: null });
    expect(states("idle")).toEqual({ state: "idle", hold: null });
    expect(states("stopped")).toEqual({ state: "stopped", hold: null });
    expect(states("running", { paused: true })).toEqual({ state: "stopped", hold: null });
    expect(states("blocked")).toEqual({ state: "idle", hold: "blocked" });
    expect(states("stalled")).toEqual({ state: "idle", hold: "stalled" });
    expect(states("error")).toEqual({ state: "idle", hold: "error" });
  });

  it("measures each seat's context against its own window, else the 150K fallback", () => {
    const snap = build({
      rows: [
        seatRow({
          id: "guido-1",
          digest: digest({
            contextTokens: 90_000,
            contextWindow: 200_000,
            liveTool: { name: "Edit", since: NOW },
          }),
        }),
        seatRow({ id: "guido-2", digest: digest({ contextTokens: 40_000 }) }),
      ],
    });
    const [a, b] = snap.participants;
    expect(a).toMatchObject({ contextTokens: 90_000, contextLimit: 200_000, liveTool: "Edit" });
    expect(b).toMatchObject({ contextTokens: 40_000, contextLimit: null });
    expect(snap.contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it("sums the crew's tokens per minute over the last hour", () => {
    const minute = Math.floor(NOW / MIN) * MIN;
    const snap = build({
      rows: [
        seatRow({
          id: "guido-1",
          digest: digest({
            minuteTokens: [
              [minute, 100],
              [minute - 5 * MIN, 50],
            ],
          }),
        }),
        seatRow({
          id: "guido-2",
          digest: digest({
            minuteTokens: [
              [minute, 25],
              [minute - 2 * HOUR, 999],
            ],
          }),
        }),
      ],
    });
    const series = snap.history?.tokensPerMinute ?? [];
    expect(series).toHaveLength(60);
    expect(series.at(-1)).toEqual([minute, 125]);
    expect(series.find(([m]) => m === minute - 5 * MIN)?.[1]).toBe(50);
    expect(series.reduce((n, [, t]) => n + t, 0)).toBe(175);
  });

  it("carries the feed in time order, with the old FLIGHT address on the configured seat", () => {
    const snap = build({
      feed: [
        { id: "comms:2", from: "guido-1", to: "FLIGHT", at: NOW - 1000, text: "b" },
        { id: "comms:1", from: CAPCOM, to: "guido-1", at: NOW - 2000, text: "a" },
        { id: "comms:3", from: "guido-1", to: "crew", at: NOW, text: "everyone" },
        { id: "comms:4", from: "ghost-9", to: "guido-1", at: NOW, text: "unknown seat" },
      ],
    });
    expect(snap.messages.map((m) => [m.id, m.from, m.to])).toEqual([
      ["comms:1", CAPCOM, "guido-1"],
      ["comms:2", "guido-1", "flight-1"],
    ]);
  });

  it("says the hub is not answering when the last read failed, keeping the picture", () => {
    expect(build({ ok: false }).source).toMatchObject({
      ok: false,
      error: "The hub is not answering.",
    });
    expect(build().source.ok).toBe(true);
  });
});

describe("who owes a reply", () => {
  it("counts an ask under a day old as owed, and the exact 24-hour mark as older", () => {
    const snap = build({
      open: [
        ask("a", "guido-1", "flight-1", DAY - 1),
        ask("b", "guido-1", "flight-1", DAY),
        ask("c", "guido-1", "flight-1", DAY + 3 * HOUR),
      ],
    });
    expect(snap.waits.map((w) => w.id)).toEqual(["a"]);
    expect(snap.olderWaits).toBe(2);
    expect(snap.olderWaitsOldest).toBe(NOW - (DAY + 3 * HOUR));
  });

  it("keeps two asks in the same direction, and one each way", () => {
    const same = build({
      open: [ask("a", "guido-1", "flight-1", HOUR), ask("b", "guido-1", "flight-1", 2 * HOUR)],
    });
    expect(same.waits.map((w) => [w.from, w.to])).toEqual([
      ["guido-1", "flight-1"],
      ["guido-1", "flight-1"],
    ]);
    const cross = build({
      open: [ask("a", "guido-1", "flight-1", HOUR), ask("b", "flight-1", "guido-1", HOUR)],
    });
    expect(cross.waits.map((w) => [w.from, w.to])).toEqual([
      ["guido-1", "flight-1"],
      ["flight-1", "guido-1"],
    ]);
  });

  it("keeps the young ask amber when the pair also has an older one", () => {
    const snap = build({
      open: [ask("old", "guido-1", "flight-1", 3 * DAY), ask("young", "guido-1", "flight-1", HOUR)],
    });
    expect(snap.waits.map((w) => w.id)).toEqual(["young"]);
    expect(snap.olderWaits).toBe(1);
  });

  it("dates the ask from now, and reaches the follow-up the hub makes", () => {
    const [wait] = build({ open: [ask("a", "guido-1", "FLIGHT", 5 * MIN)] }).waits;
    expect(wait).toMatchObject({ from: "guido-1", to: "flight-1", since: NOW - 5 * MIN });
    expect(wait?.followUpAt).toBe(NOW + 10 * MIN);
  });
});
