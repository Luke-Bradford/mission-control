import { expect, it } from "vitest";
import {
  type ChartFilter,
  FOCUS_PARAM,
  filterKeeps,
  filterLabel,
  focusFromSearch,
  searchWithFocus,
} from "../src/comms/commsFilter.ts";

const known = new Set(["dev-1", "retro-1", "crew", "CAPCOM"]);

it("reads a seat and a pair from the URL, and writes them back the same", () => {
  expect(focusFromSearch("?focus=seat:dev-1", known)).toEqual({ kind: "seat", id: "dev-1" });
  const pair = focusFromSearch("?focus=pair:retro-1,dev-1", known);
  // A pair is kept in a fixed order, so the same pair is always the same filter.
  expect(pair).toEqual({ kind: "pair", a: "dev-1", b: "retro-1" });
  for (const f of [pair, { kind: "seat", id: "crew" } as ChartFilter])
    expect(focusFromSearch(searchWithFocus("", f), known)).toEqual(f);
});

it("ignores a missing, malformed or unknown filter", () => {
  for (const s of [
    "",
    "?focus=",
    "?focus=seat:",
    "?focus=seat:nobody",
    "?focus=pair:dev-1",
    "?focus=pair:dev-1,dev-1",
    "?focus=pair:dev-1,x,retro-1",
    "?focus=bogus:dev-1",
    "?focus=dev-1",
  ])
    expect(focusFromSearch(s, known)).toBeNull();
});

it("keeps the other query parameters and drops the filter on clear", () => {
  const withIt = searchWithFocus("?ticket=%231", { kind: "seat", id: "dev-1" });
  expect(new URLSearchParams(withIt).get("ticket")).toBe("#1");
  expect(new URLSearchParams(withIt).get(FOCUS_PARAM)).toBe("seat:dev-1");
  expect(searchWithFocus(withIt, null)).toBe("?ticket=%231");
  expect(searchWithFocus("?focus=seat:dev-1", null)).toBe("");
});

it("keeps what a filter covers: a seat's links, or just the pair's", () => {
  const seat: ChartFilter = { kind: "seat", id: "dev-1" };
  const pair: ChartFilter = { kind: "pair", a: "dev-1", b: "retro-1" };
  expect(filterKeeps(null, "x", "y")).toBe(true);
  expect(filterKeeps(seat, "retro-1", "dev-1")).toBe(true);
  expect(filterKeeps(seat, "retro-1", "crew")).toBe(false);
  expect(filterKeeps(pair, "retro-1", "dev-1")).toBe(true);
  expect(filterKeeps(pair, "dev-1", "crew")).toBe(false);
});

it("names the filter for its chip", () => {
  const name = (id: string) => id.toUpperCase();
  expect(filterLabel({ kind: "seat", id: "dev-1" }, name)).toBe("DEV-1");
  expect(filterLabel({ kind: "pair", a: "dev-1", b: "retro-1" }, name)).toBe("DEV-1 ↔ RETRO-1");
});
