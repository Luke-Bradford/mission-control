// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "seat-shots");
const WIDTHS = [1366, 1600, 1920] as const;

describeRendered("A seat across Overview, Agent, Comms and Map in a browser", () => {
  it.each(WIDTHS)(
    "paints one colour on every surface and clips nothing, at %i in light and dark",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        for (const index of [3, 6]) {
          const page = await renderAt({
            page: "test/seatPagesBrowser.html",
            width,
            height: 900,
            colorScheme,
            search: `?index=${index}`,
          });
          await page.box(".map-light");
          const colours = await page.evaluate(() => {
            const rgb = (el: Element | null, prop: "backgroundColor" | "stopColor") =>
              el ? getComputedStyle(el)[prop] : "missing";
            return {
              overview: rgb(document.querySelector("[data-surface=overview] stop"), "stopColor"),
              agent: rgb(document.querySelector("[data-surface=agent] .ag i"), "backgroundColor"),
              comms: rgb(
                document.querySelector("[data-surface=comms] .comms-nav-row i"),
                "backgroundColor",
              ),
              map: rgb(document.querySelector(".map-light"), "backgroundColor"),
            };
          }, null);
          expect(new Set(Object.values(colours)).size, JSON.stringify(colours)).toBe(1);
          expect(colours.map).not.toBe("missing");
          expect((await page.unclipped(".panel, .map-page")).every(Boolean)).toBe(true);
          await page.screenshot(join(SHOTS, `seat-${index}-${colorScheme}-${width}.png`));
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );
});
