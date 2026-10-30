// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { brief, CONFIG, HOUR, item, METRICS_VIEW, MIN, NOW, REPOS, seatRow } from "./fixtures.ts";
import { flightSummary, ledgerEntry, summaryItem, summaryOutcome } from "./flightSummaryFixture.ts";

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
      hudState: scenario === "long" || i % 2 ? "blocked" : "running",
      ticket: `shop-app#${i + 5}`,
      ticketTitle: text("Stop the race", i),
      note:
        scenario === "long"
          ? "Wait for RETRO's review. The branch needs a fresh check after the review fixes land."
          : null,
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
      done: Array.from({ length: n ? 5 : 0 }, (_, i) =>
        summaryOutcome(
          ledgerEntry({
            key: `work:done${i}`,
            title: text("Shipped the cache", i),
            status: "done",
            outcome: text("Merged after a green run", i),
            basis: text("PR merged and CI passed", i),
            updatedAt: NOW - i * 5 * MIN,
          }),
        ),
      ),
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
            if (tab === "did" && scenario !== "empty") {
              // the Recently done table fits its panel, and all its rows sit inside it
              const table = await page.evaluate((selector) => {
                const t = document.querySelector(selector) as HTMLElement | null;
                const last = t?.querySelector("tbody tr:last-child")?.getBoundingClientRect();
                const panel = document.querySelector("#outcomesP")?.getBoundingClientRect();
                return t
                  ? {
                      over: t.scrollWidth - t.clientWidth,
                      // how far the last row ends below its panel (0 or less: every row inside it)
                      spill: (last?.bottom ?? 0) - (panel?.bottom ?? 0),
                      rows: t.querySelectorAll("tbody tr").length,
                    }
                  : null;
              }, "#outcomesP .flight-outcome-table");
              expect(table, `${label} outcomes`).not.toBeNull();
              expect(table?.over, `${label} outcomes scrolls sideways`).toBeLessThanOrEqual(0);
              expect(table?.rows, label).toBe(5);
              expect(table?.spill, `${label} outcomes clipped by their panel`).toBeLessThanOrEqual(
                0,
              );
              expect(
                await page.reachable("#outcomesP .flight-outcome-row", "#flight-did"),
                `${label} outcome rows`,
              ).not.toContain(false);
            }
            await page.screenshot(
              join(SHOTS, `flight-${scenario}-${tab}-${colorScheme}-${width}x${height}.png`),
            );
          }
          // one line: every item sits on the same row, a 300-character headline is cut, not wrapped
          const strip = await page.evaluate((selector) => {
            const el = document.querySelector(selector) as HTMLElement;
            return {
              height: el.getBoundingClientRect().height,
              centres: [...el.children].map((c) => {
                const b = c.getBoundingClientRect();
                return b.top + b.height / 2;
              }),
            };
          }, ".flight-strip");
          const label = `${scenario} strip ${colorScheme}`;
          expect(strip.height, label).toBeLessThan(56);
          expect(Math.max(...strip.centres) - Math.min(...strip.centres), label).toBeLessThan(4);
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 2,
    );
  }

  it(
    "keeps more for a 178-character waiting sentence that exceeds three lines at 1280",
    async () => {
      const reason = "Waiting for RETRO while the branch needs another check "
        .repeat(4)
        .slice(0, 178);
      const api = apiFor("one");
      api["/api/crew"] = {
        rows: [seatRow({ hudState: "blocked", loop: null, note: reason })],
        firstRunToday: null,
      };
      const page = await renderAt({
        page: "test/flightBrowser.html",
        width: 1280,
        height: 1000,
        api,
      });
      await page.click("#flight-tab-crew");
      await page.box(".wif-stuck-reason .expandable-text");
      const closed = await page.evaluate((fullReason) => {
        const text = document.querySelector(".wif-stuck-reason .expandable-text") as HTMLElement;
        return {
          overflows: text.scrollHeight > text.clientHeight,
          hasMore: document.querySelector("button[aria-label='More waiting reason']") !== null,
          text: text.textContent,
          fullReason,
        };
      }, reason);
      expect(closed.overflows).toBe(true);
      expect(closed.hasMore).toBe(true);
      await page.evaluate(
        () =>
          (
            document.querySelector("button[aria-label='More waiting reason']") as HTMLButtonElement
          ).click(),
        undefined,
      );
      expect(
        await page.evaluate(
          () => document.querySelector(".wif-stuck-reason .expandable-text")?.textContent,
          undefined,
        ),
      ).toBe(reason);
      await page.evaluate(
        async () => new Promise((resolve) => window.setTimeout(resolve, 300)),
        undefined,
      );
      expect(
        await page.evaluate(
          () => document.querySelector("button[aria-label='Less waiting reason']") !== null,
          undefined,
        ),
      ).toBe(true);
      await page.evaluate(
        () =>
          (
            document.querySelector("button[aria-label='Less waiting reason']") as HTMLButtonElement
          ).click(),
        undefined,
      );
      expect(
        await page.evaluate(() => {
          const text = document.querySelector(".wif-stuck-reason .expandable-text") as HTMLElement;
          return {
            overflows: text.scrollHeight > text.clientHeight,
            hasMore: document.querySelector("button[aria-label='More waiting reason']") !== null,
          };
        }, undefined),
      ).toEqual({ overflows: true, hasMore: true });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "gives every working-context heading link a 24px target",
    async () => {
      const api = {
        ...apiFor("one"),
        "/api/flight/brief": {
          session: "s1",
          sections: [
            {
              section: "project",
              title: "Project",
              text: "Ship the accessibility target fix.",
              updatedAt: NOW - MIN,
              updatedBy: "flight-1",
            },
          ],
        },
      };
      const page = await renderAt({
        page: "test/flightBrowser.html",
        width: 1600,
        height: 1000,
        api,
      });
      await page.click("#flight-tab-knows");
      await page.click("#briefP summary");
      const boxes = await page.boxes(".flight-note-heading h3 a");
      expect(boxes).not.toEqual([]);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
