// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import {
  brief,
  CONFIG,
  crewRow,
  HOUR,
  item,
  METRICS_VIEW,
  MIN,
  NOW,
  REPOS,
  seatRow,
} from "./fixtures.ts";
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

const api = {
  "/api/config": CONFIG,
  "/api/repos": REPOS,
  "/api/metrics": METRICS_VIEW,
  "/api/settings/crew-pause": null,
  "/api/flight": {
    seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "idle", live: true },
    decisions: [
      decision(1, NOW - 5 * HOUR),
      decision(2, NOW - 5 * HOUR + 3 * MIN, { kind: "message", decision: "Rebase on main now." }),
      decision(3, NOW - HOUR, { kind: "close", about: "shop-app#7: duplicate" }),
    ],
  },
  "/api/flight/summary": flightSummary({ next: [summaryItem(work)] }),
  "/api/flight/brief": { session: "s1", sections: [] },
  "/api/flight/ledger?status=open": {
    session: "s1",
    entries: [work],
    more: false,
    nextOffset: null,
  },
  "/api/flight/schedule": { session: "s1", entries: [] },
  "/api/flight/incoming": { entries: [] },
  "/api/drafts": [],
  "/api/drafts/history": [],
  "/api/notifications": { open: [], handledToday: [] },
  "/api/attention/held": [],
  "/api/attention": [
    item({
      key: "q:1",
      kind: "question",
      text: "Which port should the preview use?",
      brief: brief(),
    }),
    item({ key: "d:1", text: "Defaulted ask", defaultDueAt: NOW + 2 * HOUR, brief: brief() }),
    item({ key: "h:1", text: "Handled item", owner: "flight", flightTriage: "handling" }),
    item({ key: "c:1", text: "Controller call", owner: "controller" }),
  ],
  "/api/crew": {
    rows: [
      seatRow({ hudState: "blocked", ticket: "shop-app#5", ticketTitle: "Stop the race" }),
      seatRow({ id: "retro-1", role: "RETRO", hudState: "idle", run: null, ticket: null }),
      crewRow(),
    ],
    firstRunToday: null,
  },
};

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "flight-shots");
const TABS = ["needs", "did", "crew", "knows"] as const;

describeRendered("FLIGHT page in a browser", () => {
  it.each([1366, 1600, 1920])(
    "fits the window at %i px: a one-line strip, no sideways scroll, no clipped panel",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({ page: "test/flightBrowser.html", width, height: 900, api });
      for (const tab of TABS) {
        await page.click(`#flight-tab-${tab}`);
        await page.boxes(`#flight-${tab} .panel`);
        const overflow = await page.evaluate((id) => {
          const body = document.getElementById(`flight-${id}`) as HTMLElement;
          return {
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            body: body.scrollWidth - body.clientWidth,
          };
        }, tab);
        expect(overflow, tab).toEqual({ page: 0, body: 0 });
        for (const box of await page.boxes(`#flight-${tab} .panel`)) {
          expect(box.height, tab).toBeGreaterThan(40);
          expect(box.x + box.width, tab).toBeLessThanOrEqual(width);
        }
        await page.screenshot(join(SHOTS, `flight-${tab}-${width}.png`));
      }
      const strip = await page.box(".flight-strip");
      expect(strip.height).toBeLessThan(64);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
