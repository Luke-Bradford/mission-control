import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES,
  overrideProfile,
  type Profile,
  profileRouteText,
  profileStep,
  routeProfile,
} from "../src/index.ts";

const named = (name: string): Profile => {
  const p = DEFAULT_PROFILES.find((d) => d.name === name);
  if (p === undefined) throw new Error(name);
  return p;
};

describe("routeProfile", () => {
  it("routes by the first profile in order with a card label", () => {
    const a = routeProfile(DEFAULT_PROFILES, ["chore", "bug"], "M");
    expect(a.profile.name).toBe("bugfix");
    expect(a.route).toEqual({ by: "label", label: "bug" });
    expect(routeProfile(DEFAULT_PROFILES, ["docs"], "XL").profile.name).toBe("small-change");
  });

  it("routes by Size when no label matches", () => {
    for (const s of ["XS", "S"]) {
      expect(routeProfile(DEFAULT_PROFILES, ["area:x"], s).profile.name).toBe("small-change");
    }
    for (const s of ["M", "L", "XL"]) {
      const c = routeProfile(DEFAULT_PROFILES, [], s);
      expect(c.profile.name).toBe("feature");
      expect(c.route).toEqual({ by: "size", size: s });
    }
    const none = routeProfile(DEFAULT_PROFILES, [], null);
    expect(none.profile.name).toBe("feature");
    expect(none.route).toEqual({ by: "size", size: null });
  });

  it("throws when a fallback profile is missing", () => {
    expect(() => routeProfile([named("bugfix")], [], "M")).toThrow();
  });
});

describe("overrideProfile", () => {
  it("an override keeps the routed checks and records its reason", () => {
    const feature = { ...named("feature"), checks: ["test", "docs"] };
    const small = { ...named("small-change"), checks: ["lint", "test"] };
    const routed = routeProfile([small, feature], [], "M");
    expect(routed.profile.name).toBe("feature");
    const o = overrideProfile([small, feature], routed, {
      profile: "small-change",
      reason: "trivial",
      by: "FLIGHT",
    });
    expect(o?.profile.name).toBe("small-change");
    expect(o?.profile.checks).toEqual(["lint", "test", "docs"]);
    expect(o?.route).toEqual({ by: "override", from: "feature", who: "FLIGHT", reason: "trivial" });
    expect(
      overrideProfile([small, feature], routed, { profile: "nope", reason: "x", by: "planner" }),
    ).toBeNull();
  });
});

describe("profileStep and text", () => {
  it("asks web feature plans for the design question and defined KPIs", () => {
    const feature = named("feature");
    expect(feature.checklist).toContain(
      "For an apps/web ticket, Design names the page question and every KPI's definition, window and unit",
    );
  });

  it("names the step for the phase", () => {
    const f = named("feature");
    expect(profileStep(f, "working")).toBe("implement");
    expect(profileStep(f, "ci")).toBe("verify");
    expect(profileStep(f, "review")).toBe("review");
    expect(profileStep(f, "parked")).toBeNull();
    expect(profileStep(f, "done")).toBeNull();
  });

  it("describes each route", () => {
    expect(profileRouteText({ by: "label", label: "bug" })).toBe("picked by the label bug");
    expect(profileRouteText({ by: "size", size: "S" })).toBe("picked by Size S");
    expect(profileRouteText({ by: "size", size: null })).toBe(
      "picked with no template label and no Size",
    );
    expect(profileRouteText({ by: "override", from: "feature", who: "planner", reason: "r" })).toBe(
      "chosen by the planner over feature: r",
    );
  });
});
