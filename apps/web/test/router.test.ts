import { describe, expect, it } from "vitest";
import {
  agentPath,
  boardPath,
  isPopout,
  itemPath,
  legacyRedirect,
  PAGE_PATHS,
  route,
  SETUP_TABS,
  setupPath,
  ticketPath,
} from "../src/router.ts";

describe("route()", () => {
  it.each([
    ["/", { page: "overview" }],
    ["/flight", { page: "flight" }],
    ["/flight/", { page: "flight" }],
    ["/board", { page: "board", repoId: null, ticket: null }],
    ["/board/", { page: "board", repoId: null, ticket: null }],
    ["/board/shop-app", { page: "board", repoId: "shop-app", ticket: null }],
    ["/board/a%20b", { page: "board", repoId: "a b", ticket: null }],
    ["/board/shop-app/3227", { page: "board", repoId: "shop-app", ticket: 3227 }],
    ["/board/shop-app/3227/", { page: "board", repoId: "shop-app", ticket: 3227 }],
    ["/agent", { page: "agent", id: null }],
    ["/agent/shop-app-ta", { page: "agent", id: "shop-app-ta" }],
    ["/agent/a%20b/", { page: "agent", id: "a b" }],
    ["/comms", { page: "comms", item: null }],
    ["/comms/esc:shop-app%233227", { page: "comms", item: "esc:shop-app#3227" }],
    ["/comms/stall%3Ashop-app-ta%3Ar-12", { page: "comms", item: "stall:shop-app-ta:r-12" }],
    ["/telemetry", { page: "telemetry" }],
    ["/setup", { page: "setup", tab: "sessions" }],
    ["/setup/repos", { page: "setup", tab: "repos" }],
    ["/setup/sources", { page: "setup", tab: "sources" }],
    ["/setup/access/", { page: "setup", tab: "access" }],
    ["/setup/nope", { page: "setup", tab: "sessions" }],
  ])("%s", (path, expected) => {
    expect(route(path)).toEqual(expected);
  });

  it.each([
    "/agent/%E0%A4%A",
    "/comms/%zz",
    "/board/%",
    "/board/shop-app/0",
    "/board/shop-app/007",
    "/board/shop-app/1.5",
    "/board/shop-app/99999999999999999999",
    "/board/shop-app/12/x",
    "/agent/a/b",
    "/nope",
    "/agents/shop-app-ta",
    "/settings",
  ])("%s is not a route", (path) => {
    expect(route(path)).toBeNull();
  });

  it("knows the seven setup tabs", () => {
    expect(SETUP_TABS).toEqual([
      "sessions",
      "repos",
      "loops",
      "accounts",
      "roles",
      "sources",
      "access",
    ]);
    for (const tab of SETUP_TABS) expect(route(setupPath(tab))).toEqual({ page: "setup", tab });
  });
});

describe("isPopout()", () => {
  it.each([
    ["?popout=1", true],
    ["popout=1", true],
    ["?x=2&popout=1", true],
    ["", false],
    ["?popout=0", false],
    ["?popout", false],
  ])("%s → %s", (search, expected) => {
    expect(isPopout(search)).toBe(expected);
  });

  it("route() keeps the page of a popped-out agent", () => {
    const u = new URL(`http://h${agentPath("shop-app-ta")}?popout=1`);
    expect(route(u.pathname)).toEqual({ page: "agent", id: "shop-app-ta" });
    expect(isPopout(u.search)).toBe(true);
  });
});

describe("path helpers", () => {
  it("encode every part and round-trip through route()", () => {
    expect(agentPath("a b")).toBe("/agent/a%20b");
    expect(boardPath("a/b")).toBe("/board/a%2Fb");
    expect(ticketPath("shop-app", 3227)).toBe("/board/shop-app/3227");
    expect(itemPath("esc:shop-app#3227")).toBe("/comms/esc%3Ashop-app%233227");
    expect(route(itemPath("esc:shop-app#3227"))).toEqual({
      page: "comms",
      item: "esc:shop-app#3227",
    });
    expect(route(agentPath("x/y"))).toEqual({ page: "agent", id: "x/y" });
    expect(PAGE_PATHS).toEqual({
      overview: "/",
      flight: "/flight",
      board: "/board",
      agent: "/agent",
      comms: "/comms",
      telemetry: "/telemetry",
      setup: "/setup",
    });
  });
});

describe("legacyRedirect()", () => {
  it.each([
    ["/agents/shop-app-ta", "", "/agent/shop-app-ta"],
    ["/agents/a%20b/", "", "/agent/a%20b"],
    ["/loops/shop-app-ta", "", "/agent/shop-app-ta"],
    ["/agents", "", "/"],
    ["/agents/", "", "/"],
    ["/loops", "", "/"],
    ["/needs", "", "/comms"],
    ["/needs/", "", "/comms"],
    ["/needs-you", "", "/comms"],
    ["/needs-you/", "", "/comms"],
    ["/cto", "", "/flight"],
    ["/metrics", "", "/telemetry"],
    ["/metrics/", "", "/telemetry"],
    ["/boards", "", "/board"],
    ["/boards/shop-app", "", "/board/shop-app"],
    ["/config", "", "/setup/sources#glossary"],
    ["/config", "#glossary", "/setup/sources#glossary"],
    ["/config/", "", "/setup/sources#glossary"],
    ["/settings", "", "/setup"],
    ["/settings", "#glossary", "/setup/sources#glossary"],
    ["/settings/", "#other", "/setup"],
  ])("%s%s → %s", (from, hash, to) => {
    expect(legacyRedirect(from, hash)).toBe(to);
  });

  it("sends an old needs link to the same item as its comms path", () => {
    const to = legacyRedirect("/needs/shop-app%233227", "");
    expect(to).toBe("/comms/esc%3Ashop-app%233227");
    expect(route(to ?? "")).toEqual({ page: "comms", item: "esc:shop-app#3227" });
    expect(route(to ?? "")).toEqual(route("/comms/esc:shop-app%233227"));
  });

  it("is null for anything else", () => {
    expect(legacyRedirect("/nope", "")).toBeNull();
    expect(legacyRedirect("/needs/%zz", "")).toBeNull();
    expect(legacyRedirect("/", "")).toBeNull();
  });
});
