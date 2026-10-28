import type { OverviewSummary, PipelineStage } from "@mc/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { PipelinePanel } from "../src/overview/PipelinePanel.tsx";
import { setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";

const stages: PipelineStage["stage"][] = [
  "ready",
  "building",
  "checks",
  "review",
  "merging",
  "merged",
];
const now = Date.now();
const pipeline: PipelineStage[] = stages.map((stage, i) => ({
  stage,
  count: 1,
  oldestAt: now - 120_000,
  cards: [
    {
      repoId: "sample-app",
      ticket: i + 1,
      title: `Ticket ${i + 1}`,
      pr: i + 20,
      ci: ["pass", "fail", "pending"],
      since: now - 120_000,
      who: i ? "seat-1" : null,
    },
  ],
}));
const summary = (p = pipeline) => ({ pipeline: p }) as OverviewSummary;

describe("Pipeline", () => {
  it("shows populated board lanes as compact ticket chips with assignees, overflow and Board links", async () => {
    const ready = pipeline[0] as PipelineStage;
    const building = pipeline[1] as PipelineStage;
    const checks = pipeline[2] as PipelineStage;
    const card = ready.cards[0];
    if (!card) throw new Error("missing ready card");
    stubFetch({
      "/api/overview": summary([
        {
          ...ready,
          count: 10,
          // The overview endpoint limits each stage to its chip capacity.
          cards: Array.from({ length: 8 }, (_, i) => ({
            ...card,
            ticket: i + 1,
            title: `Ready ticket ${i + 1}`,
            who: "seat-1",
          })),
        },
        { ...building, count: 1, cards: [{ ...card, ticket: 20, title: "Building ticket" }] },
        { ...checks, count: 1, cards: [{ ...card, ticket: 21, title: "Checked ticket" }] },
      ]),
      "/api/crew": { rows: [{ id: "seat-1", displayCallSign: "INCO", index: 3 }] },
    });
    render(<PipelinePanel />);

    const readyLane = await screen.findByRole("region", { name: "Ready" });
    expect(within(readyLane).getAllByRole("link")).toHaveLength(10);
    expect(within(readyLane).getByRole("link", { name: "+2" }).getAttribute("href")).toBe(
      "/board?stage=ready",
    );
    expect(within(readyLane).getAllByText("INCO")).toHaveLength(8);
    expect(readyLane.querySelector(".pipeline-assignee i")?.getAttribute("style")).toContain(
      "--c: var(--s4)",
    );
    expect(
      within(readyLane)
        .getByRole("link", { name: /Ready ticket 1/ })
        .getAttribute("href"),
    ).toBe("/board?stage=ready");

    const progressLane = screen.getByRole("region", { name: "Building" });
    expect(within(progressLane).getByText("Building ticket")).toBeTruthy();
    expect(within(progressLane).getByText("Checked ticket")).toBeTruthy();
    expect(within(progressLane).getAllByRole("link")[0]?.getAttribute("href")).toBe(
      "/board?stage=progress",
    );
    expect(screen.queryByRole("region", { name: "In review" })).toBeNull();
  });

  it("hides empty lanes and refetches the selected session on SSE invalidation", async () => {
    setSession("session-1");
    let data = summary(stages.map((stage) => ({ stage, count: 0, oldestAt: null, cards: [] })));
    stubFetch({ "/api/overview?session=session-1": () => ({ status: 200, body: data }) });
    const { container } = render(<PipelinePanel />);
    await waitFor(() => expect(container.querySelectorAll(".pipeline-stage")).toHaveLength(0));
    data = summary();
    await act(async () => {
      hub.refetchTopic("boards");
    });
    expect(await screen.findByText(/Ticket 1/)).toBeTruthy();
  });
});
