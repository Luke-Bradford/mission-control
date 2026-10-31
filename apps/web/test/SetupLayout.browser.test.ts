// @vitest-environment node

import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();

const api = {
  [RESOURCES.config.path]: CREW_CONFIG,
  [RESOURCES.limits.path]: [],
  [RESOURCES.accountStatus.path]: [],
};

const TABS = ["accounts", "repos", "roles", "loops", "sources", "access"] as const;
const SIZES = [
  [1920, 1080],
  [1366, 768],
] as const;
const PLACEHOLDER = /fixed today|will replace this source|\d+ running/;

describeRendered("Setup tabs, rendered", () => {
  for (const tab of TABS) {
    it(
      `${tab}: nothing clips sideways and no placeholder copy at 1920x1080 and 1366x768, light and dark`,
      async () => {
        for (const [width, height] of SIZES) {
          for (const colorScheme of ["light", "dark"] as const) {
            const page = await renderAt({
              page: "test/setupBrowser.html",
              width,
              height,
              search: `?tab=${tab}`,
              colorScheme,
              api,
            });
            await page.box(".setup-content");
            // a table, drawing or code block wider than its panel scrolls inside it; nothing else
            // may run past the panel's edge
            const overflow = await page.evaluate(() => {
              const clips = (value: string) => value === "hidden" || value === "clip";
              const bad: string[] = [];
              for (const el of document.querySelectorAll(".setup-content .panel *")) {
                if (el.closest(".sr-only") || (el.closest("svg") && el.tagName !== "svg")) continue;
                const panel = el.closest(".panel");
                if (!panel) continue;
                const box = el.getBoundingClientRect();
                const edge = panel.getBoundingClientRect();
                let scroller = false;
                for (let up = el.parentElement; up && up !== panel; up = up.parentElement) {
                  const { overflowX } = getComputedStyle(up);
                  if (overflowX === "auto" || overflowX === "scroll") scroller = true;
                }
                if (!scroller && box.width > 0 && box.right > edge.right + 1) {
                  bad.push(`${el.tagName}.${el.className}`);
                }
                if (clips(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) {
                  const text = getComputedStyle(el).textOverflow;
                  if (text !== "ellipsis") bad.push(`clipped ${el.tagName}.${el.className}`);
                }
              }
              return bad;
            }, null);
            expect(overflow, `${tab} at ${width}x${height} ${colorScheme}`).toEqual([]);
            const text = await page.evaluate(() => document.body.innerText, null);
            expect(text).not.toMatch(PLACEHOLDER);
            await page.close();
          }
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 4,
    );
  }
});
