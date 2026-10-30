// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const WIDTHS = [1280, 1920] as const;

describeRendered("The Agent tiles' re-reads line in a browser", () => {
  it.each(WIDTHS)(
    "shows the line without clipping the tile, at %i in light and dark",
    async (width) => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/tilesBrowser.html",
          width,
          height: 700,
          colorScheme,
          search: "?count=128&saved=1234000",
        });
        const [line] = await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>(".tile2 .d")]
              .filter((d) => d.textContent?.includes("Re-reads avoided"))
              .map((d) => ({
                text: d.textContent,
                clipped: d.scrollWidth > d.clientWidth + 1,
                lines: Math.round(
                  d.getBoundingClientRect().height / parseFloat(getComputedStyle(d).lineHeight),
                ),
              })),
          null,
        );
        expect(line.text).toContain("Re-reads avoided: 128, about 1234k tokens saved");
        expect(line.clipped).toBe(false);
        expect(line.lines).toBe(1);
        expect((await page.unclipped(".tile2")).every(Boolean)).toBe(true);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
