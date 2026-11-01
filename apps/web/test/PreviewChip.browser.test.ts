// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const WIDTHS = [1280, 1600, 1920] as const;

describeRendered("Preview chips on Board and Agent", () => {
  it.each(
    WIDTHS.flatMap((width) =>
      (["none", "start", "preview"] as const).map((state) => [width, state] as const),
    ),
  )(
    "fit at %i with %s in light and dark",
    async (width, state) => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/previewChipBrowser.html",
          width,
          height: 700,
          colorScheme,
          search: `?state=${state}`,
          api: { "/api/config": { repos: [] } },
        });
        const chips = await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>("[data-surface] .rpr")].map((chip) => ({
              lines: Math.round(
                chip.getBoundingClientRect().height / parseFloat(getComputedStyle(chip).lineHeight),
              ),
              clipped: chip.scrollWidth > chip.clientWidth + 1,
            })),
          null,
        );
        expect(chips).toHaveLength(2);
        expect(chips.every((chip) => chip.lines === 1 && !chip.clipped)).toBe(true);
        expect((await page.unclipped("[data-surface] .rpr")).every(Boolean)).toBe(true);
        expect((await page.reachable("[data-surface] .rpr")).every(Boolean)).toBe(true);
        const starts = await page.evaluate(
          () => document.querySelectorAll(".preview-start").length,
          null,
        );
        expect(starts).toBe(state === "start" ? 2 : 0);
        if (state === "start") {
          for (const box of await page.boxes(".preview-start")) {
            expect(box.width).toBeGreaterThanOrEqual(24);
            expect(box.height).toBeGreaterThanOrEqual(24);
          }
        }
        if (process.env.MC_SHOT_DIR)
          await page.screenshot(
            `${process.env.MC_SHOT_DIR}/preview-${state}-${width}-${colorScheme}.png`,
          );
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
  it(
    "starts from either surface without opening its card or expanding its run",
    async () => {
      for (const surface of ["board", "agent"]) {
        const page = await renderAt({
          page: "test/previewChipBrowser.html",
          width: 1280,
          search: "?state=start",
          api: {
            "/api/config": { repos: [] },
            "/api/previews": {
              pr: 1174,
              branch: "feature/preview",
              port: 7431,
              url: "http://127.0.0.1:7431",
              startedAt: 1,
            },
          },
        });
        await page.click(`[data-surface="${surface}"] .preview-start`);
        await page.box(`[data-surface="${surface}"] .preview-link`);
        const location = await page.evaluate(() => window.location.pathname, null);
        expect(location).toBe("/test/previewChipBrowser.html");
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
