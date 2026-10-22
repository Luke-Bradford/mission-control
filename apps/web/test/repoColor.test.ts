import { describe, expect, it } from "vitest";
import { repoColor } from "../src/repoColor.ts";
import { REPO_TOKEN_NAMES } from "../src/theme.ts";

const IDS = ["shop-app", "site-builder", "mission-control"];

describe("repoColor", () => {
  it("gives repos colours from the palette in config order", () => {
    expect(IDS.map((id) => repoColor(IDS, id))).toEqual(["var(--r1)", "var(--r2)", "var(--r3)"]);
  });

  it("keeps a repo's colour across calls", () => {
    expect(repoColor(IDS, "site-builder")).toBe(repoColor([...IDS], "site-builder"));
  });

  it("wraps after the palette", () => {
    const many = Array.from({ length: REPO_TOKEN_NAMES.length + 1 }, (_, i) => `r${i}`);
    expect(repoColor(many, many[REPO_TOKEN_NAMES.length] as string)).toBe(repoColor(many, "r0"));
  });

  it("has no colour for a repo that is not configured", () => {
    expect(repoColor(IDS, "elsewhere")).toBeNull();
  });
});
