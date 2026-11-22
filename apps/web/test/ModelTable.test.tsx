import type { ModelGroupRow, ModelsView } from "@mc/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../src/hud.css";
import { hub } from "../src/data.ts";
import { ModelPanels } from "../src/pages/ModelTable.tsx";
import { stubFetch } from "./fetchStub.ts";

const rate = (count: number, of: number, percent: number | null) => ({ count, of, percent });
const group = (over: Partial<ModelGroupRow>): ModelGroupRow => ({
  model: "sonnet-5.5",
  effort: "medium",
  split: null,
  runs: 19,
  tooFew: true,
  pricedRuns: 19,
  meanCost: null,
  round2: rate(12, 19, null),
  round3: rate(4, 19, null),
  meanBlocking: null,
  tokensPerMerged: null,
  ...over,
});
const big = group({
  model: "opus-5.5",
  effort: "high",
  runs: 20,
  tooFew: false,
  pricedRuns: 18,
  meanCost: 1.65,
  round2: rate(10, 20, 50),
  round3: rate(4, 20, 20),
  meanBlocking: 2.25,
  tokensPerMerged: 61_000,
});
const VIEW: ModelsView = {
  groups: {
    none: [big, group({})],
    type: [{ ...big, split: "feature" }],
    size: [],
    plan: [],
  },
  changes: [
    {
      at: Date.UTC(2026, 9, 1),
      seatId: "guido-1",
      change: "sonnet-5.5 medium → sonnet-5.5 high",
      before: { runs: 25, tooFew: false, round3: rate(5, 25, 20), tokensPerMerged: 50_000 },
      after: { runs: 7, tooFew: true, round3: rate(1, 7, null), tokensPerMerged: null },
    },
  ],
};

beforeEach(() => hub.clear());
afterEach(() => vi.restoreAllMocks());

it("shows every column, with counts only for a small group", async () => {
  stubFetch({ "/api/audit/models?range=30d": VIEW });
  render(<ModelPanels range="30d" />);
  const region = await screen.findByRole("region", { name: "Rework and cost by model" });
  for (const h of [
    "Model",
    "Effort",
    "Runs",
    "Mean cost",
    "Round 2+",
    "Round 3+",
    "Mean blocking",
    "Tokens per merged ticket",
  ])
    expect(within(region).getByText(h)).toBeTruthy();
  expect(
    screen.getByText("Correlations, not causes. Groups under 20 runs show counts only."),
  ).toBeTruthy();
  const small = within(region).getByText("sonnet-5.5").closest("tr") as HTMLElement;
  expect(within(small).getByText("19")).toBeTruthy();
  expect(within(small).getByText("Too few to compare (under 20 runs)")).toBeTruthy();
  expect(small.textContent).not.toContain("%");
  const rowBig = within(region).getByText("opus-5.5").closest("tr") as HTMLElement;
  expect(rowBig.textContent).toContain("20%");
  expect(rowBig.textContent).toContain("18 priced");
  expect(rowBig.textContent).toContain("61.0k");
});

it("split adds a column and an empty split says so", async () => {
  stubFetch({ "/api/audit/models?range=30d": VIEW });
  render(<ModelPanels range="30d" />);
  await screen.findByRole("region", { name: "Rework and cost by model" });
  fireEvent.click(screen.getByRole("button", { name: "Ticket type" }));
  expect(screen.getByText("feature")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Size" }));
  expect(screen.getByText("No reviewed runs in this window.")).toBeTruthy();
});

it("shows before and after with sample sizes", async () => {
  stubFetch({ "/api/audit/models?range=30d": VIEW });
  render(<ModelPanels range="30d" />);
  const region = await screen.findByRole("region", { name: "Changes" });
  expect(within(region).getByText("guido-1")).toBeTruthy();
  expect(within(region).getByText(/20% · 50\.0k · n=25/)).toBeTruthy();
  expect(within(region).getByText("7 runs · too few")).toBeTruthy();
  expect(
    screen.getByText("Each side up to 30 days, bounded by the seat's other changes."),
  ).toBeTruthy();
});

it("reports an error", async () => {
  stubFetch({});
  render(<ModelPanels range="30d" />);
  expect((await screen.findAllByText(/Could not load model table/)).length).toBeGreaterThan(0);
});
