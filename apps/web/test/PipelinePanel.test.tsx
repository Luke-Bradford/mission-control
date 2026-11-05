import type { OverviewSummary, PipelineStage } from "@mc/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hub } from "../src/data.ts";
import { cardTitle, PipelinePanel } from "../src/overview/PipelinePanel.tsx";
import { setSession } from "../src/shell/session.ts";
import { stubFetch } from "./fetchStub.ts";
import { METRICS_VIEW, OVERVIEW } from "./fixtures.ts";

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
const summary = (p = pipeline) => ({ ...OVERVIEW, pipeline: p }) as OverviewSummary;

describe("Pipeline", () => {
  it("is the Board: head figures from the metrics registry, then a stage per lane with its cards", async () => {
    stubFetch({
      "/api/overview": summary(),
      "/api/metrics": METRICS_VIEW,
      "/api/crew?shape=summary": { rows: [] },
    });
    const { container } = render(<PipelinePanel />);
    await screen.findByRole("region", { name: "Ready" });
    const title = container.querySelector("#pipelineP h2 a");
    expect(title?.textContent).toBe("Board");
    expect(title?.getAttribute("href")).toBe("/board");
    await waitFor(() =>
      expect(container.querySelector('[data-metric="inProgress"]')?.textContent).toBe("4"),
    );
    expect(container.querySelector('[data-metric="merged"]')?.textContent).toBe("6");
    expect(container.querySelector('[data-metric="cycleTime"]')?.textContent).toBeTruthy();
    expect(container.querySelector("#pipelineP .ph")?.textContent).toContain("CI 92% of 10 runs");
    expect(container.querySelector("#pipelineP .ph")?.textContent).toContain("1 red now");
    expect(
      [...container.querySelectorAll(".board-stage")].map((stage) =>
        stage.getAttribute("aria-label"),
      ),
    ).toEqual(["Ready", "Building · checks", "In review", "Merging", "Done · 24h"]);
    expect(screen.queryByText("Done today")).toBeNull();
    expect(container.textContent).not.toContain("total");
  });

  it("opens cards on their ticket page while lane links keep their Board stage filter", async () => {
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
          // The overview endpoint limits each stage to its card capacity.
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
      "/api/metrics": METRICS_VIEW,
      "/api/crew?shape=summary": { rows: [{ id: "seat-1", displayCallSign: "INCO", index: 3 }] },
    });
    render(<PipelinePanel />);

    const readyLane = await screen.findByRole("region", { name: "Ready" });
    // Every card the endpoint sent is listed, and the rest are counted with a link to the Board.
    expect(within(readyLane).getAllByText(/Ready ticket/)).toHaveLength(8);
    expect(readyLane.querySelector("h3 .num")?.textContent).toBe("10");
    expect(within(readyLane).getByRole("link", { name: "2 more on the Board" })).toBeTruthy();
    expect(
      within(readyLane).getByRole("link", { name: "2 more on the Board" }).getAttribute("href"),
    ).toBe("/board?stage=ready");
    expect(within(readyLane).getByRole("link", { name: "Ready" }).getAttribute("href")).toBe(
      "/board?stage=ready",
    );
    expect(within(readyLane).getAllByText("INCO")).toHaveLength(8);
    expect(readyLane.querySelector(".pipeline-assignee i")?.getAttribute("style")).toContain(
      "--c: var(--seat-4)",
    );
    const first = within(readyLane).getByRole("link", { name: /Ready ticket 1/ });
    expect(first.getAttribute("href")).toBe("/tickets/sample-app/1");
    expect(first.classList.contains("board-card")).toBe(true);
    // The checks: three marks, and the count in words.
    const marks = first.querySelector(".ci-marks");
    expect(marks?.getAttribute("aria-label")).toBe("CI: 1 of 3 passed, 1 failed");
    expect([...(marks?.children ?? [])].map((mark) => mark.className)).toEqual([
      "ci-pass",
      "ci-fail",
      "ci-pending",
    ]);

    // Building and checks share one lane, with the stage figures added.
    const progressLane = screen.getByRole("region", { name: "Building · checks" });
    expect(within(progressLane).getByText("Building ticket")).toBeTruthy();
    expect(within(progressLane).getByText("Checked ticket")).toBeTruthy();
    expect(progressLane.querySelector("h3 .num")?.textContent).toBe("2");
    expect(within(progressLane).getAllByRole("link")[0]?.getAttribute("href")).toBe(
      "/board?stage=progress",
    );
    // An empty lane says so and keeps its Board link.
    const reviewLane = screen.getByRole("region", { name: "In review" });
    expect(within(reviewLane).getByText("No tickets here.")).toBeTruthy();
    expect(reviewLane.querySelector(".board-card")).toBeNull();
    expect(within(reviewLane).getByRole("link", { name: "In review" })).toBeTruthy();
  });

  it("says when the Board could not load", async () => {
    stubFetch({
      "/api/overview": () => ({ status: 500, body: { error: "down" } }),
      "/api/metrics": METRICS_VIEW,
      "/api/crew?shape=summary": { rows: [] },
    });
    render(<PipelinePanel />);
    expect((await screen.findByRole("status")).textContent).toBe("Board could not load.");
  });

  it("shows empty lanes with their counts and refetches the selected session on SSE invalidation", async () => {
    setSession("session-1");
    let data = summary(stages.map((stage) => ({ stage, count: 0, oldestAt: null, cards: [] })));
    stubFetch({
      "/api/overview?session=session-1": () => ({ status: 200, body: data }),
      "/api/metrics": METRICS_VIEW,
    });
    const { container } = render(<PipelinePanel />);
    await waitFor(() => expect(screen.getAllByText("No tickets here.")).toHaveLength(5));
    expect([...container.querySelectorAll("h3 .num")].map((el) => el.textContent)).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(container.querySelectorAll(".board-card")).toHaveLength(0);
    expect(container.querySelector(".board-oldest")).toBeNull();
    data = summary();
    await act(async () => {
      hub.refetchTopic("boards");
    });
    expect(await screen.findByText(/Ticket 1/)).toBeTruthy();
    expect(container.querySelector(".board-oldest")?.textContent).toBe("oldest 2m");
  });
});

describe("cardTitle", () => {
  it("drops the ticket or PR number a title repeats", () => {
    expect(cardTitle({ ticket: 1047, pr: 1050, title: "feat(web): Board lanes (#1050)" })).toBe(
      "feat(web): Board lanes",
    );
    expect(cardTitle({ ticket: 1047, pr: null, title: "#1047 Board lanes" })).toBe("Board lanes");
    expect(cardTitle({ ticket: 12, pr: 20, title: "Fix #12 and (#99)" })).toBe("Fix #12 and (#99)");
    expect(cardTitle({ ticket: 7, pr: null, title: "(#7)" })).toBe("(#7)");
  });
});
