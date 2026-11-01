// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_MAP_PERFORMANCE_SHOTS;
// Absolute frame budgets belong to an isolated measurement run, not a contended CI browser shard.
const enforceTimingBudgets = process.env.MC_MAP_PERFORMANCE_BUDGETS === "1";
describeRendered("Map performance at repository scale", () => {
  it.each([
    { width: 1280, height: 1000 },
    { width: 1600, height: 1000 },
    { width: 1920, height: 1000 },
    { width: 1600, height: 700 },
  ])(
    "fits $width × $height in light and dark with a light snapshot and fast analysis",
    async ({ width, height }) => {
      for (const theme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/mapPerformanceBrowser.html",
          width,
          height,
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
        expect(Number.isFinite(snapshot) && snapshot >= 0).toBe(true);
        if (enforceTimingBudgets) expect(snapshot).toBeLessThan(100);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1, null),
        ).toBe(true);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(
            join(shots, `map-scale-${width}${height === 700 ? "x700" : ""}-${theme}.png`),
          );
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
        expect(timings.switchMs).toHaveLength(5);
        expect(timings.switchMs.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
        if (enforceTimingBudgets) expect(Math.max(...timings.switchMs)).toBeLessThan(50);
        if (shots)
          writeFileSync(
            join(shots, `timings-${width}${height === 700 ? "x700" : ""}-${theme}.json`),
            JSON.stringify(timings, null, 2),
          );
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
