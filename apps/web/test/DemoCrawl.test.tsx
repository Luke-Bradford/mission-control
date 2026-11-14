import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { DEMO_NO_DATA, setDemo } from "../src/demo/mode.ts";
import { demoMisses } from "../src/demo/source.ts";
import { PAGE_PATHS, type Route, route, SETUP_TABS, tabOf } from "../src/router.ts";

/**
 * Every page, then every tab, segmented choice and select on it, one at a time: Demo must answer
 * every read they make, with no alert. The views it visited are printed so a reviewer can read them.
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
  setDemo(true);
});
afterEach(() => vi.unstubAllGlobals());

/**
 * The paths each router page is visited by. Typed on `Route["page"]`, so a page added to the
 * router without an entry here does not compile; an empty list fails the first test below.
 */
const PAGE_ROUTES: Record<Route["page"], readonly string[]> = {
  overview: ["/"],
  needs: ["/needs-you", "/needs-you/demo-design-signoff", "/needs-you/demo-picture-options"],
  flight: ["/flight"],
  board: ["/board", "/board/shop-app"],
  ticket: ["/tickets/shop-app/102"],
  agent: ["/agent", "/agent/dev-1", "/agent/flight-1"],
  comms: ["/comms", "/comms/crew", "/comms/agents/dev-1"],
  commsChart: ["/comms/chart"],
  qa: ["/qa", "/qa?view=history"],
  telemetry: ["/telemetry"],
  audit: ["/audit"],
  setup: SETUP_TABS.map((tab) => `/setup/${tab}`),
};
const ROUTES = Object.values(PAGE_ROUTES).flat();

it("covers every page of the router, each path resolving to the page it is listed under", () => {
  for (const [page, paths] of Object.entries(PAGE_ROUTES)) {
    expect(paths.length, `${page} has no crawl route`).toBeGreaterThan(0);
    for (const path of paths) expect(route(path)?.page, path).toBe(page);
  }
  // Every header page, by the page its own path shows.
  for (const path of Object.values(PAGE_PATHS)) {
    const r = route(path);
    expect(r, path).not.toBeNull();
    expect(ROUTES.some((p) => route(p) && tabOf(route(p) as Route) === tabOf(r as Route))).toBe(
      true,
    );
  }
});

/** What an empty page says in the app's own words; a page that says it has no demo data. */
const EMPTY_PHRASES = [DEMO_NO_DATA, "Nobody is waiting on you", "no longer open"] as const;
/** Evidence a page is busy: words that appear only with data, and pictures it must have loaded. */
const MUST_SHOW: Record<string, { text?: string; images?: number }> = {
  "/needs-you": { text: "address form layout" },
  "/needs-you/demo-design-signoff": { text: "Proposed", images: 2 },
  "/needs-you/demo-picture-options": { text: "Corner badge", images: 2 },
  "/qa": { images: 2 },
  "/agent": { text: "DEV-1" },
  "/board/shop-app": { text: "Retry failed payment webhooks" },
};
const CHOICE =
  "main [role=tab], main [role=tablist] button, main .seg button, main .tabs button, main nav button";
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 350))));
const alerts = () =>
  [...document.querySelectorAll("[role=alert]")].map((e) => e.textContent?.slice(0, 100));

it("every page, tab, choice and select ends in data", { timeout: 600_000 }, async () => {
  const visited: string[] = [];
  const problems: string[] = [];
  for (const route of ROUTES) {
    window.history.replaceState(null, "", route);
    const view = render(<App />);
    await settle();
    visited.push(route);
    let seen = demoMisses().length;
    const check = (what: string) => {
      const misses = demoMisses().slice(seen);
      seen = demoMisses().length;
      const bad = alerts();
      if (misses.length || bad.length)
        problems.push(`${what}: ${JSON.stringify({ misses: [...misses], bad })}`);
    };
    check(route);
    const main = document.querySelector("main")?.textContent ?? "";
    for (const phrase of EMPTY_PHRASES)
      if (main.includes(phrase)) problems.push(`${route}: says "${phrase}"`);
    const shows = MUST_SHOW[route];
    if (shows?.text && !main.includes(shows.text)) problems.push(`${route}: lacks "${shows.text}"`);
    // Pictures are read and decoded after the page paints, so give them a few seconds.
    for (let wait = 0; shows?.images && wait < 10; wait++) {
      if (document.querySelectorAll("main img").length >= shows.images) break;
      await settle();
    }
    const images = document.querySelectorAll("main img").length;
    if (shows?.images && images < shows.images)
      problems.push(`${route}: shows ${images} pictures, wants ${shows.images}`);
    const labels = [...document.querySelectorAll<HTMLElement>(CHOICE)].map((e) =>
      (e.textContent ?? "").trim(),
    );
    for (const label of [...new Set(labels)].filter(Boolean)) {
      const target = [...document.querySelectorAll<HTMLElement>(CHOICE)].find(
        (e) => (e.textContent ?? "").trim() === label,
      );
      if (!target) continue;
      await act(async () => void fireEvent.click(target));
      await settle();
      visited.push(`${route} › ${label}`);
      check(`${route} › ${label}`);
    }
    for (const select of [...document.querySelectorAll<HTMLSelectElement>("main select")]) {
      const index = [...document.querySelectorAll("main select")].indexOf(select);
      for (const option of [...select.options]) {
        const live = document.querySelectorAll<HTMLSelectElement>("main select")[index];
        if (!live) continue;
        await act(async () => void fireEvent.change(live, { target: { value: option.value } }));
        await settle();
        visited.push(`${route} › select ${index} = ${option.value}`);
        check(`${route} › select ${index} = ${option.value}`);
      }
    }
    view.unmount();
    window.history.replaceState(null, "", "/");
  }
  console.info(`DemoCrawl visited ${visited.length} views:\n${visited.join("\n")}`);
  expect(problems.join("\n")).toBe("");
});
