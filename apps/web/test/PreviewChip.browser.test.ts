// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const WIDTHS = [1280, 1600, 1920] as const;

describeRendered("Preview chips on Board and Agent", () => {
  it.each(WIDTHS)(
    "do not wrap or clip at %i in light and dark",
    async (width) => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/previewChipBrowser.html",
          width,
          height: 700,
          colorScheme,
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
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
