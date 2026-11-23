// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const WIDTHS = [1280, 1600, 1920] as const;

describeRendered("The Comms right column with a living crew map in a browser", () => {
  it.each(WIDTHS)(
    "keeps the map's content inside its panel and every seat reachable, at %i",
    async (width) => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/commsLengthBrowser.html",
          width,
          height: 1000,
          colorScheme,
          api: {
            "/api/comms/links": { links: [] },
            "/api/comms/open": { items: [] },
            "/api/comms/feed": { messages: [] },
          },
        });
        await page.box(".crew-map");
        await expect
          .poll(() =>
            page.evaluate(() => document.querySelectorAll(".crew-map-seat").length, undefined),
          )
          .toBe(4);
        const clear = await page.evaluate(() => {
          const panel = document.querySelector(".crew-map");
          if (!panel) return false;
          const box = panel.getBoundingClientRect();
          return [...panel.querySelectorAll(".crew-map-seat")].every((seat) => {
            const node = seat.getBoundingClientRect();
            return (
              node.left >= box.left &&
              node.right <= box.right &&
              node.top >= box.top &&
              node.bottom <= box.bottom
            );
          });
        }, null);
        expect(clear, `${colorScheme}: map content overflows its panel`).toBe(true);
        expect((await page.reachable(".crew-map-seat")).every(Boolean)).toBe(true);
        expect((await page.reachable(".crew-map-side li button")).every(Boolean)).toBe(true);
        expect((await page.unclipped(".crew-map")).every(Boolean)).toBe(true);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );
});
