// @vitest-environment node
import type { ChainNode, DependencyChain } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, HOUR, METRICS_VIEW, NOW, REPOS, seatRow } from "./fixtures.ts";
import { flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

const { renderAt } = browserSession();

/** The Design section's viewports the ticket names. */
const SIZES = [
  [1920, 940],
  [1920, 1080],
  [2560, 1440],
] as const;
const THEMES = ["light", "dark"] as const;
const PANEL_MIN = 360;
const SEATS_MIN = 260;

const node = (ref: string, over: Partial<ChainNode> = {}): ChainNode => ({
  ref,
  title: `Change ${ref}`,
  edge: "depends",
  waitedMs: HOUR,
  alsoWaitsOn: [],
  children: [],
  ...over,
});
/** Twelve chains, a few with more than 5 dependents, so the list is longer than any panel. */
const chains: DependencyChain[] = Array.from({ length: 12 }, (_, i) => ({
  repoId: "shop-app",
  root: node(`shop-app#${100 + i}`, {
    edge: null,
    children: Array.from({ length: i % 3 === 0 ? 7 : 2 }, (_, k) =>
      node(`shop-app#${200 + i * 10 + k}`),
    ),
  }),
  state: i % 4 === 0 ? "stuck" : i % 4 === 1 ? "with-you" : "moving",
  reason: "No owner for the next step",
  owner: i % 4 === 1 ? "operator" : "retro-1",
  seatId: i % 4 === 1 ? null : "retro-1",
  longestWaitMs: (40 - i) * HOUR,
  frees: ["shop-app#1"],
  stillWaiting: [],
}));

/** A long queue, so its content cannot take the first screen's height. */
const queue = Array.from({ length: 30 }, (_, i) =>
  ledgerEntry({ key: `work:${i}`, title: `Queued work ${i}`, next: `Next step ${i}` }),
);

const api = {
  "/api/flight/summary": flightSummary({ next: queue.map(summaryItem) }),
  "/api/flight/ledger?status=open": {
    session: "s1",
    entries: queue,
    more: false,
    nextOffset: null,
  },
  "/api/flight/brief": { session: "s1", sections: [] },
  "/api/flight/schedule": { session: "s1", entries: [] },
  "/api/flight/incoming": { entries: [] },
  "/api/drafts": [],
  "/api/drafts/history": [],
  "/api/operator/bootstrap": { token: "fixture-token" },
  "/api/dependencies": chains,
  "/api/prs/flow": { generatedAt: NOW, repos: [] },
  "/api/config": CONFIG,
  "/api/repos": REPOS,
  "/api/metrics": METRICS_VIEW,
  "/api/settings/crew-pause": null,
  "/api/flight": {
    seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
    decisions: [],
  },
  "/api/attention": [],
  "/api/attention/held": [],
  "/api/notifications": { open: [], handledToday: [] },
  "/api/crew?shape=summary": {
    rows: Array.from({ length: 11 }, (_, i) =>
      seatRow({ id: `guido-${i + 1}`, hudState: "blocked", ticket: `shop-app#${i + 5}` }),
    ),
    firstRunToday: null,
  },
};

describeRendered("Blocked chains in a browser", () => {
  for (const theme of THEMES) {
    it(
      `keeps its 360 px floor, scrolls inside itself and adds no page overflow: ${theme}`,
      async () => {
        for (const [width, height] of SIZES) {
          const label = `${width}x${height} ${theme}`;
          const page = await renderAt({
            page: "test/flightBrowser.html",
            width,
            height,
            colorScheme: theme,
            search: `?theme=${theme}`,
            api,
          });
          try {
            await page.click("#flight-tab-crew");
            await page.boxes("#chainsP .bc-row");
            const m = await page.evaluate(() => {
              const root = document.scrollingElement ?? document.documentElement;
              const crew = document.getElementById("flight-crew") as HTMLElement;
              const top = crew.getBoundingClientRect().top;
              const rect = (id: string) => {
                const r = (document.getElementById(id) as HTMLElement).getBoundingClientRect();
                return { top: r.top - top, bottom: r.bottom - top, height: r.height };
              };
              const chainsScroll = document.querySelector<HTMLElement>("#chainsP .bc-scroll");
              const seatsScroll = document.querySelector<HTMLElement>("#wifP .flight-panel-scroll");
              const seatsRect = rect("wifP");
              return {
                // What Seats needs to show all its rows: its box plus what its scroller cuts off.
                seatsNeed: seatsScroll
                  ? seatsRect.height + (seatsScroll.scrollHeight - seatsScroll.clientHeight)
                  : seatsRect.height,
                pageOverflow: root.scrollHeight - root.clientHeight,
                sideways: root.scrollWidth - root.clientWidth,
                screen: crew.clientHeight,
                seats: rect("wifP"),
                chains: rect("chainsP"),
                queue: rect("ledgerP"),
                listScrolls: chainsScroll
                  ? chainsScroll.scrollHeight - chainsScroll.clientHeight
                  : 0,
                headers: [...document.querySelectorAll("#chainsP th")].map((th) => th.textContent),
              };
            }, undefined);
            const gap = 12;
            expect(m.pageOverflow, label).toBeLessThanOrEqual(0);
            expect(m.sideways, label).toBeLessThanOrEqual(0);
            // Blocked chains keeps its floor and lies inside the tab's first screen.
            expect(m.chains.height, label).toBeGreaterThanOrEqual(PANEL_MIN - 0.5);
            expect(m.chains.bottom, label).toBeLessThanOrEqual(
              Math.max(m.screen, SEATS_MIN + PANEL_MIN + gap) + 1,
            );
            // Seats keeps all its rows unless the screen is too short, and then gives way first.
            expect(m.seats.height, label).toBeGreaterThanOrEqual(
              Math.min(m.seatsNeed, m.screen - PANEL_MIN - gap) - 2,
            );
            expect(m.seats.height, label).toBeGreaterThanOrEqual(SEATS_MIN - 0.5);
            // The queue sits below that screen, whatever its length.
            expect(m.queue.top, label).toBeGreaterThanOrEqual(m.chains.bottom - 1);
            expect(m.listScrolls, label).toBeGreaterThan(0);
            expect(m.headers, label).toEqual([
              "Work",
              "State",
              "What holds it",
              "Next owner",
              "Waited ▼",
              "Merge frees",
            ]);
            if (page.errors().length) throw new Error(page.errors().join("; "));
          } finally {
            await page.close();
          }
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 3,
    );
  }
});
