// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { brief, CONFIG, HOUR, item, METRICS_VIEW, MIN, NOW, REPOS, seatRow } from "./fixtures.ts";
import { flightSummary, ledgerEntry, summaryItem } from "./flightSummaryFixture.ts";

const decision = (id: number, at: number, over: Record<string, unknown> = {}) => ({
  id,
  at,
  kind: "answer",
  seatId: "guido-1",
  targetRunId: null,
  ref: "shop-app#5",
  questionId: null,
  about: `shop-app#5: which port should the preview use (${id})?`,
  decision: "Use 5174, the one the config already names.",
  basis: "The config's preview port is 5174 and nothing else listens there.",
  ...over,
});

const work = ledgerEntry({
  key: "work:5",
  refs: ["#5"],
  next: "Get RETRO's verdict",
  due: NOW + HOUR,
});

const LONG =
  "A very long line of text that goes on and on about the cache, the queue and the port. "
    .repeat(4)
    .slice(0, 300);

type Scenario = "empty" | "one" | "long" | "many";

/** What the hub would answer for the page in each edge case. */
function apiFor(scenario: Scenario) {
  const n = scenario === "empty" ? 0 : scenario === "many" ? 50 : 1;
  const text = (t: string, i: number) => (scenario === "long" ? `${LONG} ${i}` : `${t} ${i}`);
  const decisions = Array.from({ length: n }, (_, i) =>
    decision(i + 1, NOW - (i + 1) * 20 * MIN, {
      about: text("shop-app#5: which port should the preview use", i),
      decision: text("Use 5174", i),
      basis: text("The config names it", i),
    }),
  );
  const attention = Array.from({ length: n }, (_, i) =>
    item({
      key: `q:${i}`,
      kind: "question",
      text: text("Which port should the preview use?", i),
      brief: brief(),
    }),
  );
  const rows = Array.from({ length: n }, (_, i) =>
    seatRow({
      id: `guido-${i + 1}`,
      hudState: i % 2 ? "blocked" : "running",
      ticket: `shop-app#${i + 5}`,
      ticketTitle: text("Stop the race", i),
    }),
  );
  return {
    ...base,
    "/api/flight": {
      seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
      decisions,
      wake: { lastWakeAt: NOW, wokeOn: ["q (1)"], nextWakeAt: NOW + 30 * MIN },
    },
    "/api/attention": attention,
    "/api/crew": { rows, firstRunToday: null },
    "/api/flight/summary": flightSummary({
      headline: scenario === "long" ? LONG : "The crew is shipping; one review needs attention.",
      next: n ? [summaryItem(work)] : [],
    }),
    "/api/flight/ledger?status=open": {
      session: "s1",
      entries: n ? [work] : [],
      more: false,
      nextOffset: null,
    },
  };
}

const base = {
  "/api/config": CONFIG,
  "/api/repos": REPOS,
  "/api/metrics": METRICS_VIEW,
  "/api/settings/crew-pause": null,
  "/api/flight/brief": { session: "s1", sections: [] },
  "/api/flight/schedule": { session: "s1", entries: [] },
  "/api/flight/incoming": { entries: [] },
  "/api/drafts": [],
  "/api/drafts/history": [],
  "/api/notifications": { open: [], handledToday: [] },
  "/api/attention/held": [],
};

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "flight-shots");
const TABS = ["needs", "did", "crew", "knows"] as const;
/** The sizes the HUD system checks: three widths at 1000 tall, and a short window. */
const SIZES = [
  { width: 1280, height: 1000 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1000 },
  { width: 1600, height: 700 },
] as const;
const SCENARIOS: Scenario[] = ["empty", "one", "long", "many"];

describeRendered("FLIGHT page in a browser", () => {
  for (const scenario of SCENARIOS) {
    it.each(SIZES)(
      `${scenario} data fits $width×$height in light and dark: a short strip, nothing clipped, every panel reachable`,
      async ({ width, height }) => {
        mkdirSync(SHOTS, { recursive: true });
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/flightBrowser.html",
            width,
            height,
            colorScheme,
            api: apiFor(scenario),
          });
          for (const tab of TABS) {
            const label = `${scenario} ${tab} ${colorScheme}`;
            await page.click(`#flight-tab-${tab}`);
            await page.boxes(`#flight-${tab} .panel`);
            const overflow = await page.evaluate((id) => {
              const body = document.getElementById(`flight-${id}`) as HTMLElement;
              return {
                page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                body: body.scrollWidth - body.clientWidth,
              };
            }, tab);
            expect(overflow, label).toEqual({ page: 0, body: 0 });
            expect(
              await page.reachable(`#flight-${tab} .panel`, `#flight-${tab}`),
              label,
            ).not.toContain(false);
            for (const box of await page.boxes(`#flight-${tab} .panel`)) {
              expect(box.height, label).toBeGreaterThan(40);
              expect(box.x + box.width, label).toBeLessThanOrEqual(width);
            }
            await page.screenshot(
              join(SHOTS, `flight-${scenario}-${tab}-${colorScheme}-${width}x${height}.png`),
            );
          }
          // one line of status; a 300-character headline truncates rather than growing the strip
          expect((await page.box(".flight-strip")).height).toBeLessThan(120);
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 2,
    );
  }
});
