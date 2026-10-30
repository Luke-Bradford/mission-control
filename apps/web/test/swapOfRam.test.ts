import { expect, it } from "vitest";
import { swapOfRam } from "../src/fmt.ts";

const GIB = 2 ** 30;

it("shows swap in GB with its share of physical RAM", () => {
  expect(swapOfRam(6 * GIB, 24 * GIB)).toBe("6.0 GB (25% of RAM)");
});

it("shows a dash when swap was not measured", () => {
  expect(swapOfRam(null, 24 * GIB)).toBe("—");
  expect(swapOfRam(undefined, 24 * GIB)).toBe("—");
});

it("leaves the share out when RAM is unknown", () => {
  expect(swapOfRam(GIB, 0)).toBe("1.0 GB");
  expect(swapOfRam(GIB, null)).toBe("1.0 GB");
});
