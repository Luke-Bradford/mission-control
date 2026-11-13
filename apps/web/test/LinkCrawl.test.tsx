import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Click, crawlRoute, STAYS } from "./linkCrawl.tsx";
import { EVERYWHERE, LINK_MAP, type LinkRule, NAVIGATING_FILES } from "./linkMap.ts";

/**
 * Every page in Demo, every anchor on it clicked: where it went must be where the link map says,
 * and an anchor the map does not know fails too. The map is `linkMap.ts`; a button that navigates is
 * listed there as well.
 */
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

type Map = Record<string, { routes: string[]; rules: LinkRule[] }>;

/** What is wrong with each click: no rule for it, or a target the rule does not allow. */
export function problemsOf(clicks: Click[], rules: LinkRule[]): string[] {
  const out: string[] = [];
  for (const c of clicks) {
    if (c.kind === "button" && c.target === STAYS) continue; // acts in place
    const rule = rules.find((r) => r.text.test(c.text) && (!r.cls || r.cls.test(c.cls)));
    if (!rule)
      out.push(
        `${c.route}: "${c.text}" (${c.kind}) is not in the link map; it goes to ${c.target}`,
      );
    else if (!rule.target.test(c.target))
      out.push(
        `${c.route}: "${c.text}" goes to ${c.target}, the map says ${rule.target} (${rule.why})`,
      );
  }
  return out;
}

const rulesFor = (map: Map, route: string): LinkRule[] => [
  ...Object.values(map).flatMap((p) => (p.routes.includes(route) ? p.rules : [])),
  ...EVERYWHERE,
];

it("every router page has a map entry with a route to visit", () => {
  const pages = Object.keys(LINK_MAP).sort();
  expect(pages).toEqual(
    [
      "agent",
      "audit",
      "board",
      "comms",
      "commsChart",
      "flight",
      "needs",
      "overview",
      "qa",
      "setup",
      "telemetry",
      "ticket",
    ].sort(),
  );
  for (const [page, entry] of Object.entries(LINK_MAP)) expect(entry.routes, page).not.toEqual([]);
  expect(LINK_MAP.setup.routes).toHaveLength(7);
});

it("fails on a target that differs from the map, and on a link the map lacks", () => {
  const click = (text: string, target: string): Click => ({
    route: "/board",
    text,
    cls: "",
    kind: "a",
    target,
  });
  const rules = rulesFor(LINK_MAP, "/board");
  expect(problemsOf([click("Flight", "/flight")], rules)).toEqual([]);
  expect(problemsOf([click("Flight", "/agent/dev-1")], rules)[0]).toContain("the map says");
  expect(problemsOf([click("A link nobody mapped", "/flight")], rules)[0]).toContain(
    "not in the link map",
  );
  // A button that moves history is a link too: Header's Setup button sent to /x must show up.
  const setup = { ...click("Setup", "/x"), kind: "button" as const };
  expect(problemsOf([setup], rulesFor(LINK_MAP, "/board"))[0]).toContain("goes to /x");
  const ktitle = { ...click("Cache it", "/agent/dev-1"), cls: "ktitle" };
  expect(problemsOf([ktitle], rules)[0]).toContain("goes to /agent/dev-1");
});

it("every navigating source file is in the map, and each mapped file still exists", () => {
  const navigating = globSync("src/**/*.{ts,tsx}", { cwd: join(import.meta.dirname, "..") }).filter(
    (f) =>
      /navigate\(|openItem\(|followLink\(|href=/.test(
        readFileSync(join(import.meta.dirname, "..", f), "utf8"),
      ),
  );
  expect(navigating.sort()).toEqual(Object.keys(NAVIGATING_FILES).sort());
});

it("the crawl reaches the body of a page, not just the header", { timeout: 300_000 }, async () => {
  const setup = await crawlRoute("/setup/repos");
  // the header and tabs alone are about 19 things; the page's own body adds more in Demo
  expect(setup.length).toBeGreaterThan(25);
  const board = await crawlRoute("/board");
  expect(board.some((c) => /\bktitle\b/.test(c.cls))).toBe(true);
  expect(board.some((c) => c.text.startsWith("You:"))).toBe(true);
});

it("every page, in Demo, goes where the map says", { timeout: 600_000 }, async () => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [, entry] of Object.entries(LINK_MAP)) {
    for (const route of entry.routes) {
      const clicks = await crawlRoute(route);
      seen.add(route);
      problems.push(...problemsOf(clicks, rulesFor(LINK_MAP, route)));
    }
  }
  console.info(`LinkCrawl visited ${[...seen].join(" ")}`);
  expect([...new Set(problems)]).toEqual([]);
});
