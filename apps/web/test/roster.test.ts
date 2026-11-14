import type { RunDigest } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  contextShown,
  hourMarks,
  rosterGroups,
  seatClass,
  shortAge,
  stepRoster,
  workLine,
} from "../src/agent/roster.ts";
import { crewRow, HOUR, MIN, NOW, seatRow } from "./fixtures.ts";

const digest = (over: Partial<RunDigest> = {}): RunDigest => ({
  toolCalls: 37,
  turns: 21,
  lastEventAt: NOW - MIN,
  model: "claude-opus-4-1",
  contextTokens: 150_000,
  contextWindow: 200_000,
  liveTool: null,
  tools: {},
  subagents: [],
  minuteTokens: [],
  turnUsage: [],
  background: [],
  compactions: 0,
  ...over,
});

const dev = (id: string, repoId = "shop-app", over = {}) =>
  seatRow({ id, repoId, mode: "writer", role: "GUIDO", ...over });
const planner = (id: string, repoId = "shop-app") =>
  seatRow({ id, repoId, mode: "read-only", role: "FAO" });
const reviewer = (id: string, repoId = "shop-app") =>
  seatRow({ id, repoId, mode: "read-only", role: "RETRO" });
const flight = (id: string, repoId = "shop-app") =>
  seatRow({ id, repoId, mode: "read-only", role: "FLIGHT" });

describe("roster order", () => {
  it("lists a repo's seats as FLIGHT, planner, developers, reviewers, then by name", () => {
    const rows = [
      reviewer("retro-1"),
      dev("guido-2", "shop-app", { index: 3 }),
      dev("guido-1", "shop-app", { index: 4 }),
      planner("fao-1"),
      flight("flight-1"),
      dev("guido-10", "shop-app", { index: 5 }),
    ];
    const [group] = rosterGroups(rows);
    expect(group?.rows.map((r) => r.id)).toEqual([
      "flight-1",
      "fao-1",
      "guido-1",
      "guido-2",
      "guido-10",
      "retro-1",
    ]);
  });

  it("groups by repo in config order and keeps observed loops last in their repo", () => {
    const rows = [
      dev("a-1", "beta", { index: 1 }),
      crewRow({ id: "loop-x", repoId: "alpha", index: 0 }),
      dev("b-1", "alpha", { index: 2 }),
    ];
    const groups = rosterGroups(rows);
    expect(groups.map((g) => g.repoId)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["b-1", "loop-x"]);
  });

  it("classes a seat by role and mode", () => {
    expect(seatClass(flight("f"))).toBe("flight");
    expect(seatClass(planner("p"))).toBe("planner");
    expect(seatClass(dev("d"))).toBe("developer");
    expect(seatClass(reviewer("r"))).toBe("reviewer");
    expect(seatClass(seatRow({ mode: "scratch", role: "RETRO" }))).toBe("reviewer");
    expect(seatClass(crewRow())).toBe("other");
  });

  it("j and k step through the roster order and wrap", () => {
    const rows = [dev("guido-1"), flight("flight-1"), reviewer("retro-1")];
    expect(stepRoster(rows, "flight-1", 1)).toBe("guido-1");
    expect(stepRoster(rows, "retro-1", 1)).toBe("flight-1");
    expect(stepRoster(rows, "flight-1", -1)).toBe("retro-1");
    expect(stepRoster(rows, null, 1)).toBe("flight-1");
    expect(stepRoster(rows, null, -1)).toBe("retro-1");
    expect(stepRoster([], null, 1)).toBeNull();
  });
});

describe("what a card says", () => {
  it("the work line is the ticket number and a short title, not the full title", () => {
    const long = "Agents page, slice 1a: the roster of every seat and choosing a seat, with folds";
    const line = workLine(
      dev("guido-1", "mission-control", {
        run: crewRow().run,
        ticket: "mission-control#1771",
        ticketTitle: long,
      }),
    );
    expect(line.ticket).toBe("#1771");
    expect(line.text.length).toBeLessThan(long.length);
    expect(line.text.endsWith("…")).toBe(true);
  });

  it("a seat with no open run is Free and FLIGHT watches the crew", () => {
    expect(workLine(dev("guido-1", "shop-app", { run: null }))).toEqual({
      ticket: null,
      text: "Free",
      full: "Free",
    });
    expect(workLine(flight("flight-1")).text).toBe("Watching the crew");
  });

  it("context is a dash (null) when idle, never 0, and a rounded percent when running", () => {
    const live = digest({ contextTokens: 50_000 });
    expect(
      contextShown(dev("g", "r", { hudState: "running", digest: live, contextWindow: 200_000 })),
    ).toBe(25);
    expect(
      contextShown(dev("g", "r", { hudState: "idle", digest: live, contextWindow: 200_000 })),
    ).toBeNull();
    expect(contextShown(dev("g", "r", { hudState: "running", digest: null }))).toBeNull();
  });

  it("the last-hour strip draws the overview lane: spans by kind and tool starts, only the past hour", () => {
    const lane = {
      agentId: "g",
      spans: [
        { kind: "turn" as const, from: NOW - 2 * HOUR, to: NOW - 90 * MIN },
        { kind: "checks" as const, from: NOW - 10 * MIN, to: NOW - 8 * MIN },
        { kind: "review" as const, from: NOW - 30 * MIN, to: null },
        { kind: "lock" as const, from: NOW - 5 * MIN, to: NOW - 4 * MIN },
      ],
      ticks: [NOW - 2 * HOUR, NOW - 30 * MIN, NOW - 30 * MIN + 1],
    };
    const marks = hourMarks(lane, NOW);
    expect(marks.map((m) => m.kind).sort()).toEqual(["check", "review", "turn", "wait"]);
    expect(marks.every((m) => m.at >= 0 && m.at + m.len <= 1.0001)).toBe(true);
    const review = marks.find((m) => m.kind === "review");
    expect(review?.len).toBeCloseTo(0.5, 2);
  });

  it("a seat with no lane has no marks", () => {
    expect(hourMarks(undefined, NOW)).toEqual([]);
  });

  it("ages read in one short unit", () => {
    expect(shortAge(10_000)).toBe("now");
    expect(shortAge(12 * MIN)).toBe("12m");
    expect(shortAge(3 * HOUR + 5 * MIN)).toBe("3h");
    expect(shortAge(50 * HOUR)).toBe("2d");
  });
});
