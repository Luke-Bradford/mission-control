import { needsYouItems } from "@mc/core";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Kanban } from "../src/board/Kanban.tsx";
import { boardItem, MIN, NOW } from "./fixtures.ts";

const patternsDiffer = (patterns: readonly string[]) =>
  patterns.every((value, index) => !index || value !== patterns[index - 1]);

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
  expect(patterns).toEqual(["Closed|today|—", "Closed|today|—"]);
  expect(patternsDiffer(patterns)).toBe(false);
});
