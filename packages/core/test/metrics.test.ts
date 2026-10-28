import { describe, expect, it } from "vitest";
import {
  CYCLE_TIME_DAYS,
  cycleTimeDetail,
  formatHours,
  isAgentBlocked,
  isAgentLive,
  isAgentWorking,
  METRIC_IDS,
  METRICS,
  type MetricRow,
  type MetricsView,
  metricHover,
  metricLabel,
  metricReadings,
  percentile,
} from "../src/index.ts";

const HOUR = 3_600_000;
const row = (extra: Partial<MetricRow> = {}): MetricRow => ({
  hudState: "idle",
  paused: false,
  crewPause: null,
  loop: null,
  run: null,
  kind: "crew",
  sessionId: "s1",
  repoId: "repo",
  note: null,
  ...extra,
});
const VIEW: MetricsView = {
  at: 0,
  inProgress: { count: 6, oldestAt: null },
  merged: { count: 3, loops: 0 },
  cycleTime: { p50Ms: 14.9 * HOUR, p85Ms: 31.2 * HOUR, n: 12, excluded: 1 },
  cost: { usd: 12.345 },
};

describe("metric registry", () => {
  it("defines every figure once with a label, window, unit, definition and source", () => {
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) {
      const m = METRICS[id];
      for (const field of [m.label, m.window, m.unit, m.definition, m.source])
        expect(field.length, id).toBeGreaterThan(0);
      expect(metricLabel(id)).toBe(`${m.label} · ${m.window}`);
      expect(metricHover(id)).toContain(m.definition);
    }
    expect(metricLabel("merged")).toBe("Merged · 24h");
    expect(metricLabel("cycleTime")).toBe(`Cycle time p50 · ${CYCLE_TIME_DAYS}d`);
    expect(CYCLE_TIME_DAYS).toBe(14);
    expect(METRICS.cycleTime.unit).toBe("hours");
    // Needs you is the web's needsYouItems, not a second definition.
    expect(METRICS.needsYou.source).toContain("needsYouItems");
  });

  it("interpolates percentiles between ranks; p50 is the median", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 85)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 85)).toBeCloseTo(4.4);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
  });

  it("shows hours, one decimal under ten", () => {
    expect(formatHours(0.4 * HOUR)).toBe("0.4 h");
    expect(formatHours(9.94 * HOUR)).toBe("9.9 h");
    expect(formatHours(14.6 * HOUR)).toBe("15 h");
    // no "10.0 h": what rounds to ten reads as the whole hours above it
    expect(formatHours(9.96 * HOUR)).toBe("10 h");
    expect(formatHours(10.4 * HOUR)).toBe("10 h");
  });

  it("classifies agents: blocked is crew only; live is able to take work", () => {
    expect(isAgentWorking(row({ hudState: "running" }))).toBe(true);
    expect(isAgentLive(row({ hudState: "running" }))).toBe(true);
    expect(isAgentLive(row({ hudState: "idle" }))).toBe(true);
    const pausedLoop = row({ kind: "loop", hudState: "parked", paused: true });
    expect(isAgentLive(pausedLoop)).toBe(false);
    expect(isAgentBlocked(pausedLoop)).toBe(false);
    // an observed loop's hold is in Needs you, not Blocked; it cannot take work either
    const heldLoop = row({ kind: "loop", hudState: "blocked" });
    expect(isAgentBlocked(heldLoop)).toBe(false);
    expect(isAgentLive(heldLoop)).toBe(false);
    const crewPaused = row({ crewPause: { seats: "all", reason: "r", at: 0, by: "op" } });
    expect(isAgentLive(crewPaused)).toBe(false);
    expect(isAgentLive(row({ hudState: "stopped" }))).toBe(false);
    for (const hudState of ["blocked", "stalled", "error", "parked"] as const) {
      expect(isAgentBlocked(row({ hudState })), hudState).toBe(true);
      expect(isAgentLive(row({ hudState })), hudState).toBe(false);
    }
    expect(isAgentBlocked(row({ hudState: "waiting" }))).toBe(false);
    const openRun = { id: "r", seq: 1, startedAt: 0, endedAt: null } as MetricRow["run"];
    const parkedLoop = { phase: "parked", text: "", prNumber: null, parked: "why" } as const;
    const loopParked = row({ hudState: "idle", loop: parkedLoop, run: openRun });
    expect(isAgentBlocked(loopParked)).toBe(true);
    expect(isAgentLive(loopParked)).toBe(false);
    // a rate-limit park resumes by itself: not blocked, and not live until it does
    const limited = row({ hudState: "parked", note: "rate limited until 14:00" });
    expect(isAgentBlocked(limited)).toBe(false);
    expect(isAgentLive(limited)).toBe(false);
    expect(
      isAgentBlocked(
        row({ loop: { ...parkedLoop, parked: "Rate-limited until 14:00" }, run: openRun }),
      ),
    ).toBe(false);
  });

  it("states p85 only from five tickets, and what was left out", () => {
    const ct = { p50Ms: HOUR, p85Ms: 31.2 * HOUR, n: 4, excluded: 0 };
    expect(cycleTimeDetail(ct)).toBe("4 tickets");
    expect(cycleTimeDetail({ ...ct, n: 5, excluded: 3 })).toBe("p85 31 h · 5 tickets · 3 left out");
    expect(cycleTimeDetail({ ...ct, n: 1, excluded: 1 })).toBe("1 ticket · 1 left out");
  });

  it("reads every figure from its sources, null while a source loads", () => {
    const loading = metricReadings({ view: undefined, rows: undefined, needsYou: undefined });
    for (const id of METRIC_IDS) expect(loading[id], id).toBeNull();
    const r = metricReadings({
      view: VIEW,
      rows: [
        row({ hudState: "running" }),
        row({ hudState: "blocked" }),
        row({ kind: "loop", hudState: "parked", paused: true }),
      ],
      needsYou: 13,
    });
    expect(r.inProgress?.value).toBe("6");
    expect(r.merged?.value).toBe("3");
    expect(r.cycleTime).toEqual({
      value: "15 h",
      n: 14.9 * HOUR,
      detail: "p85 31 h · 12 tickets · 1 left out",
    });
    expect(r.needsYou?.value).toBe("13");
    expect(r.blocked?.value).toBe("1");
    expect(r.merged?.detail).toBeNull();
    expect(r.agentsWorking).toEqual({ value: "1", n: 1, detail: "of 3 agents" });
    // the blocked seat and the paused loop cannot take work
    expect(r.agentsLive).toEqual({ value: "1", n: 1, detail: "of 3 agents" });
    expect(r.cost?.value).toBe("~$12.35");
    const loops = metricReadings({
      view: { ...VIEW, merged: { count: 3, loops: 4 } },
      rows: [],
      needsYou: 0,
    });
    expect(loops.merged).toEqual({ value: "3", n: 3, detail: "+4 loops" });
    const none = metricReadings({
      view: {
        ...VIEW,
        cycleTime: { p50Ms: null, p85Ms: null, n: 0, excluded: 0 },
        cost: { usd: null },
      },
      rows: [],
      needsYou: 0,
    });
    expect(none.cycleTime).toEqual({ value: "—", n: null, detail: "no tickets done" });
    expect(none.cost).toEqual({ value: "—", n: null, detail: null });
  });
});
