import { describe, expect, it } from "vitest";
import { elapsed } from "../src/fmt.ts";
import { MIN } from "./fixtures.ts";

describe("elapsed", () => {
  it.each([
    [0, "0m"],
    [59, "59m"],
    [60, "1h 0m"],
    [933, "15h 33m"],
    [1440, "1d 0h"],
    [3 * 1440, "3d 0h"],
    [2 * 1440 + 3 * 60, "2d 3h"],
    [-1, "0m"],
    [59.9, "59m"],
  ])("formats %s minutes as %s", (minutes, expected) => {
    expect(elapsed(Math.max(0, minutes) * MIN)).toBe(expected);
  });
});
