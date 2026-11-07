import type { FlightPrFlowRow, FlightPrFlowView } from "@mc/core";
import { expect, it } from "vitest";
import { flowByPr, flowChip, flowKey } from "../src/board/prFlowChip.ts";

const row = (over: Partial<FlightPrFlowRow>): FlightPrFlowRow => ({
  pr: 77,
  ticket: "shop-app#77",
  title: "Cache quotes",
  owner: "controller",
  stage: "merge",
  stageSince: 0,
  ownerSince: 0,
  openSince: 0,
  waitsOn: [],
  blocks: [],
  lastAction: "",
  lastActor: null,
  ...over,
});

it("a controller check reads 'controller check', never 'operator'", () => {
  const chip = flowChip(
    { kind: "held", by: "operator" },
    row({ stage: "controller check", ownerKind: "controller" }),
  );
  expect(chip.label).toBe("Held · controller check");
});

it("'Held · operator' stays when the PR flow says the operator holds it", () => {
  const chip = flowChip(
    { kind: "held", by: "operator" },
    row({ stage: "clearance", ownerKind: "operator" }),
  );
  expect(chip.label).toBe("Held · operator");
});

it("'Ready to merge' only when the flow's next step is the merge", () => {
  const ready = { kind: "ready" } as const;
  expect(flowChip(ready, row({ stage: "merge", ownerKind: "hub" })).label).toBe("Ready to merge");
  expect(flowChip(ready, row({ stage: "sync", ownerKind: "seat" })).label).toBe("Held · sync");
  expect(flowChip(ready, row({ stage: "controller check", ownerKind: "controller" })).label).toBe(
    "Held · controller check",
  );
  expect(flowChip(ready, row({ stage: "CI", ownerKind: "CI" })).label).toBe("Waiting for CI");
});

it("without a flow row the review state stands", () => {
  expect(flowChip({ kind: "ready" }, undefined).label).toBe("Ready to merge");
});

it("rows are found by repo and PR number", () => {
  const view = {
    generatedAt: 0,
    repos: [{ repoId: "shop-app", generatedAt: 0, rows: [row({})], unowned: 0, metrics: [] }],
  } as FlightPrFlowView;
  expect(flowByPr(view).get(flowKey("shop-app", 77))?.pr).toBe(77);
});
