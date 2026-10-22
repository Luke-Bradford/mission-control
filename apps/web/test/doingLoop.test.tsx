import type { CrewRow } from "@mc/core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { doingLine } from "../src/crew.ts";
import { DoingLine } from "../src/hud/DoingLine.tsx";
import { NOW, seatRow } from "./fixtures.ts";

const TZ = "UTC";

/** An idle crew seat with a review PR open and a loop in the given phase. */
const seat = (phase: "ci" | "review", text: string): CrewRow =>
  seatRow({
    hudState: "idle",
    note: null,
    review: { prNumber: 77, state: "open" },
    loop: { phase, text, prNumber: 77, parked: null },
  });

const rendered = (row: CrewRow): string =>
  render(<DoingLine row={row} now={NOW} tz={TZ} />).container.textContent ?? "";

describe("DoingLine and doingLine agree", () => {
  it("in ci the loop's step wins over the review PR line", () => {
    const row = seat("ci", "CI on abc1234");
    expect(doingLine(row, NOW, TZ)).toBe("CI on abc1234");
    expect(rendered(row)).toBe("CI on abc1234");
  });

  it("in review the PR line wins in both", () => {
    const row = seat("review", "In review · PR #77");
    expect(doingLine(row, NOW, TZ)).toBe("In review · PR #77");
    expect(rendered(row)).toBe("In review · PR #77");
  });
});
