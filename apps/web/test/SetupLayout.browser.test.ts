// @vitest-environment node

import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";
import { TEMPLATES } from "./templateFixtures.ts";

const { renderAt } = browserSession();

const api = {
  [RESOURCES.config.path]: {
    ...CREW_CONFIG,
    profiles: { source: "built-in", version: "a".repeat(64), error: null, list: TEMPLATES },
  },
  [RESOURCES.limits.path]: [],
  [RESOURCES.accountStatus.path]: [],
};

const TABS = ["accounts", "repos", "roles", "loops", "sources", "access"] as const;
const SIZES = [
  [1920, 1080],
  [1366, 768],
] as const;
// what exists only once the tab has rendered with its data (not the loading line)
const READY = {
  accounts: ".sgrid .panel table",
  repos: ".repo-card",
  roles: ".sgrid .panel table",
  loops: ".loop-chain",
  sources: ".sgrid .yaml",
  access: ".sgrid .panel",
} as const;
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
            await page.box(READY[tab]);
            if (tab === "repos") {
              // every card open, so the seats table and guidance form are measured too
              await page.evaluate(() => {
                for (const b of document.querySelectorAll<HTMLButtonElement>(
                  ".repo-card-title[aria-expanded=false]",
                ))
                  b.click();
              }, null);
              await page.box('[aria-label^="Seats for"]');
            }
            if (tab === "loops") await page.box(".loop-templates");
            // a table, drawing or code block wider than its panel scrolls inside it; nothing else
            // may run past the panel's edge
            const overflow = await page.evaluate(() => {
              const clips = (value: string) => value === "hidden" || value === "clip";
              const bad: string[] = [];
              for (const el of document.querySelectorAll(
                ".setup-content .panel *, .setup-content .repo-card *",
              )) {
                if (el.closest(".sr-only") || (el.closest("svg") && el.tagName !== "svg")) continue;
                const panel = el.closest(".panel, .repo-card");
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
              // a panel or grid item wider than the content area is cut off at its edge
              const content = document.querySelector(".setup-content") as Element;
              const right = content.getBoundingClientRect().right;
              for (const item of document.querySelectorAll(".sgrid > *")) {
                if (item.getBoundingClientRect().right > right + 1) {
                  bad.push(`past content: ${item.className}`);
                }
              }
              if (content.scrollWidth > content.clientWidth + 1)
                bad.push("setup-content scrolls sideways");
              return bad;
            }, null);
            expect(overflow, `${tab} at ${width}x${height} ${colorScheme}`).toEqual([]);
            const text = await page.evaluate(() => document.body.innerText, null);
            expect(text).not.toMatch(PLACEHOLDER);
            expect(text).not.toMatch(/Loading…/);
            await page.close();
          }
        }
      },
      BROWSER_TEST_TIMEOUT_MS * 4,
    );
  }
});
