import { describe, expect, it } from "vitest";
import { fitList, SCROLL_SLACK_PX } from "../src/overview/useListFit.ts";

describe("fitList", () => {
  it("leaves a list that fits", () => {
    expect(fitList(200, 200, [40, 80], true)).toEqual({ kind: "none" });
  });
  it("grows a limited list that overflows by less than the slack", () => {
    expect(fitList(200, 200 + SCROLL_SLACK_PX - 1, [], true)).toEqual({
      kind: "grow",
      height: 239,
    });
  });
  it("does not grow a list held by its parent, and ends it at the last whole row", () => {
    expect(fitList(200, 230, [60, 120, 180, 230], false)).toEqual({ kind: "snap", height: 180 });
  });
  it("snaps a limited list that overflows by the slack or more", () => {
    expect(fitList(200, 200 + SCROLL_SLACK_PX, [90, 190, 240], true)).toEqual({
      kind: "snap",
      height: 190,
    });
  });
  it("leaves a list whose last row already ends at the foot", () => {
    expect(fitList(200, 400, [100, 200, 300], false)).toEqual({ kind: "none" });
  });
});
