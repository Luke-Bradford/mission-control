import { expect, it } from "vitest";
import { sameValue } from "../src/sameValue.ts";

it("compares plain values by content, in any key order", () => {
  expect(sameValue({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
  expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
  expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  expect(sameValue({ a: undefined }, { b: undefined })).toBe(false);
  expect(sameValue(null, {})).toBe(false);
  expect(sameValue([], {})).toBe(false);
  expect(sameValue(NaN, NaN)).toBe(true);
});
