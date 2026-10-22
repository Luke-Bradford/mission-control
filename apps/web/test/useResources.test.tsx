import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCES, useResources } from "../src/data.ts";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useResources", () => {
  it("keeps each result with its own resource as the list grows and shrinks between renders", async () => {
    stubFetch({
      "/api/boards/a": ["A"],
      "/api/boards/b": ["B"],
      "/api/boards/c": ["C"],
    });
    const refs = (ids: string[]) => ids.map((id) => RESOURCES.boards(id));
    const data = (r: { data?: unknown }[]) => r.map((x) => x.data);
    const { result, rerender } = renderHook(({ ids }) => useResources<string[]>(refs(ids)), {
      initialProps: { ids: ["a"] },
    });
    await vi.waitFor(() => expect(data(result.current)).toEqual([["A"]]));

    rerender({ ids: ["a", "b", "c"] });
    expect(result.current).toHaveLength(3);
    await vi.waitFor(() => expect(data(result.current)).toEqual([["A"], ["B"], ["C"]]));

    rerender({ ids: ["c", "a"] });
    expect(result.current).toHaveLength(2);
    expect(data(result.current)).toEqual([["C"], ["A"]]);

    rerender({ ids: [] });
    expect(result.current).toEqual([]);
  });
});
