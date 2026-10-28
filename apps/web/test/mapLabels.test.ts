import type { ConfigView, Crew } from "@mc/core";
import { describe, expect, it } from "vitest";
import { declutter, type LabelBox, labelKind } from "../src/map/labels.ts";
import { defaultMapRepo, mapRepoOptions } from "../src/map/repos.ts";
import { crewRow } from "./fixtures.ts";

const box = (over: Partial<LabelBox>): LabelBox => ({
  x: 100,
  y: 100,
  w: 60,
  h: 14,
  rank: 0,
  nudge: false,
  ...over,
});
const overlap = (a: LabelBox & { y: number }, b: LabelBox & { y: number }) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

describe("declutter", () => {
  it("never lets two shown labels overlap: the better rank keeps its place", () => {
    const boxes = [
      box({ rank: 3, nudge: false }),
      box({ rank: 0, nudge: false, x: 110 }),
      box({ rank: 1, nudge: true, x: 90 }),
    ];
    const placed = declutter(boxes, 800, 600);
    expect(placed[1]).toEqual({ x: 110, y: 100, hidden: false, lift: 0 });
    expect(placed[0]?.hidden).toBe(true);
    // the nudgeable label moves up a row, with its lift for the leader line
    expect(placed[2]).toEqual({ x: 90, y: 84, hidden: false, lift: 16 });
    const shown = boxes
      .map((b, i) => ({ ...b, y: placed[i]?.y ?? b.y, hidden: placed[i]?.hidden }))
      .filter((b) => !b.hidden);
    for (const a of shown) for (const b of shown) if (a !== b) expect(overlap(a, b)).toBe(false);
  });

  it("hides a label off the stage and one with no free row left", () => {
    const stack = Array.from({ length: 6 }, () => box({ rank: 2, nudge: true }));
    const placed = declutter(stack, 800, 600, 2, 3);
    expect(placed.filter((p) => !p.hidden)).toHaveLength(4);
    expect(declutter([box({ x: -200 })], 800, 600)[0]?.hidden).toBe(true);
    // a label that may move slides in from the edge instead of being cut off
    expect(declutter([box({ x: 790, nudge: true })], 800, 600)[0]).toEqual({
      x: 766,
      y: 100,
      hidden: false,
      lift: 0,
    });
  });

  it("knows each overlay label kind and leaves the rings on their nodes", () => {
    expect(labelKind("map-orb-label")).toEqual({ rank: 0, nudge: true });
    expect(labelKind("map-change map-edited")).toEqual({ rank: 4, nudge: true });
    expect(labelKind("map-area")).toEqual({ rank: 2, nudge: false });
    expect(labelKind("map-ring faint")).toBeNull();
    // finding and conflict marks are never hidden by a label
    expect(labelKind("map-mark")).toBeNull();
  });
});

describe("map repos", () => {
  const config = {
    crew: {
      sessions: [
        {
          id: "s",
          repoId: "app",
          seats: [
            { id: "a", loop: "build" },
            { id: "f", loop: "watch" },
            { id: "r", loop: "build", retiring: true },
          ],
        },
      ],
    },
    loops: [{ repoId: "loop-only" }],
  } as unknown as ConfigView;
  const repos = [{ id: "loop-only" }, { id: "app" }, { id: "bare" }] as never[];

  it("maps only repos with a crew session and says why the others are not", () => {
    expect(mapRepoOptions(repos, config, undefined)).toEqual([
      {
        id: "loop-only",
        seats: 0,
        mapped: false,
        label: "loop-only · observed loop, not mapped yet",
      },
      { id: "app", seats: 1, mapped: true, label: "app · 1 crew seat" },
      { id: "bare", seats: 0, mapped: false, label: "bare · no crew session" },
    ]);
    const crew = {
      rows: [
        crewRow({ id: "x", kind: "crew", repoId: "app" }),
        crewRow({ id: "y", kind: "crew", repoId: "app" }),
        crewRow({ id: "FLIGHT", kind: "crew", role: "FLIGHT", repoId: "app" }),
      ],
    } as Crew;
    expect(mapRepoOptions(repos, config, crew)[1]?.label).toBe("app · 2 crew seats");
  });

  it("goes to the session's repo, else the busiest, the last picked or the first mapped", () => {
    const options = mapRepoOptions(
      [{ id: "a" }, { id: "b" }, { id: "c" }] as never[],
      {
        crew: { sessions: ["a", "b"].map((repoId) => ({ id: repoId, repoId, seats: [] })) },
        loops: [],
      } as unknown as ConfigView,
      undefined,
    );
    expect(defaultMapRepo(options, undefined, "all", "")).toBe("a");
    expect(defaultMapRepo(options, undefined, "all", "b")).toBe("b");
    expect(defaultMapRepo(options, undefined, "b", "a")).toBe("b");
    expect(defaultMapRepo(options, undefined, "c", "")).toBe("a");
    const busy = {
      rows: [crewRow({ kind: "crew", repoId: "b", hudState: "running" })],
    } as Crew;
    expect(defaultMapRepo(options, busy, "all", "a")).toBe("b");
    expect(defaultMapRepo([], undefined, "all", "")).toBeNull();
  });
});
