// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_MAP_PERFORMANCE_SHOTS;
describeRendered("Map performance at repository scale", () => {
  it.each([1280, 1600, 1920])(
    "fits %i in light and dark with a light snapshot and fast analysis",
    async (width) => {
      for (const theme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/mapPerformanceBrowser.html",
          width,
          height: 1000,
          colorScheme: theme,
          api: { "/api/config": { operator: { timezone: "UTC" } } },
        });
        expect((await page.boxes(".map-treemap-tile")).length).toBeGreaterThanOrEqual(1074);
        await page.click("[data-update]");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              const wait = () => {
                if (window.mapPerformance.snapshotMs.length) resolve();
                else requestAnimationFrame(wait);
              };
              wait();
            }),
          null,
        );
        const snapshot = await page.evaluate(() => window.mapPerformance.snapshotMs[0], null);
        expect(snapshot).toBeLessThan(100);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1, null),
        ).toBe(true);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(join(shots, `map-scale-${width}-${theme}.png`));
        }
        // Cache each analysis graph, then measure returning to it; the initial lazy load is measured separately by API proof.
        for (const mode of ["impact", "history", "map", "impact", "history"]) {
          await page.click(`[data-mode="${mode}"]`);
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
            null,
          );
        }
        const timings = await page.evaluate(() => window.mapPerformance, null);
        expect(Math.max(...timings.switchMs)).toBeLessThan(50);
        if (shots)
          writeFileSync(
            join(shots, `timings-${width}-${theme}.json`),
            JSON.stringify(timings, null, 2),
          );
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
