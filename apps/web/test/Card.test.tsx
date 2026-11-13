import type { PillSpec } from "@mc/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Card } from "../src/board/Card.tsx";
import type { CardYou } from "../src/board/cards.ts";
import { PrChip } from "../src/hud/PrChip.tsx";
import { needsYouPath, ticketPath } from "../src/router.ts";
import { boardItem, crewRow, prView } from "./fixtures.ts";

const card = (pr: ReturnType<typeof prView>, checkPill: PillSpec | null) =>
  render(
    <Card
      item={boardItem({ status: "In review" })}
      showRepo={false}
      agent={null}
      step={null}
      queued={null}
      reviewer={null}
      pr={pr}
      checkLabel={checkPill?.label}
      checkTone={checkPill?.tone}
      mine={false}
      unacked={false}
      outcome="Closed"
      when=""
      statusOutOfDate={null}
      you={null}
    />,
  );

it("a Board card shows its acceptance gate once, and omits it when unset", () => {
  const view = card(prView({ uat: { sha: "a".repeat(40), since: 1 } }), null);
  expect(screen.getAllByText("Waiting for your acceptance")).toHaveLength(1);
  view.unmount();
  card(prView(), null);
  expect(screen.queryByText("Waiting for your acceptance")).toBeNull();
});

it("an open PR with a review state shows its words, not the GitHub state", () => {
  card(prView({ review: "requested" }), {
    label: "RETRO-1 checking · 12 min",
    tone: "warn",
  });
  expect(screen.getByText("RETRO-1 checking · 12 min")).toBeTruthy();
  expect(screen.queryByText("Review asked")).toBeNull();
});

it("a merged PR keeps its own pill whatever the review state", () => {
  card(prView({ state: "merged" }), { label: "Ready to merge", tone: "ok" });
  expect(screen.getByText("Merged")).toBeTruthy();
  expect(screen.queryByText("Ready to merge")).toBeNull();
});

it("the PR chip shows the same words for an open PR", () => {
  render(<PrChip pr={prView({ check: { kind: "queued", position: 3 } })} />);
  expect(screen.getByText("Waiting for review · 3rd in queue")).toBeTruthy();
});

it("a draft PR with a review state shows its words, not Draft, and no no-reviewer line", () => {
  card(prView({ isDraft: true }), { label: "Waiting for review · 2nd in queue", tone: "plain" });
  expect(screen.getByText("Waiting for review · 2nd in queue")).toBeTruthy();
  expect(screen.queryByText("Draft")).toBeNull();
  expect(screen.queryByText("No reviewer on it now")).toBeNull();
});

it("a draft PR chip with a review state shows the pill", () => {
  render(<PrChip pr={prView({ isDraft: true, check: { kind: "ready" } })} />);
  expect(screen.getByText("Ready to merge")).toBeTruthy();
});

it("a Board card does not repeat the hand-off line", () => {
  const { container } = render(
    <Card
      item={boardItem({
        handoff: { runId: "r1", fromSeat: "guido-cx", at: 1, acceptedBy: null },
      })}
      showRepo={false}
      agent={null}
      step={null}
      queued={null}
      reviewer={null}
      pr={null}
      mine={false}
      unacked={false}
      outcome="Closed"
      when=""
      statusOutOfDate={null}
      you={null}
    />,
  );
  expect(screen.queryByText(/Handed off from/)).toBeNull();
  expect(container.querySelector(".handoff-link")).toBeNull();
});

it("a Done card shows no CI failure, even for a PR whose last CI run failed", () => {
  render(
    <Card
      item={boardItem({ status: "Done" })}
      showRepo={false}
      agent={null}
      step={null}
      queued={null}
      reviewer={null}
      pr={prView({ state: "merged", ci: "failing" })}
      mine={false}
      unacked={false}
      outcome="Merged"
      when="today"
      statusOutOfDate={null}
      you={null}
    />,
  );
  expect(screen.getByText("Merged")).toBeTruthy();
  expect(screen.queryByText("CI failing")).toBeNull();
  expect(document.querySelector(".crit")).toBeNull();
});

const cardWith = (over: { agent?: ReturnType<typeof crewRow> | null; you?: CardYou | null }) =>
  render(
    <Card
      item={boardItem({ status: "In Progress" })}
      showRepo={false}
      agent={over.agent ?? null}
      step={null}
      queued={null}
      reviewer={null}
      pr={null}
      mine={false}
      unacked={false}
      outcome="Closed"
      when=""
      statusOutOfDate={null}
      you={over.you ?? null}
    />,
  );

it("the You chip goes to its Needs you page, not the side pane", () => {
  window.history.replaceState(null, "", "/board");
  cardWith({ you: { key: "esc:shop-app#3349", text: "Pick an option", more: 0, title: "t" } });
  fireEvent.click(screen.getByRole("button", { name: /Pick an option/ }));
  expect(window.location.pathname).toBe(needsYouPath("esc:shop-app#3349"));
  expect(window.location.search).toBe("");
});

it("a card with an agent on it opens the ticket page, not the agent", () => {
  window.history.replaceState(null, "", "/board");
  const { container } = cardWith({ agent: crewRow({ id: "dev-1" }) });
  fireEvent.click(container.querySelector(".ktitle") as Element);
  expect(window.location.pathname).toBe(ticketPath("shop-app", 3349));
});
