// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { costTelemetryApi } from "./telemetryCostFixture.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;

async function ready(page: RenderedPage) {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.boxes("#page-telemetry");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
}

const api = () => ({ ...desktopFixture().api, ...costTelemetryApi() });

const PANELS = ["#tStepBars", "#tTicketBars", "#tTok", "#tQuotaUsed"];

/** What a person sees: whether the page scrolls, and where each panel sits. */
async function geometry(page: RenderedPage) {
  return page.evaluate((panels) => {
    const main = document.querySelector("main") as HTMLElement;
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right };
    };
    return {
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      mainScroll: main.scrollHeight - main.clientHeight,
      mainBottom: main.getBoundingClientRect().bottom,
      mainRight: main.getBoundingClientRect().right,
      panels: panels.map((sel) => ({ sel, box: box(sel) })),
      summary: document.querySelectorAll(".summary .stat").length,
      layers: document.querySelectorAll("#tTok path.area").length,
      meters: document.querySelectorAll("#tQuotaUsed li.quota-row").length,
    };
  }, PANELS);
}

describeRendered("Telemetry, Cost and tokens tab, in a browser", () => {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [
      [1600, 1000],
      [2560, 1250],
    ] as const) {
      it(
        `fits one screen at ${width}x${height}, ${scheme}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api(),
            search: "?path=/telemetry&tab=cost",
          });
          try {
            await ready(page);
            const g = await geometry(page);
            expect(page.errors()).toEqual([]);
            expect(g.pageScroll).toBeLessThanOrEqual(0);
            expect(g.mainScroll).toBeLessThanOrEqual(0);
            expect(g.summary).toBe(6);
            // three seats, then Other: four layers stacked
            expect(g.layers).toBe(4);
            expect(g.meters).toBe(2);
            for (const { sel, box } of g.panels) {
              expect(box, sel).not.toBeNull();
              const b = box as { b: number; r: number; h: number; w: number };
              expect(b.b, `${sel} bottom`).toBeLessThanOrEqual(g.mainBottom + 1);
              expect(b.r, `${sel} right`).toBeLessThanOrEqual(g.mainRight + 1);
              expect(b.h, `${sel} height`).toBeGreaterThanOrEqual(200);
            }
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(
                join(evidence, `telemetry-cost-${width}x${height}-${scheme}.png`),
              );
            }
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    "keeps the table view inside the work area, scrolling within it",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "dark",
        api: api(),
        search: "?path=/telemetry&tab=cost&view=table",
      });
      try {
        await ready(page);
        const g = await geometry(page);
        expect(page.errors()).toEqual([]);
        expect(g.pageScroll).toBeLessThanOrEqual(0);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot(join(evidence, "telemetry-cost-table-1600x1000-dark.png"));
        }
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
