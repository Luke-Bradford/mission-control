import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Card } from "../src/board/Card.tsx";
import { PrChip } from "../src/hud/PrChip.tsx";
import { boardItem, prView } from "./fixtures.ts";

const card = (pr: ReturnType<typeof prView>, checkPill: Parameters<typeof Card>[0]["checkPill"]) =>
  render(
    <Card
      item={boardItem({ status: "In review" })}
      showRepo={false}
      agent={null}
      step={null}
      queued={null}
      reviewer={null}
      pr={pr}
      checkPill={checkPill}
      mine={false}
      unacked={false}
      outcome="Closed"
      when=""
      statusOutOfDate={null}
      you={null}
    />,
  );

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
