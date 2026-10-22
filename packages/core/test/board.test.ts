import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS,
  BOARD_DONE_DAYS,
  BOARD_KEEP_DONE_DAYS,
  type BoardColumnKey,
  columnOf,
  DONE_RANGES,
  labelPriority,
  OWNER_FIELD,
  OWNERS,
  PR_KEEP_DAYS,
  PR_MAX_PAGES,
  SIZE_FIELD,
  STAGE_FIELD,
  STAGES,
  type Stage,
} from "../src/board.ts";
import { TICKET_STATES } from "../src/topics.ts";
import type { TicketState } from "../src/types.ts";

describe("board retention constants", () => {
  it("stores 30 days of done, views 7 by default, offers 7/14/30", () => {
    expect(BOARD_KEEP_DONE_DAYS).toBe(30);
    expect(BOARD_DONE_DAYS).toBe(7);
    expect(DONE_RANGES).toEqual([7, 14, 30]);
    expect(PR_KEEP_DAYS).toBe(30);
    expect(PR_MAX_PAGES).toBe(10);
    expect(SIZE_FIELD).toBe("Size");
  });
});

describe("board constants", () => {
  it("names the Stage and Owner fields and their options exactly", () => {
    expect(STAGE_FIELD).toBe("Stage");
    expect(STAGES).toEqual(["Needs detail", "Ready"]);
    expect(OWNER_FIELD).toBe("Owner");
    expect(OWNERS).toEqual(["PM", "CTO", "Agent", "Operator"]);
    expect(BOARD_COLUMNS).toEqual(["needs detail", "ready", "in flight", "blocked", "done"]);
  });
});

describe("columnOf", () => {
  const table: [TicketState, Stage | null, BoardColumnKey][] = [
    ["planned", null, "ready"],
    ["planned", "Ready", "ready"],
    ["planned", "Needs detail", "needs detail"],
    ["in progress", null, "in flight"],
    ["in progress", "Ready", "in flight"],
    ["in progress", "Needs detail", "in flight"],
    ["review", null, "in flight"],
    ["review", "Ready", "in flight"],
    ["review", "Needs detail", "in flight"],
    ["blocked", null, "blocked"],
    ["blocked", "Ready", "blocked"],
    ["blocked", "Needs detail", "blocked"],
    ["done", null, "done"],
    ["done", "Ready", "done"],
    ["done", "Needs detail", "done"],
  ];
  it.each(table)("%s + stage %s -> %s", (state, stage, column) => {
    expect(columnOf({ state, stage })).toBe(column);
  });
  it("covers every ticket state", () => {
    expect(new Set(table.map((r) => r[0]))).toEqual(new Set(TICKET_STATES));
  });
});

describe("labelPriority", () => {
  it("reads p0-p3 labels, case-insensitively, first match wins", () => {
    expect(labelPriority(["bug", "p2"])).toBe("P2");
    expect(labelPriority(["P0"])).toBe("P0");
    expect(labelPriority(["p4"])).toBeNull();
    expect(labelPriority(["p10", "priority"])).toBeNull();
    expect(labelPriority(["p3", "p1"])).toBe("P3");
    expect(labelPriority([])).toBeNull();
  });
});
