import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { pictureBytes, pictureFor } from "../src/demo/picture.ts";

const id = (c: string) => c.repeat(64);
const pixel = (png: Uint8Array, x: number, y: number) => {
  // One IDAT chunk follows the 25-byte signature and header chunk.
  const length = new DataView(png.buffer, png.byteOffset).getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + length));
  const at = y * (240 * 3 + 1) + 1 + x * 3;
  return [raw[at], raw[at + 1], raw[at + 2]];
};

it("draws a valid PNG, and the before and proposed pictures differ", () => {
  const before = pictureBytes(pictureFor(`/api/attention-material-assets/${id("2")}`));
  const proposed = pictureBytes(pictureFor(`/api/attention-material-assets/${id("3")}`));
  expect([...before.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(Buffer.from(before).equals(Buffer.from(proposed))).toBe(false);
  // Not a flat white field: the header bar is blue and the page behind it dark.
  expect(pixel(before, 100, 10)).toEqual([0x2f, 0x6f, 0xed]);
  expect(pixel(before, 2, 300)).toEqual([0x20, 0x26, 0x2e]);
});

it("falls back to a generic page for any other route", () => {
  expect(pictureFor(`/api/qa/review-shots/${"f".repeat(32)}`)).toBe("generic");
  expect(pictureFor(`/api/attention-material-assets/${id("a")}`)).toBe("generic");
});
