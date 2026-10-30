// @vitest-environment node

import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { flightSummary } from "./flightSummaryFixture.ts";

const { renderAt } = browserSession();

const summary = flightSummary();
const api = {
  [RESOURCES.flightSummary.path]: {
    ...summary,
    metrics: { ...summary.metrics, forTheController: 4 },
  },
  [RESOURCES.crew.path]: { rows: [], firstRunToday: null },
  [RESOURCES.limits.path]: [],
};

describeRendered("FLIGHT page Record tab, rendered", () => {
  it.each([
    [1280, 720],
    [1600, 1000],
    [1920, 1080],
  ] as const)(
    "shows the For the controller tile whole beside the other 24-hour tiles at %ix%i",
    async (width, height) => {
      const page = await renderAt({
        page: "test/flightBrowser.html",
        width,
        height,
        api,
      });
      const tile = await page.box(".flight-tiles .flight-tile-btn");
      expect(tile.height).toBeGreaterThanOrEqual(24);
      const tiles = await page.boxes(".flight-tiles > div");
      expect(tiles).toHaveLength(4);
      // The four tiles sit in one row, each with a box of its own.
      expect(new Set(tiles.map((t) => Math.round(t.y))).size).toBe(1);
      expect(await page.unclipped(".flight-tiles dt"), "a tile label is cut").not.toContain(false);
      if (process.env.MC_SHOT_DIR) {
        await page.screenshot(`${process.env.MC_SHOT_DIR}/flight-record-${width}.png`);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
