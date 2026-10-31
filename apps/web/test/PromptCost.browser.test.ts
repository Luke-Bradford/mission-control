// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "prompt-cost-shots");
const SIZES = [
  { width: 1280, height: 1000 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1000 },
  { width: 1600, height: 700 },
] as const;

const SECTIONS = ["role", "rules", "orders", "lessons", "ticket", "digest", "tool_results"];
const prompt = (tokens: number[]) => [
  {
    runId: "run-1",
    wake: 0,
    at: Date.now(),
    sections: SECTIONS.map((section, i) => ({
      section,
      bytes: (tokens[i] ?? 0) * 4,
      tokens: tokens[i] ?? 0,
    })),
  },
];
const SCENARIOS = {
  data: prompt([1200, 800, 400, 300, 2000, 500, 3000]),
  // one section dwarfs the rest: the small segments must stay visible in the legend
  skewed: prompt([5, 5, 5, 5, 5, 5, 1_234_567]),
  none: [],
};

describeRendered("The Agent page's prompt cost tab in a browser", () => {
  it.each(SIZES)(
    "shows the bar and every section's count without clipping, at $width×$height",
    async ({ width, height }) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        for (const [name, promptWakes] of Object.entries(SCENARIOS)) {
          const page = await renderAt({
            page: "test/promptCostBrowser.html",
            width,
            height,
            colorScheme,
            api: {
              "/api/runs/run-1/loop": {
                loop: null,
                events: [],
                tries: [],
                round: null,
                budget: null,
                review: null,
                prompt: promptWakes,
              },
            },
          });
          const label = `${name} ${colorScheme}`;
          await page.click('#sideP button:has-text("Context")');
          if (promptWakes.length > 0) {
            await page.box(".prompt-cost-bar");
            const bar = await page.evaluate(() => {
              const el = document.querySelector(".prompt-cost-bar") as HTMLElement;
              const segments = [...el.children].map((c) => c.getBoundingClientRect().width);
              return {
                width: el.getBoundingClientRect().width,
                sum: segments.reduce((a, b) => a + b, 0),
              };
            }, null);
            expect(bar.width, `${label} bar`).toBeGreaterThan(200);
            expect(bar.sum, `${label} segments fit the bar`).toBeLessThanOrEqual(bar.width + 1);
            expect(
              await page.reachable(".prompt-cost-legend li", "#sideBody"),
              `${label} legend`,
            ).not.toContain(false);
            expect((await page.unclipped("#sideBody")).every(Boolean), label).toBe(true);
          } else {
            await page.box("#sideBody .note, #sideBody .muted");
          }
          await page.screenshot(
            join(SHOTS, `agent-prompt-${name}-${colorScheme}-${width}x${height}.png`),
          );
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );
});
