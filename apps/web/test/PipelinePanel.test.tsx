import type { OverviewSummary, PipelineStage } from "@mc/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
const labels = ["Ready", "Building", "Checks", "Review", "Merging", "Merged today"];
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
  it("shows all six stages, counts, oldest ages, ticket links, PRs, seats and accessible CI dots", async () => {
    stubFetch({ "/api/overview": summary() });
    render(<PipelinePanel />);
    for (const [i, label] of labels.entries()) {
      const stage = await screen.findByRole("region", { name: label });
      expect(within(stage).getByText("1", { selector: ".num" })).toBeTruthy();
      expect(within(stage).getByText("oldest 2m")).toBeTruthy();
      const card = within(stage).getByRole("link");
      expect(card.getAttribute("href")).toBe(`/board/sample-app/${i + 1}`);
      expect(card.textContent).toContain(`PR #${i + 20}`);
      expect(card.textContent).toContain(i ? "seat-1" : "waiting on you");
      expect(within(card).getByText("2m")).toBeTruthy();
      for (const state of ["pass", "fail", "pending"]) {
        expect(within(card).getByRole("img", { name: `CI ${state}` }).className).toContain(state);
      }
    }
  });

  it("keeps multiple merged PRs for one ticket distinct across live updates", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const merged = pipeline[5] as PipelineStage;
      const card = merged.cards[0];
      if (!card) throw new Error("missing card");
      const cards = [40, 41, 42].map((pr) => ({ ...card, pr, title: `Merge ${pr}` }));
      let data = summary([{ ...merged, count: 3, cards }]);
      stubFetch({ "/api/overview": () => ({ status: 200, body: data }) });
      render(<PipelinePanel />);
      const stage = await screen.findByRole("region", { name: "Merged today" });
      expect(
        within(stage)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(cards.map((card) => expect.stringContaining(`PR #${card.pr}`)));
      data = summary([{ ...merged, count: 2, cards: cards.filter((_, i) => i !== 1).reverse() }]);
      await act(async () => {
        hub.refetchTopic("boards");
      });
      await waitFor(() =>
        expect(
          within(stage)
            .getAllByRole("link")
            .map((link) => link.textContent),
        ).toEqual([expect.stringContaining("PR #42"), expect.stringContaining("PR #40")]),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("caps cards at six using the total count for the stage Board link", async () => {
    const ready = pipeline[0] as PipelineStage;
    const card = ready.cards[0];
    if (!card) throw new Error("missing card");
    stubFetch({
      "/api/overview": summary([
        {
          ...ready,
          count: 9,
          cards: Array.from({ length: 8 }, (_, i) => ({
            ...card,
            ticket: i + 1,
            title: `Ticket ${i + 1}`,
          })),
        },
      ]),
    });
    render(<PipelinePanel />);
    const stage = await screen.findByRole("region", { name: "Ready" });
    expect(within(stage).getAllByRole("link")).toHaveLength(7);
    expect(within(stage).getByRole("link", { name: "+3 more" }).getAttribute("href")).toBe(
      "/board?stage=ready",
    );
    expect(within(stage).queryByText("Ticket 7")).toBeNull();
  });

  it("keeps empty stages and refetches the selected session on SSE invalidation", async () => {
    setSession("session-1");
    let data = summary(stages.map((stage) => ({ stage, count: 0, oldestAt: null, cards: [] })));
    stubFetch({ "/api/overview?session=session-1": () => ({ status: 200, body: data }) });
    render(<PipelinePanel />);
    expect(await screen.findAllByText("oldest —")).toHaveLength(6);
    expect(screen.queryByText(/more$/)).toBeNull();
    data = summary();
    await act(async () => {
      hub.refetchTopic("boards");
    });
    expect(await screen.findByText("Ticket 1")).toBeTruthy();
  });
});
