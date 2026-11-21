import { describe, expect, it } from "vitest";
import {
  MODEL_TABLE_MIN_RUNS,
  type ModelRunRow,
  modelChanges,
  modelGroups,
  type SeatRun,
} from "../src/model-table.ts";

const DAY = 86_400_000;
let n = 0;
const row = (over: Partial<ModelRunRow> = {}): ModelRunRow => {
  n += 1;
  return {
    runId: `r${n}`,
    seatId: "guido-1",
    reviewSeatId: "retro",
    ticket: `mc#${n}`,
    model: "sonnet-5.5",
    effort: "medium",
    template: "feature",
    planned: true,
    size: "S",
    merged: true,
    maxRound: 1,
    blocking: 0,
    costUsd: 1,
    ticketTokens: 1000,
    endedAt: 0,
    ...over,
  };
};
const many = (count: number, over: Partial<ModelRunRow> = {}) =>
  Array.from({ length: count }, () => row(over));

describe("modelGroups", () => {
  it("marks small groups and draws no rate", () => {
    const rows = [
      ...many(19, { model: "sonnet-5.5", effort: "medium", maxRound: 3 }),
      ...many(20, { model: "opus-5.5", effort: "high", maxRound: 2, blocking: 2 }),
    ];
    const [opus, sonnet] = modelGroups(rows, "none");
    expect(MODEL_TABLE_MIN_RUNS).toBe(20);
    expect(sonnet).toMatchObject({ model: "sonnet-5.5", runs: 19, tooFew: true });
    expect(sonnet?.round3.percent).toBeNull();
    expect(sonnet?.round2.percent).toBeNull();
    expect(sonnet?.meanBlocking).toBeNull();
    expect(opus).toMatchObject({ model: "opus-5.5", runs: 20, tooFew: false, meanBlocking: 2 });
    expect(opus?.round2.percent).toBe(100);
    expect(opus?.round3.percent).toBe(0);
  });

  it("averages cost over priced runs and sorts by runs", () => {
    const rows = [
      ...many(20, { costUsd: 2 }),
      ...many(5, { costUsd: null }),
      ...many(21, { model: "opus-5.5", costUsd: null }),
    ];
    const g = modelGroups(rows, "none");
    expect(g.map((x) => x.model)).toEqual(["sonnet-5.5", "opus-5.5"]);
    expect(g[0]).toMatchObject({ runs: 25, pricedRuns: 20, meanCost: 2 });
    expect(g[1]?.meanCost).toBeNull();
  });

  it("splits by ticket type, size and plan", () => {
    const rows = [
      ...many(20, { template: "feature", size: "S", planned: true }),
      ...many(20, { template: "bug", size: "M", planned: false }),
    ];
    expect(modelGroups(rows, "type").map((x) => x.split)).toEqual(["bug", "feature"]);
    expect(modelGroups(rows, "size").map((x) => x.split)).toEqual(["M", "S"]);
    expect(modelGroups(rows, "plan").map((x) => x.split)).toEqual(["No plan", "With plan"]);
    expect(modelGroups(rows, "none")[0]?.split).toBeNull();
  });

  it("counts tokens per merged ticket over merged tickets once", () => {
    const rows = [
      ...many(20, { ticketTokens: 100 }),
      row({ ticket: "mc#x", ticketTokens: 1000 }),
      row({ ticket: "mc#x", ticketTokens: 1000 }),
      row({ ticket: "mc#y", ticketTokens: 5000, merged: false }),
    ];
    expect(modelGroups(rows, "none")[0]?.tokensPerMerged).toBe((20 * 100 + 1000) / 21);
  });
});

describe("modelChanges", () => {
  const seatRuns: SeatRun[] = [
    { seatId: "guido-1", loop: "build", model: "sonnet-5.5", effort: "medium", startedAt: 1 * DAY },
    {
      seatId: "guido-1",
      loop: "build",
      model: "sonnet-5.5",
      effort: "medium",
      startedAt: 30 * DAY,
    },
    { seatId: "guido-1", loop: "build", model: "sonnet-5.5", effort: "high", startedAt: 40 * DAY },
  ];

  it("gives before and after round 3+ and tokens per merged ticket", () => {
    const rows = [
      ...many(20, { endedAt: 20 * DAY, maxRound: 3, ticketTokens: 200 }),
      ...many(20, { endedAt: 50 * DAY, maxRound: 1, ticketTokens: 100 }),
      ...many(5, { endedAt: 50 * DAY, seatId: "guido-2", maxRound: 3 }),
      ...many(3, { endedAt: 2 * DAY }),
    ];
    const out = modelChanges(seatRuns, rows, 45 * DAY, 0, 60 * DAY);
    const change = out.find((c) => c.change !== "Step-up advice starts");
    expect(out.filter((c) => c.change !== "Step-up advice starts")).toHaveLength(1);
    expect(change).toMatchObject({ at: 40 * DAY, seatId: "guido-1" });
    expect(change?.change).toBe("sonnet-5.5 medium → sonnet-5.5 high");
    expect(change?.before).toMatchObject({ runs: 20, tooFew: false, tokensPerMerged: 200 });
    expect(change?.before.round3.percent).toBe(100);
    expect(change?.after).toMatchObject({ runs: 20, tooFew: false, tokensPerMerged: 100 });
    expect(change?.after.round3.percent).toBe(0);
    const step = out.find((c) => c.change === "Step-up advice starts");
    expect(step?.seatId).toBeNull();
    expect(step?.at).toBe(45 * DAY);
    expect(step?.before.runs).toBe(20);
    expect(step?.after.runs).toBe(20 + 5);
  });

  it("marks a side with under 20 runs as too few and draws no percent", () => {
    const rows = many(3, { endedAt: 41 * DAY, maxRound: 3 });
    const c = modelChanges(seatRuns, rows, null, 0, 60 * DAY)[0];
    expect(c?.after).toMatchObject({ runs: 3, tooFew: true });
    expect(c?.after.round3.percent).toBeNull();
    expect(c?.after.tokensPerMerged).toBeNull();
  });

  it("leaves out changes outside the window and has no step-up row without advice", () => {
    expect(modelChanges(seatRuns, [], null, 41 * DAY, 60 * DAY)).toEqual([]);
  });
});
