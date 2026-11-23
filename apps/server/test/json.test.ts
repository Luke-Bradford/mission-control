import { describe, expect, it, vi } from "vitest";
import { parseJson } from "../src/json.ts";

describe("parseJson", () => {
  it("reads well-formed text", () => {
    expect(parseJson<number[]>("[1,2]", [])).toEqual([1, 2]);
  });
  it("gives the fallback for malformed text and reports it", () => {
    const seen = vi.fn();
    expect(parseJson<string[]>("{oops", [], seen)).toEqual([]);
    expect(seen).toHaveBeenCalledOnce();
  });
  it("gives the fallback for null and non-string input", () => {
    expect(parseJson<string[]>(null, ["x"])).toEqual(["x"]);
    expect(parseJson<string[]>(undefined, [])).toEqual([]);
  });
});
