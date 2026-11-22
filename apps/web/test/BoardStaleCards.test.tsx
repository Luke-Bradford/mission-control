import { needsYouItems } from "@mc/core";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Kanban } from "../src/board/Kanban.tsx";
import { stubFetch } from "./fetchStub.ts";
import { boardItem, CONFIG, crewRow, NOW, prView } from "./fixtures.ts";

const props = {
  showRepo: false,
  crew: [],
  needsYou: needsYouItems([]),
  now: NOW,
  tz: "UTC",
  todayStart: NOW - 12 * 60 * 60_000,
};

it("does not show a closed, unmerged PR as a Ready card's current PR", () => {
  stubFetch({ "/api/config": CONFIG });
  const items = [boardItem({ issueNumber: 77, status: "Ready", state: "planned" })];
  const prs = [prView({ state: "closed", check: null, ci: "passing" })];
  // a run is on the ticket, so the idle line is off and the card would show the PR line
  const crew = [crewRow({ ticket: "shop-app#77" })];
  const { container } = render(<Kanban {...props} crew={crew} items={items} prs={prs} />);
  expect(container.querySelector('a[href*="/pull/77"]')).toBeNull();
  expect(screen.queryByText("Closed")).toBeNull();
});

it("shows no Status out of date note on a card in Done", () => {
  stubFetch({ "/api/config": CONFIG });
  const items = [
    boardItem({ issueNumber: 77, status: "In progress", state: "in progress", closed: true }),
  ];
  const { container } = render(<Kanban {...props} items={items} prs={[]} />);
  expect(container.querySelector('[data-card="shop-app#77"]')).toBeTruthy();
  expect(screen.queryByText(/Status out of date/)).toBeNull();
});
