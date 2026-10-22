import { describe, expect, it } from "vitest";
import {
  areaLabelsFor,
  DEFAULT_HARD_RULES,
  DEFAULT_REPO_RULES,
  type RepoRules,
} from "../src/index.ts";

const rules: RepoRules = {
  ...DEFAULT_REPO_RULES,
  areas: {
    "area:server": ["apps/server/**"],
    "area:web": ["apps/web/**"],
    "area:core": ["packages/core/**"],
  },
};

describe("DEFAULT_REPO_RULES", () => {
  it("picks from Ready, promotes nothing, and guards the hard-rule files", () => {
    expect(DEFAULT_REPO_RULES).toEqual({
      pickFrom: ["Ready"],
      promoteBacklog: false,
      needs: ["done_when", "size"],
      areas: {},
      hardRules: DEFAULT_HARD_RULES,
      hardRulesSet: false,
      alwaysAsk: [],
    });
  });

  it("holds exactly the sixteen hard-rule globs", () => {
    expect(DEFAULT_HARD_RULES).toEqual([
      "apps/server/src/guard/**",
      "apps/server/src/mcp/**",
      "apps/server/src/runtime/**",
      "apps/server/src/engine/**",
      "apps/server/src/flight/**",
      "packages/core/src/guard.ts",
      "packages/core/src/flight.ts",
      "packages/core/src/loop.ts",
      "packages/core/src/review.ts",
      "packages/core/src/repo-rules.ts",
      "packages/core/src/runtime.ts",
      "loops/**",
      "roles/**",
      "CLAUDE.md",
      ".github/**",
      "config.example.yaml",
    ]);
  });

  it("cannot be mutated", () => {
    expect(() => DEFAULT_HARD_RULES.push("x")).toThrow(TypeError);
    expect(() => DEFAULT_REPO_RULES.pickFrom.push("x")).toThrow(TypeError);
    expect(() => DEFAULT_REPO_RULES.alwaysAsk.push("x")).toThrow(TypeError);
    expect(() => {
      DEFAULT_REPO_RULES.promoteBacklog = true;
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_REPO_RULES.areas.x = ["y"];
    }).toThrow(TypeError);
  });
});

describe("areaLabelsFor", () => {
  it("returns the labels whose globs lie inside the seat's area, in areas order", () => {
    expect(areaLabelsFor(rules, ["apps/server/**", "packages/core/**"])).toEqual([
      "area:server",
      "area:core",
    ]);
  });

  it("matches every label for a whole-checkout seat", () => {
    expect(areaLabelsFor(rules, [])).toEqual(["area:server", "area:web", "area:core"]);
  });

  it("needs every glob of a label inside the area", () => {
    const two: RepoRules = {
      ...rules,
      areas: { "area:both": ["apps/server/**", "apps/web/**"] },
    };
    expect(areaLabelsFor(two, ["apps/server/**"])).toEqual([]);
    expect(areaLabelsFor(two, ["apps/server/**", "apps/web/**"])).toEqual(["area:both"]);
  });

  it("never matches a label with no globs", () => {
    const empty: RepoRules = { ...rules, areas: { "area:none": [] } };
    expect(areaLabelsFor(empty, [])).toEqual([]);
    expect(areaLabelsFor(empty, ["apps/**"])).toEqual([]);
  });

  it("matches nothing for a seat whose area is elsewhere", () => {
    expect(areaLabelsFor(rules, ["docs/**"])).toEqual([]);
  });
});
