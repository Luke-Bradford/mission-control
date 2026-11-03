// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { NOW } from "./fixtures.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const baseline = process.env.MC_OVERVIEW_CAPTURE_BASELINE === "1";
async function settled(page: RenderedPage) {
  await page.evaluate(async () => {
    const ready = () =>
      document.querySelector("#page-overview")?.textContent?.includes("41.2k") &&
      (document.querySelector("#quotaSummaryP")?.textContent?.includes("37% left") ||
        document.querySelector("#quotaP")?.textContent?.includes("63%")) &&
      (document.querySelector("#machineSummaryP .machine-chart") ||
        document.querySelector("#machP .machine-chart")) &&
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
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      activeTag: document.activeElement?.tagName,
      closedReaders: [...document.querySelectorAll(".overview-evidence:not(.evidence-inline)")].map(
        (reader) => reader.hasAttribute("open"),
      ),
      timelineCue: document.querySelector("#timelineP .overview-overflow-note")?.textContent,
      timelineOverflow: (() => {
        const region = document.querySelector<HTMLElement>("#timelineP .overview-lane-scroll");
        return !!region && region.scrollHeight > region.clientHeight + 1;
      })(),
      grid: grid && {
        client: grid.clientHeight,
        scroll: grid.scrollHeight,
        top: grid.scrollTop,
        width: grid.clientWidth,
        hostEvidence: grid.dataset.hostEvidence,
        wideDetails: grid.dataset.wideDetails,
        allHistories: grid.dataset.allHistories,
      },
      crew: box("#agentsP"),
      activity: box("#actP"),
      pipeline: box("#pipelineP"),
      provider: box("#quotaSummaryP") ?? box("#quotaP"),
      timeline: box("#timelineP"),
      history: [...document.querySelectorAll(".overview-history-domain > .panel")].map((panel) => ({
        id: panel.id,
        box: panel.getBoundingClientRect().toJSON(),
      })),
      machine: box("#machineSummaryP") ?? box("#machP"),
      metrics: box(".overview-metrics"),
      workspaceColumns: getComputedStyle(document.querySelector(".overview-workspace") as Element)
        .gridTemplateColumns,
      rows: [...document.querySelectorAll("#agentsList .trow:not(.head)")].map(
        (row) => row.getBoundingClientRect().height,
      ),
      kpis: [...document.querySelectorAll(".overview-kpi")].map((tile) => ({
        y: tile.getBoundingClientRect().y,
        height: tile.getBoundingClientRect().height,
      })),
      loops: [...document.querySelectorAll("#agentsP .loop-chip")].map((chip) => ({
        text: chip.textContent,
        box: chip.getBoundingClientRect().toJSON(),
      })),
      rosterWidth: (() => {
        const row = document.querySelector<HTMLElement>("#agentsList");
        return row && { client: row.clientWidth, scroll: row.scrollWidth };
      })(),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      visibleLogRows: (() => {
        const region = document.querySelector("#actList")?.getBoundingClientRect();
        return region
          ? [...document.querySelectorAll("#actList .arow")].filter((row) => {
              const r = row.getBoundingClientRect();
              return r.top >= region.top && r.bottom <= region.bottom;
            }).length
          : 0;
      })(),
      criticalPaint: (() => {
        const modal = document.querySelector("main")?.inert;
        // The modal conversation intentionally makes the covered background inert.
        // Assess the real paint of these controls in the normal monitoring state.
        if (modal) return null;
        return [
          ...document.querySelectorAll<HTMLElement>(
            "#agentsList .need button, #agentsP > .ph button, #machineSummaryP > .ph button",
          ),
        ].map((control) => {
          const r = control.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return {
            text: control.textContent,
            width: r.width,
            height: r.height,
            painted: hit === control || control.contains(hit),
          };
        });
      })(),
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

const SCREENS = process.env.MC_OVERVIEW_REFERENCE_LOOPS
  ? [
      { width: 1920, height: 1080, dpr: 1, scenario: "normal-loops" as const },
      { width: 3840, height: 2160, dpr: 1, scenario: "normal-loops" as const },
    ]
  : ([
      { width: 1280, height: 900, dpr: 1 },
      { width: 1440, height: 900, dpr: 1 },
      { width: 1600, height: 1000, dpr: 1 },
      { width: 1920, height: 1080, dpr: 1 },
      { width: 2560, height: 1440, dpr: 1 },
      { width: 3840, height: 2160, dpr: 1 },
      { width: 3840, height: 1800, dpr: 1 },
      { width: 1600, height: 700, dpr: 1 },
      { width: 1920, height: 1080, dpr: 2 },
    ] as const);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describeRendered("Operational Overview composition", () => {
  it(
    "fits useful natural stacks at CSS viewport sizes and retains keyboard modal state",
    async () => {
      // This early matrix is runtime-source-bound; fixture/harness/test edits are recorded separately.
      execFileSync("git", ["diff", "--quiet", "HEAD", "--", "apps/web/src"]);
      const runtimeSource = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const bindings = Object.fromEntries(
        [
          "overviewDensityFixtures.ts",
          "overviewDensityBrowser.tsx",
          "browserRunner.ts",
          "OverviewOperational.browser.test.ts",
        ].map((file) => [file, sha(readFileSync(join(import.meta.dirname, file)))]),
      );
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        for (const file of Object.keys(bindings))
          writeFileSync(join(evidence, file), readFileSync(join(import.meta.dirname, file)));
        writeFileSync(
          join(evidence, "fixture-api.json"),
          JSON.stringify(overviewDensityFixture("normal-loops").api, null, 2),
        );
      }
      const receipts = [];
      for (const frame of SCREENS)
        for (const scheme of ["light", "dark"] as const) {
          const scenario = "normal-loops";
          const fixture = overviewDensityFixture(scenario);
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width: frame.width,
            height: frame.height,
            deviceScaleFactor: frame.dpr,
            colorScheme: scheme,
            api: fixture.api,
          });
          try {
            await settled(page);
            for (const turn of [0, 1]) {
              const folded = await page.evaluate(
                () => document.querySelector("#dock")?.classList.contains("collapsed"),
                undefined,
              );
              const state = folded ? "folded" : "open";
              const name = `${scenario}-${frame.width}x${frame.height}-dpr${frame.dpr}-${scheme}-${state}`;
              await shot(page, name);
              const facts = await geometry(page);
              const file = evidence && join(evidence, `${name}.png`);
              receipts.push({
                runtimeSource,
                mode: baseline ? "delivered-baseline" : "current-acceptance",
                fixtureClock: NOW,
                bindings,
                fixtureSha256: sha(JSON.stringify(fixture.api)),
                capturedAt: new Date().toISOString(),
                scheme,
                state,
                png: file ? { file: `${name}.png`, sha256: sha(readFileSync(file)) } : null,
                facts,
              });
              if (evidence)
                writeFileSync(join(evidence, "geometry.json"), JSON.stringify(receipts, null, 2));
              expect(page.errors()).toEqual([]);
              expect(facts.rows).toHaveLength(11);
              expect(facts.loops).toHaveLength(2);
              if (!baseline) {
                expect(facts.viewport).toEqual({
                  width: frame.width,
                  height: frame.height,
                  dpr: frame.dpr,
                });
                expect(facts.horizontalOverflow).toBe(false);
                expect(
                  facts.crew &&
                    facts.activity &&
                    facts.pipeline &&
                    facts.crew.y < facts.activity.y &&
                    facts.activity.y < facts.pipeline.y,
                ).toBe(true);

                if (scenario === "normal-loops")
                  for (const loop of facts.loops) {
                    expect(loop.box.height).toBeGreaterThanOrEqual(24);
                    expect(loop.box.y).toBeGreaterThanOrEqual(facts.crew?.y ?? Infinity);
                    expect(loop.box.bottom).toBeLessThanOrEqual(facts.activity?.y ?? 0);
                  }
                expect(facts.rows.every((height) => height === 32)).toBe(true);
                expect(
                  facts.rosterWidth && facts.rosterWidth.scroll <= facts.rosterWidth.client,
                  JSON.stringify(facts.rosterWidth),
                ).toBe(true);
                expect(facts.labelClips).toEqual([]);
                if (facts.criticalPaint)
                  for (const control of facts.criticalPaint) {
                    // Lower panels are deliberately below the first screen on narrow/short windows.
                    if (frame.width >= 1920)
                      expect(control.painted, JSON.stringify(control)).toBe(true);
                    expect(control.width).toBeGreaterThanOrEqual(24);
                    expect(control.height).toBeGreaterThanOrEqual(24);
                  }
                expect(facts.history).toHaveLength(facts.grid?.allHistories === "true" ? 5 : 1);
                if (facts.grid?.allHistories === "true")
                  expect(facts.visibleLogRows).toBeGreaterThanOrEqual(20);
                if (facts.timelineOverflow) expect(facts.timelineCue).toContain("Scroll ↕");
                expect(facts.closedReaders.every((open) => !open)).toBe(true);
                if (frame.width >= 1920)
                  expect(
                    facts.grid && facts.grid.scroll <= facts.grid.client + 1,
                    JSON.stringify(facts),
                  ).toBe(true);
                if (frame.width >= 1440)
                  expect(new Set(facts.kpis.map((tile) => tile.y)).size).toBe(1);
                if (frame.width === 1280)
                  expect(new Set(facts.kpis.map((tile) => tile.y)).size).toBe(2);
                if (frame.width >= 2560) expect(facts.workspaceColumns.split(" ")).toHaveLength(3);
                const modal = !folded && frame.width < 2200;
                expect(
                  await page.evaluate(
                    () => ({
                      inert: document.querySelector("main")?.inert,
                      modal: document.querySelector("#dock")?.getAttribute("aria-modal"),
                    }),
                    undefined,
                  ),
                ).toEqual({ inert: modal, modal: modal ? "true" : null });
              }
              if (turn === 0) {
                if (folded) await page.click(".dockrail button");
                else await page.click('#dockHead [title="Collapse FLIGHT to its rail"]');
                await page.evaluate(async () => {
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  );
                }, undefined);
              }
            }
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
