import { needsYouItems } from "@mc/core";
import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { Kanban } from "../src/board/Kanban.tsx";
import { boardItem, MIN, NOW } from "./fixtures.ts";

const patternsDiffer = (patterns: readonly string[]) =>
  patterns.every((value, index) => !index || value !== patterns[index - 1]);

beforeEach(() => vi.setSystemTime(NOW));

it("rejects adjacent Done cards whose raw times differ but displayed work patterns match", () => {
  const { container } = render(
    <Kanban
      items={[
        boardItem({ issueNumber: 71, status: "Done", closed: true, updatedAt: NOW - 5 * MIN }),
        boardItem({ issueNumber: 72, status: "Done", closed: true, updatedAt: NOW - 45 * MIN }),
      ]}
      showRepo={false}
      prs={[]}
      crew={[]}
      needsYou={needsYouItems([])}
      now={NOW}
      tz="UTC"
      todayStart={NOW - 12 * 60 * MIN}
    />,
  );
  const patterns = [...container.querySelectorAll<HTMLElement>(".kcard [data-work-pattern]")].map(
    (card) => card.dataset.workPattern ?? "",
  );
  expect(patterns).toEqual(["Closed · today", "Closed · today"]);
  expect(patternsDiffer(patterns)).toBe(false);
});

it.each([
  [
    "Backlog",
    boardItem({ issueNumber: 73, status: "Backlog", state: "planned" }),
    "Backlog · not started",
  ],
  [
    "Refinement",
    boardItem({ issueNumber: 74, status: "Refinement", state: "planned" }),
    "Refinement · not started",
  ],
  [
    "Ready",
    boardItem({ issueNumber: 75, status: "Ready", state: "planned" }),
    "Ready · not started",
  ],
  [
    "Ready moved to Blocked",
    boardItem({
      issueNumber: 76,
      status: "Ready",
      state: "planned",
      blockedBy: [{ ref: "shop-app#1", closed: false }],
    }),
    "Blocked · not started",
  ],
  [
    "In progress",
    boardItem({
      issueNumber: 77,
      status: "In Progress",
      state: "in progress",
      updatedAt: NOW - 3 * 60 * MIN,
    }),
    "In progress · idle 3h 0m",
  ],
  [
    "In review",
    boardItem({
      issueNumber: 78,
      status: "In review",
      state: "review",
      updatedAt: NOW - 45 * MIN,
    }),
    "In review · idle 45m",
  ],
  [
    "Waiting",
    boardItem({
      issueNumber: 79,
      status: "In review",
      state: "review",
      waiting: { reason: "Needs a schema", freesWhen: "shop-app#1 merges", at: NOW - 2 * 60 * MIN },
    }),
    "Waiting · waiting 2h 0m",
  ],
] as const)("renders %s from its lifecycle and displayed column", (_name, item, expected) => {
  const { container } = render(
    <Kanban
      items={[item]}
      showRepo={false}
      prs={[]}
      crew={[]}
      needsYou={needsYouItems([])}
      now={NOW}
      tz="UTC"
      todayStart={NOW - 12 * 60 * MIN}
    />,
  );
  const pattern = container.querySelector<HTMLElement>(".kcard [data-work-pattern]");
  expect(pattern?.textContent).toBe(expected);
  expect(pattern?.dataset.workPattern).toBe(expected);
});
