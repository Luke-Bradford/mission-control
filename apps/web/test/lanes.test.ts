import { describe, expect, it } from "vitest";
import { ALL_LANE, lanesFor, MINE_LANE, resolveLane } from "../src/board/lanes.ts";
import { SESSION_ALL } from "../src/shell/session.ts";
import { boardItem, REPOS } from "./fixtures.ts";

describe("lanesFor", () => {
  it("All mine matches the configured assignee and has a GitHub query for the same repos", () => {
    const mine = lanesFor(REPOS, SESSION_ALL, "pilot").find((l) => l.name === "All mine");
    expect(mine).toBeDefined();
    expect(mine?.match(boardItem({ assignees: ["other", "PILOT"] }))).toBe(true);
    expect(mine?.match(boardItem({ assignees: ["other"] }))).toBe(false);
    expect(mine?.match(boardItem({ assignees: [] }))).toBe(false);
    expect(mine?.match(boardItem())).toBe(false);
    expect(mine?.query).toBe(
      "repo:octo-org/shop-app repo:octo-org/site-builder is:issue assignee:pilot",
    );
    expect(new URL(mine?.url ?? "").searchParams.get("q")).toBe(mine?.query);
  });
  it("All mine matches nothing and offers no link until the operator is known", () => {
    const mine = lanesFor(REPOS).find((l) => l.name === "All mine");
    expect(mine).toBeDefined();
    expect(mine?.match(boardItem({ assignees: ["pilot"] }))).toBe(false);
    expect(mine?.url).toBeNull();
  });
  it("All repos and All mine first, then one lane per repo with its GitHub query and project URL", () => {
    const lanes = lanesFor(REPOS);
    expect(lanes.map((l) => [l.id, l.name])).toEqual([
      [ALL_LANE, "All repos"],
      [MINE_LANE, "All mine"],
      ["shop-app", "shop-app"],
      ["site-builder", "site-builder"],
    ]);
    expect(lanes[0]?.query).toBe("repo:octo-org/shop-app repo:octo-org/site-builder is:issue");
    expect(lanes[0]?.url).toBeNull();
    expect(lanes[2]?.query).toBe("repo:octo-org/shop-app is:issue");
    expect(lanes[2]?.url).toBe("https://github.com/users/octo-org/projects/2");
  });

  it("a repo lane links the address GitHub reports for its Project", () => {
    const projectUrl = "https://github.com/orgs/octo-org/projects/2";
    const lanes = lanesFor(REPOS.map((r, i) => (i === 0 ? { ...r, projectUrl } : r)));
    expect(lanes[2]?.url).toBe(projectUrl);
    expect(lanes[3]?.url).toBe("https://github.com/users/octo-org/projects/3");
  });

  it("a repo lane matches only its repo's items", () => {
    const [all, , shopApp] = lanesFor(REPOS);
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

describe("lanesFor under a session", () => {
  it("SESSION_ALL offers every lane", () => {
    expect(lanesFor(REPOS, SESSION_ALL).map((l) => l.id)).toEqual([
      ALL_LANE,
      MINE_LANE,
      "shop-app",
      "site-builder",
    ]);
  });
  it("a session offers only that repo's lane, and every route and stored lane resolves to it", () => {
    const lanes = lanesFor(REPOS, "shop-app");
    expect(lanes.map((l) => l.id)).toEqual(["shop-app"]);
    expect(resolveLane(lanes, "site-builder", ALL_LANE, false).id).toBe("shop-app");
    expect(resolveLane(lanes, "site-builder", null, true).id).toBe("shop-app");
    expect(resolveLane(lanes, null, "gone", false).id).toBe("shop-app");
  });
});
