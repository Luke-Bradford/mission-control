import { describe, expect, it } from "vitest";
import { str } from "../src/util.ts";

describe("str", () => {
  it("reads nonempty strings and supports the collector's empty fallback", () => {
    expect(str("text")).toBe("text");
    expect(str("text", "")).toBe("text");
    for (const value of [null, undefined, {}, [], 1, ""]) {
      expect(str(value)).toBeNull();
      expect(str(value, "")).toBe("");
    }
  });
});
