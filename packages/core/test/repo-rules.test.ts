import { describe, expect, it } from "vitest";
import {
  areaLabelsFor,
  claimedText,
  DEFAULT_HARD_RULES,
  DEFAULT_REPO_RULES,
  dependsOn,
  effectiveHardRules,
  eligibleToStart,
  FLIGHT_FLOOR_PATHS,
  inLane,
  otherLaneText,
  type RepoRules,
  researchText,
  type StartCheck,
  startClosedText,
  startMissingNeedsText,
  startNeedsPlanText,
  ticketHasRunText,
  twoAreasText,
  waitsOnText,
  wrongAreaText,
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
      hardRulesBy: "operator",
      alwaysAsk: [],
    });
  });

  it("holds the fixed hard-rule globs", () => {
    expect(DEFAULT_HARD_RULES).toEqual([
      "apps/server/src/away.ts",
      "apps/server/src/guard/**",
      "apps/server/src/mcp/**",
      "apps/server/src/runtime/**",
      "apps/server/src/engine/**",
      "apps/server/src/flight/**",
      "packages/core/src/away.ts",
      "packages/core/src/guard.ts",
      "packages/core/src/flight.ts",
      "packages/core/src/loop.ts",
      "packages/core/src/repo-rules.ts",
      "packages/core/src/runtime.ts",
      "apps/server/src/update.ts",
      "apps/server/src/config.ts",
      "apps/server/src/crew-apply.ts",
      "packages/core/src/review.ts",
      "loops/**",
      "roles/**",
      "CLAUDE.md",
      ".github/**",
      "config.example.yaml",
    ]);
  });

  it("effectiveHardRules adds the defaults on a superuser repo only", () => {
    const own = { hardRules: ["x/**"] };
    expect(effectiveHardRules(own, "standard")).toEqual(["x/**"]);
    expect(effectiveHardRules(own, "superuser")).toEqual([
      ...new Set(["x/**", ...DEFAULT_HARD_RULES, ...FLIGHT_FLOOR_PATHS]),
    ]);
    expect(effectiveHardRules({ hardRules: [] }, "superuser")).toEqual([
      ...new Set([...DEFAULT_HARD_RULES, ...FLIGHT_FLOOR_PATHS]),
    ]);
    expect(effectiveHardRules(own, "superuser")).toEqual(
      expect.arrayContaining([...FLIGHT_FLOOR_PATHS]),
    );
    // The fixed floor is included even when the repo omits it.
    expect(FLIGHT_FLOOR_PATHS).toEqual(["CLAUDE.md", ".github/**"]);
    expect(DEFAULT_HARD_RULES).toEqual(expect.arrayContaining(["CLAUDE.md", ".github/**"]));
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

describe("dependsOn and inLane", () => {
  it("reads the issues on Depends on lines only, once each", () => {
    const body = "Depends on #3 and #5\nSee #9\nalso depends on: #3\n";
    expect(dependsOn(body)).toEqual([3, 5]);
  });

  it("ignores reverse dependencies and unrelated references", () => {
    expect(
      dependsOn(
        "#338 depends on this ticket\nSee #9; depends on #8\n- Depends on #3 and #5\nDepends on: #5",
      ),
    ).toEqual([3, 5]);
  });

  it("starts every card when the hub has no lane", () => {
    expect(inLane(["lane:home", "lane:work"], undefined, false)).toBe(true);
  });

  it("starts a card of its own lane only", () => {
    expect(inLane(["lane:home"], "home", false)).toBe(true);
    expect(inLane(["lane:work"], "home", true)).toBe(false);
    expect(inLane(["lane:home", "lane:work"], "home", true)).toBe(false);
  });

  it("starts a card with no lane label only on the default-lane hub", () => {
    expect(inLane([], "home", false)).toBe(false);
    expect(inLane([], "home", true)).toBe(true);
  });
});

describe("eligibleToStart", () => {
  const ref = "mc#7";
  const base = (over: Partial<StartCheck> = {}): StartCheck => ({
    repoId: "mc",
    issue: 7,
    card: {
      labels: ["area:server"],
      assignees: [],
      blockedBy: [],
      size: "S",
      status: "Ready",
      state: "planned",
      closed: false,
    },
    rules: {
      areas: { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] },
      needs: ["done_when", "size"],
    },
    seat: { call: "GUIDO-1", area: ["apps/server/**"], loop: "build" },
    login: "me",
    hasRun: false,
    lane: undefined,
    laneDefault: false,
    body: "## Done when\n- x\n",
    closed: () => true,
    ...over,
  });
  const card = (over: Partial<StartCheck["card"]>): Partial<StartCheck> => ({
    card: { ...base().card, ...over },
  });

  it("gives null for an eligible card", () => {
    expect(eligibleToStart(base())).toBeNull();
  });

  it("0: refuses a closed card, or one in Done, before any other check", () => {
    const text = startClosedText(ref);
    expect(text).toBe("Not started: mc#7 is closed");
    expect(eligibleToStart(base(card({ closed: true })))).toBe(text);
    expect(eligibleToStart(base(card({ status: "Done" })))).toBe(text);
    expect(eligibleToStart(base({ ...card({ closed: true }), hasRun: true, lane: "work" }))).toBe(
      text,
    );
  });

  it("1: refuses another lane, or none", () => {
    expect(
      eligibleToStart(base({ lane: "work", ...card({ labels: ["area:server", "lane:home"] }) })),
    ).toBe(otherLaneText(ref, ["lane:home"], "work"));
    expect(eligibleToStart(base({ lane: "work" }))).toBe(
      "Not started: mc#7 has no lane label; this hub starts only lane:work cards.",
    );
  });

  it("2: refuses two areas", () => {
    expect(eligibleToStart(base(card({ labels: ["area:server", "area:web"] })))).toBe(
      twoAreasText(ref, ["area:server", "area:web"]),
    );
  });

  it("3: refuses no area label, unless the rules name none", () => {
    expect(eligibleToStart(base(card({ labels: [] })))).toBe(
      "Not started: mc#7 has no area label.",
    );
    expect(
      eligibleToStart(base({ ...card({ labels: [] }), rules: { areas: {}, needs: [] } })),
    ).toBeNull();
  });

  it("4: refuses an area that is not the seat's", () => {
    expect(eligibleToStart(base(card({ labels: ["area:web"] })))).toBe(
      wrongAreaText("GUIDO-1", ref, ["area:web"]),
    );
  });

  it("5: refuses a ticket that has a run", () => {
    expect(eligibleToStart(base({ hasRun: true }))).toBe(ticketHasRunText(ref));
  });

  it("6: refuses a card assigned to another login", () => {
    expect(eligibleToStart(base(card({ assignees: ["other", "me"] })))).toBe(
      claimedText(ref, ["other"]),
    );
  });

  it("7: refuses open blockers and open Depends on issues, once each", () => {
    const c = base({
      ...card({
        blockedBy: [
          { ref: "mc#3", closed: false },
          { ref: "mc#4", closed: true },
        ],
      }),
      body: "## Done when\n- x\nDepends on #3, #5\n",
      closed: (n) => (n === 3 ? false : undefined),
    });
    expect(eligibleToStart(c)).toBe(waitsOnText(ref, ["mc#3", "mc#5"]));
  });

  it("8: refuses a research ticket to a developer seat only", () => {
    const research = card({ labels: ["area:server", "research"] });
    expect(eligibleToStart(base(research))).toBe(researchText(ref));
    expect(
      eligibleToStart(base({ ...research, seat: { ...base().seat, loop: "plan" } })),
    ).toBeNull();
  });

  it("9: refuses a missing Done when or Size", () => {
    const text = startMissingNeedsText(ref, ["done_when", "size"]);
    const c = base({ ...card({ size: null }), body: "text" });
    expect(eligibleToStart(c)).toBe(text);
    expect(eligibleToStart({ ...c, seat: { ...c.seat, loop: "plan" } })).toBe(text);
  });

  it("10: refuses Size M without a plan, for a developer seat only", () => {
    const m = base(card({ size: "M" }));
    expect(eligibleToStart(m)).toBe(startNeedsPlanText(ref, "M"));
    expect(eligibleToStart({ ...m, body: "## Done when\n- x\n## Plan\n" })).toBeNull();
    expect(eligibleToStart({ ...m, seat: { ...m.seat, loop: "plan" } })).toBeNull();
  });

  it("a profile that needs no plan lets an M build start without one", () => {
    const m = base(card({ size: "M" }));
    expect(eligibleToStart({ ...m, planRequired: false })).toBeNull();
    expect(eligibleToStart({ ...m, planRequired: true })).toBe(startNeedsPlanText(ref, "M"));
  });

  it("gives the first refusal", () => {
    expect(eligibleToStart(base({ lane: "work", hasRun: true }))).toBe(
      otherLaneText(ref, [], "work"),
    );
  });

  it("skips the body checks with a null body, but not an open blocker", () => {
    const c = base({ ...card({ size: "M" }), body: null, closed: () => false });
    expect(eligibleToStart(c)).toBeNull();
    const blocked = { ...c, ...card({ size: "M", blockedBy: [{ ref: "mc#3", closed: false }] }) };
    expect(eligibleToStart(blocked)).toBe(waitsOnText(ref, ["mc#3"]));
  });
});
