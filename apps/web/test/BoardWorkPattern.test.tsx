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

it("shows the idle age for unassigned In progress and In review cards", () => {
  const { container } = render(
    <Kanban
      items={[
        boardItem({
          issueNumber: 73,
          status: "In Progress",
          state: "in progress",
          updatedAt: NOW - 3 * 60 * MIN,
        }),
        boardItem({
          issueNumber: 74,
          status: "In review",
          state: "review",
          updatedAt: NOW - 45 * MIN,
        }),
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
    (card) => ({ text: card.textContent, value: card.dataset.workPattern }),
  );
  expect(patterns).toEqual([
    { text: "In progress · idle 3h 0m", value: "In progress · idle 3h 0m" },
    { text: "In review · idle 45m", value: "In review · idle 45m" },
  ]);
});
