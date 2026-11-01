// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const api = {
  "/api/repos": [{ id: "shop-app", github: "octo-org/shop-app", project: 1 }],
  "/api/crew?shape=summary": { rows: [], firstRunToday: null },
  "/api/config": { loops: [], crew: { sessions: [] } },
  "/api/attention": [],
  "/api/boards/shop-app": [],
  "/api/repos/shop-app/prs?shape=summary": [],
};

const { renderAt } = browserSession();

describeRendered("The command palette in a browser", () => {
  for (const width of [1280, 390]) {
    it(
      `fits the window at ${width}px, its rows hold their text on one line`,
      async () => {
        const page = await renderAt({ page: "test/paletteBrowser.html", width, api });
        await page.box(".palette-row");
        // the healthy state: every source answered, so no loading line and no failure alert
        await page.evaluate(() => new Promise((r) => setTimeout(r, 300)), null);
        expect(
          await page.evaluate(() => document.querySelectorAll(".palette-empty").length, null),
        ).toBe(0);
        const dialog = await page.box(".palette");
        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(width);
        expect(dialog.y + dialog.height).toBeLessThanOrEqual(900);
        expect((await page.boxes(".palette-row")).length).toBe(9);
        expect((await page.unclipped(".palette-list")).every(Boolean)).toBe(true);
        const shot = process.env.PALETTE_SHOT;
        if (shot) await page.screenshot(`${shot}-${width}.png`);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
