import type { HealthRow } from "@mc/core";
import { describe, expect, it } from "vitest";
import { intervalText, labelSides, splitTimeline, upcoming } from "../src/flight/timeline.ts";
import { limit5h, limit7d, MIN, NOW } from "./fixtures.ts";

const repoIds = ["shop-app"];
const poll = { usageMinutes: 30, githubSeconds: 60 };
const h = (collector: string, at: number, over: Partial<HealthRow> = {}): HealthRow => ({
  collector,
  ok: true,
  error: null,
  at,
  lastOkAt: at,
  ...over,
});

describe("upcoming", () => {
  it("lists limit resets, the next board poll and the next usage read, soonest first", () => {
    const ev = upcoming({
      now: NOW,
      limits: [limit5h(), limit7d()],
      health: [h("github:shop-app", NOW - 20_000), h("usage:claude-main", NOW - 10 * MIN)],
      repoIds,
      poll,
    });
    expect(ev.map((e) => e.label)).toEqual([
      "Board and escalations poll (every 60 s)",
      "Usage read (every 30 min)",
      "claude-main 5h window resets",
      "codex-main 7d window resets",
    ]);
    expect(ev[0]?.at).toBe(NOW + 40_000);
    expect(ev[1]?.at).toBe(NOW + 20 * MIN);
  });

  it("uses the PR-less poll: the :prs sweep is not the board poll", () => {
    const ev = upcoming({
      now: NOW,
      limits: [],
      health: [
        h("github:shop-app", NOW - 30_000),
        h("github:shop-app:prs", NOW - 1000),
        h("github:other", NOW - 500),
      ],
      repoIds,
      poll,
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]?.at).toBe(NOW + 30_000);
  });

  it("takes the status time even while the collector is failing", () => {
    const ev = upcoming({
      now: NOW,
      limits: [],
      health: [
        h("usage:claude-main", NOW - MIN, {
          ok: false,
          error: "boom",
          lastOkAt: NOW - 3 * 60 * MIN,
        }),
      ],
      repoIds,
      poll,
    });
    expect(ev[0]?.at).toBe(NOW + 29 * MIN);
  });

  it("shows a poll that is overdue as now, and drops resets already past", () => {
    const ev = upcoming({
      now: NOW,
      limits: [limit5h({ resetAt: NOW - MIN })],
      health: [h("github:shop-app", NOW - 10 * MIN)],
      repoIds,
      poll,
    });
    expect(ev).toEqual([{ at: NOW, label: "Board and escalations poll (every 60 s)" }]);
  });

  it("formats intervals: 60 s stays seconds, 120 s and over is minutes", () => {
    expect(intervalText(60)).toBe("60 s");
    expect(intervalText(119)).toBe("119 s");
    expect(intervalText(120)).toBe("2 min");
    expect(intervalText(1800)).toBe("30 min");
  });

  it("has nothing for a source it has not seen", () => {
    expect(upcoming({ now: NOW, limits: [], repoIds, health: [], poll })).toEqual([]);
  });
});

describe("splitTimeline", () => {
  it("splits at 240 minutes, the boundary staying on the line", () => {
    const events = [
      { at: NOW + 239 * MIN, label: "a" },
      { at: NOW + 240 * MIN, label: "b" },
      { at: NOW + 241 * MIN, label: "c" },
    ];
    const { onLine, later } = splitTimeline(events, NOW);
    expect(onLine.map((e) => e.label)).toEqual(["a", "b"]);
    expect(later.map((e) => e.label)).toEqual(["c"]);
  });
});

describe("labelSides", () => {
  // `n` events with short labels at the given fractions of a 1000 px line
  const ev = (fracs: number[], chars = 12) => fracs.map((frac) => ({ frac, chars }));

  it("alternates above and below the line when the labels have room", () => {
    expect(labelSides(ev([0.2, 0.4, 0.6, 0.8]), 1000)).toEqual(["up", "dn", "up", "dn"]);
  });

  it("hangs a label below when its marker is next to `now`, whose word sits above the line", () => {
    expect(labelSides(ev([0.005, 0.3, 0.5]), 1000)).toEqual(["dn", "up", "dn"]);
  });

  it("puts a label on whichever side is clear, and none where neither is (the Next line lists it)", () => {
    // 01:10 poll, 01:20 usage read, 01:30 another, all long labels, close together on 1150 px
    expect(labelSides(ev([0.01, 0.04, 0.06], 45), 1150)).toEqual(["dn", "up", "none"]);
  });

  it("a label hanging left of a marker near the end is checked by where it starts", () => {
    // from 0.7 a label hangs left of its marker: 0.95's starts at 770, clear of 0.75's below (to 760)
    expect(labelSides(ev([0.6, 0.75, 0.95], 30), 1000)).toEqual(["up", "dn", "dn"]);
    expect(labelSides(ev([0.6, 0.72, 0.74], 45), 400)).toEqual(["up", "dn", "none"]);
  });
});
