// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
async function settled(page: RenderedPage) {
  await page.evaluate(async () => {
    const ready = () =>
      document.querySelector("#page-overview")?.textContent?.includes("41.2k") &&
      document.querySelector("#quotaSummaryP")?.textContent?.includes("37% left") &&
      document.querySelector("#machineSummaryP .machine-chart") &&
      document.querySelector(".overview-instant");
    const deadline = performance.now() + 5000;
    while (!ready() && performance.now() < deadline)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!ready())
      throw Error(
        `Operational fixture not settled: ${document.querySelector("#page-overview")?.textContent}`,
      );
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, undefined);
}
async function shot(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}
async function geometry(page: RenderedPage) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    const grid = document.querySelector<HTMLElement>(".overview-grid");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      grid: grid && { client: grid.clientHeight, scroll: grid.scrollHeight, top: grid.scrollTop },
      crew: box("#agentsP"),
      activity: box("#actP"),
      pipeline: box("#pipelineP"),
      provider: box("#quotaSummaryP"),
      timeline: box("#timelineP"),
      history: box("#overviewHistoryP"),
      machine: box("#machineSummaryP"),
      workspaceColumns: getComputedStyle(document.querySelector(".overview-workspace") as Element)
        .gridTemplateColumns,
      rows: [...document.querySelectorAll("#agentsList .trow:not(.head)")].map(
        (row) => row.getBoundingClientRect().height,
      ),
      kpis: [...document.querySelectorAll(".overview-kpi")].map((tile) => ({
        y: tile.getBoundingClientRect().y,
        height: tile.getBoundingClientRect().height,
      })),
      rosterWidth: (() => {
        const row = document.querySelector<HTMLElement>("#agentsList");
        return row && { client: row.clientWidth, scroll: row.scrollWidth };
      })(),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      labelClips: [
        ...document.querySelectorAll<HTMLElement>(".overview-span:not(.span-label-outside) > span"),
      ]
        .filter(
          (label) => label.getBoundingClientRect().width > (label.parentElement?.clientWidth ?? 0),
        )
        .map((label) => label.textContent),
      companions: [...document.querySelectorAll(".timeline-span-companions")].map(
        (label) => label.textContent,
      ),
    };
  }, undefined);
}

describeRendered("Operational Overview composition", () => {
  it(
    "keeps natural primary and analytical stacks useful in the settled production App",
    async () => {
      const receipts = [];
      for (const width of [1920, 2560])
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width,
            height: width === 1920 ? 1080 : 1440,
            colorScheme: scheme,
            api: overviewDensityFixture().api,
          });
          try {
            await settled(page);
            // Save the actual populated frame before any acceptance assertion.
            await shot(page, `${width}-${scheme}-initial`);
            const before = await geometry(page);
            receipts.push(before);
            if (evidence)
              writeFileSync(join(evidence, "geometry.json"), JSON.stringify(receipts, null, 2));
            expect(page.errors()).toEqual([]);
            expect(before.horizontalOverflow).toBe(false);
            expect(
              before.crew &&
                before.activity &&
                before.pipeline &&
                before.crew.y < before.activity.y &&
                before.activity.y < before.pipeline.y,
            ).toBe(true);
            expect(before.rows.every((height) => height === 32)).toBe(true);
            expect(
              before.rosterWidth && before.rosterWidth.scroll <= before.rosterWidth.client,
              JSON.stringify(before.rosterWidth),
            ).toBe(true);
            expect(before.labelClips).toEqual([]);
            if (width === 1920) {
              expect(
                before.grid && before.grid.scroll <= before.grid.client + 1,
                JSON.stringify(before),
              ).toBe(true);
              expect(new Set(before.kpis.map((tile) => tile.y)).size).toBe(1);
              await page.click(".dockrail button");
              await shot(page, `${width}-${scheme}-open`);
              expect(
                await page.evaluate(
                  () => ({
                    inert: document.querySelector("main")?.inert,
                    modal: document.querySelector("#dock")?.getAttribute("aria-modal"),
                    crewWidth: document.querySelector("#agentsP")?.getBoundingClientRect().width,
                  }),
                  undefined,
                ),
              ).toMatchObject({ inert: true, modal: "true", crewWidth: before.crew?.width });
              await page.press("Escape");
              expect(
                await page.evaluate(
                  () => document.activeElement?.closest(".dockrail") !== null,
                  undefined,
                ),
              ).toBe(true);
            } else expect(before.workspaceColumns.split(" ")).toHaveLength(3);
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
