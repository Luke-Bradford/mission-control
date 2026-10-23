import { describe, expect, it } from "vitest";
import { ALL_LANE, lanesFor, resolveLane } from "../src/board/lanes.ts";
import { boardItem, REPOS } from "./fixtures.ts";

describe("lanesFor", () => {
  it("All repos first, then one lane per repo with its GitHub query and project URL", () => {
    const lanes = lanesFor(REPOS);
    expect(lanes.map((l) => [l.id, l.name])).toEqual([
      [ALL_LANE, "All repos"],
      ["shop-app", "shop-app"],
      ["site-builder", "site-builder"],
    ]);
    expect(lanes[0]?.query).toBe("repo:octo-org/shop-app repo:octo-org/site-builder is:issue");
    expect(lanes[0]?.url).toBeNull();
    expect(lanes[1]?.query).toBe("repo:octo-org/shop-app is:issue");
    expect(lanes[1]?.url).toBe("https://github.com/users/octo-org/projects/2");
  });

  it("a repo lane links the address GitHub reports for its Project", () => {
    const projectUrl = "https://github.com/orgs/octo-org/projects/2";
    const lanes = lanesFor(REPOS.map((r, i) => (i === 0 ? { ...r, projectUrl } : r)));
    expect(lanes[1]?.url).toBe(projectUrl);
    expect(lanes[2]?.url).toBe("https://github.com/users/octo-org/projects/3");
  });

  it("a repo lane matches only its repo's items", () => {
    const [all, shopApp] = lanesFor(REPOS);
    const a = boardItem({ repoId: "shop-app" });
    const b = boardItem({ repoId: "site-builder" });
    expect([a, b].filter((i) => all?.match(i))).toEqual([a, b]);
    expect([a, b].filter((i) => shopApp?.match(i))).toEqual([a]);
  });
});

describe("resolveLane", () => {
  const lanes = lanesFor(REPOS);
  it("the route's repo wins over the stored lane", () => {
    expect(resolveLane(lanes, "site-builder", "shop-app").id).toBe("site-builder");
  });
  it("falls back to the stored lane, then All repos", () => {
    expect(resolveLane(lanes, null, "shop-app").id).toBe("shop-app");
    expect(resolveLane(lanes, null, "gone").id).toBe(ALL_LANE);
    expect(resolveLane(lanes, "gone", null).id).toBe(ALL_LANE);
  });
});

describe("resolveLane on a ticket route", () => {
  const lanes = lanesFor(REPOS);
  it("the route's repo does not pick the lane; the stored lane does", () => {
    expect(resolveLane(lanes, "shop-app", ALL_LANE, true).id).toBe(ALL_LANE);
    expect(resolveLane(lanes, "shop-app", "site-builder", true).id).toBe("site-builder");
    expect(resolveLane(lanes, "shop-app", null, true).id).toBe(ALL_LANE);
  });
  it("off a ticket route the route's repo still wins", () => {
    expect(resolveLane(lanes, "shop-app", ALL_LANE, false).id).toBe("shop-app");
  });
});

describe("session and lane independence", () => {
  it("a single repo still offers the All repos lane", () => {
    expect(lanesFor(REPOS.slice(0, 1)).map((l) => l.id)).toEqual([ALL_LANE, "shop-app"]);
  });

  it("a session id does not name a repo lane", () => {
    const lanes = lanesFor(REPOS);
    expect(resolveLane(lanes, "s1", null).id).toBe(ALL_LANE);
    expect(resolveLane(lanes, "s1", "shop-app").id).toBe("shop-app");
  });
});
