// @vitest-environment node

import type { BoardItem, OverviewSummary, PipelineCard } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { boardItem, NOW, prView } from "./fixtures.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();

const facts = { round: 2, blockers: 1, seat: "guido-2", seatBusy: false };
const card = (ticket: number, over: Partial<PipelineCard>): PipelineCard => ({
  repoId: "shop-app",
  ticket,
  title: `Fictional ticket ${ticket} with a title long enough to take two lines in a lane`,
  pr: 1432,
  ci: ["pass", "pending"],
  since: NOW - 20 * 60_000,
  who: "guido-2",
  rework: facts,
  ...over,
});
const lane = (stage: "ready" | "building", cards: PipelineCard[]) => ({
  stage,
  count: cards.length,
  oldestAt: NOW - 20 * 60_000,
  cards,
});
const overview = (base: OverviewSummary): OverviewSummary => ({
  ...base,
  pipeline: [
    lane("ready", [card(11, { who: null, rework: { ...facts, blockers: 2 } })]),
    lane("building", [
      card(12, {}),
      card(13, { rework: { ...facts, seatBusy: true } }),
      card(14, { rework: { ...facts, seat: "retro-1", round: 3, blockers: 12 } }),
    ]),
    { stage: "checks", count: 0, oldestAt: null, cards: [] },
    { stage: "review", count: 0, oldestAt: null, cards: [] },
    { stage: "merging", count: 0, oldestAt: null, cards: [] },
    { stage: "merged", count: 0, oldestAt: null, cards: [] },
  ],
});

const SHOTS = process.env.MC_REWORK_SHOTS;

describeRendered("Rework labels on cards, rendered", () => {
  it.each([1280, 1920])(
    "Overview Board cards show the label whole at %ipx",
    async (width) => {
      const fixture = overviewDensityFixture("mixed");
      const summary = overview(fixture.api["/api/overview"] as OverviewSummary);
      const page = await renderAt({
        page: "test/overviewDensityBrowser.html",
        width,
        height: width === 1280 ? 800 : 940,
        colorScheme: "dark",
        api: { ...fixture.api, "/api/overview": summary, "/api/overview?session=demo": summary },
      });
      await page.evaluate(async () => {
        const end = performance.now() + 5000;
        while (!document.querySelector(".board-rework") && performance.now() < end)
          await new Promise((r) => requestAnimationFrame(r));
        await document.fonts.ready;
      }, undefined);
      const labels = await page.evaluate(
        () => [...document.querySelectorAll(".board-rework")].map((e) => e.textContent),
        undefined,
      );
      expect(labels).toEqual([
        "Reviewed · 2 blockers · PR 1432",
        "Rework · round 2 · 1 blocker · GUIDO-2",
        "Rework · queued for GUIDO-2",
        "Rework · round 3 · 12 blockers · RETRO-1",
      ]);
      // each label sits whole inside its card: no sideways spill, no clipping
      expect(await page.unclipped(".board-rework")).toEqual([true, true, true, true]);
      const cards = await page.boxes(".board-card:has(.board-rework)");
      const marks = await page.boxes(".board-rework");
      for (const [i, mark] of marks.entries()) {
        const outer = cards[i];
        if (!outer) throw new Error("card");
        expect(mark.x).toBeGreaterThanOrEqual(outer.x - 0.5);
        expect(mark.x + mark.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
      }
      expect(page.errors()).toEqual([]);
      if (SHOTS) await page.screenshot(`${SHOTS}/overview-${width}.png`);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it.each([1280, 1920])(
    "Board cards show the label whole at %ipx",
    async (width) => {
      const desk = desktopFixture();
      const items: BoardItem[] = [
        boardItem({ issueNumber: 11, title: "Fictional ready ticket", status: "Todo" }),
        boardItem({ issueNumber: 12, title: "Fictional rework ticket", status: "In progress" }),
        boardItem({ issueNumber: 13, title: "Fictional queued ticket", status: "In progress" }),
      ];
      const summary = overview(desk.api["/api/overview"] as OverviewSummary);
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width,
        height: width === 1280 ? 800 : 940,
        colorScheme: "dark",
        search: "?path=%2Fboard",
        api: {
          ...desk.api,
          "/api/boards/shop-app": items,
          "/api/repos/shop-app/prs?linked=1&shape=summary": [
            prView({ number: 1432, ticket: "shop-app#11" }),
          ],
          "/api/overview": summary,
        },
      });
      await page.evaluate(async () => {
        const end = performance.now() + 5000;
        while (document.querySelectorAll(".kcard .warn-t").length < 3 && performance.now() < end)
          await new Promise((r) => requestAnimationFrame(r));
        await document.fonts.ready;
      }, undefined);
      const labels = await page.evaluate(
        () =>
          [...document.querySelectorAll(".kcard .overlay .warn-t")]
            .map((e) => e.textContent)
            .filter((t) => /^(Rework|Reviewed)/.test(t ?? "")),
        undefined,
      );
      expect(labels.sort()).toEqual([
        "Reviewed · 2 blockers · PR 1432",
        "Rework · queued for GUIDO-2",
        "Rework · round 2 · 1 blocker · GUIDO-2",
      ]);
      expect(page.errors()).toEqual([]);
      if (SHOTS) await page.screenshot(`${SHOTS}/board-${width}.png`);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
