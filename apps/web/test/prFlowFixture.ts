import type { FlightPrFlowRow, FlightPrFlowView } from "@mc/core";

export const FLOW_NOW = Date.parse("2026-11-01T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const stages: FlightPrFlowRow["stage"][] = [
  "building",
  "CI",
  "review",
  "rework",
  "sync",
  "clearance",
  "controller check",
  "merge",
];
export function prFlowFixture(count = 6): FlightPrFlowView {
  return {
    generatedAt: FLOW_NOW,
    repos: [
      {
        repoId: "shop-app",
        generatedAt: FLOW_NOW,
        unowned: Math.ceil(count / 4),
        rows: Array.from({ length: count }, (_, i) => ({
          pr: 100 + i,
          ticket: `shop-app#${20 + i}`,
          title:
            i === 1
              ? "Keep the author’s place in the review queue when another run starts and the waiting branch needs a fresh main merge"
              : `Show who owns the next step for the waiting PR ${100 + i}`,
          owner: ["nobody", "guido-1", "CI", "operator"][i % 4] as string,
          ownerKind: ["nobody", "seat", "CI", "operator"][i % 4] as FlightPrFlowRow["ownerKind"],
          seatId: i % 4 === 1 ? "guido-1" : null,
          stage: stages[i % stages.length] as FlightPrFlowRow["stage"],
          stageSince: FLOW_NOW - ((i % 3) + 1) * 15 * MIN,
          ownerSince: FLOW_NOW - 20 * MIN,
          openSince: FLOW_NOW - (i + 1) * 60 * MIN,
          waitsOn:
            i % 4 === 0
              ? ["no run since 11:40"]
              : i % 4 === 3
                ? ["waiting for your acceptance"]
                : ["PR 1033 to merge (shop-app#1015)"],
          blocks: i === 0 ? ["shop-app#20", "PR 1189"] : [],
          lastAction: i % 4 === 0 ? "run ended" : "review reported",
          lastActor: i % 4 === 0 ? "guido-1" : "retro-1",
          lastActionAt: FLOW_NOW - 5 * MIN,
        })),
        metrics: [DAY, 7 * DAY].map((windowMs) => ({
          windowMs,
          merged: 63,
          openToMerge: { p50Ms: 42 * MIN, p90Ms: 216 * MIN },
          stageTimes: stages.map((stage) => ({ stage, p50Ms: 10 * MIN, p90Ms: 30 * MIN })),
          reworkRounds: { p50: 1, p90: 3 },
        })),
      },
    ],
  };
}
