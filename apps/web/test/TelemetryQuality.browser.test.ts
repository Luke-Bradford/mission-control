// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { telemetryPath } from "../src/router.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";
import { crewTelemetry, crewTelemetryApi } from "./telemetryCrewFixture.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const DAY = 86_400_000;

/** Seven days from a first collected day on the third, with a gap day inside the plot. */
const CI = [null, null, 100, 50, null, 100, 90];
const REVIEW = [null, null, null, 0, 100, null, 100];

function api() {
  const data = crewTelemetry();
  const withQuality = {
    ...data,
    series: {
      ...(data.series as NonNullable<typeof data.series>),
      quality: CI.map((ci, i) => ({
        at: NOW - (6 - i) * DAY,
        ciGreenFirstPushPct: ci,
        firstPassReviewPct: REVIEW[i] ?? null,
        reviewRoundsPerPr: REVIEW[i] === null ? null : 1 + (i % 3) * 0.5,
      })),
    },
    quality: {
      ciGreenFirstPushPct: 88,
      prs: 16,
      firstPassReviewPct: 70,
      reviewedPrs: 10,
      reviewRoundsPerPr: 1.7,
      retroFindingsPerPr: 4.2,
      humanReviewWaitMs: 52 * 60_000,
      sentBackPrs: 6,
    },
  };
  const routes = { ...desktopFixture().api, ...crewTelemetryApi() };
  for (const r of ["1h", "6h", "24h", "7d"]) routes[`/api/telemetry?range=${r}`] = withQuality;
  routes["/api/guard/hits?days=14"] = {
    hits: [],
    counts: { "git-write": 31, network: 14, background: 9, "gh-cli": 6, "read-only": 2 },
  };
  routes["/api/qa/flow?days=14"] = { days: 14, escapedDefects: [] };
  return routes;
}

async function ready(page: RenderedPage) {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.boxes("#page-telemetry");
  for (const id of ["#qCi", "#qFirstPass", "#qRounds", "#qGuard"]) await page.boxes(id);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
}

describeRendered("Telemetry, Quality tab, in a browser", () => {
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
            search: `?path=${encodeURIComponent(telemetryPath("quality"))}`,
          });
          try {
            await ready(page);
            const g = await page.evaluate(() => {
              const main = document.querySelector("main") as HTMLElement;
              const bottoms = [
                ...document.querySelectorAll("#qCi, #qFirstPass, #qRounds, #qGuard"),
              ].map((e) => e.getBoundingClientRect().bottom);
              return {
                pageScroll: document.documentElement.scrollHeight - innerHeight,
                mainScroll: main.scrollHeight - main.clientHeight,
                mainBottom: main.getBoundingClientRect().bottom,
                bottoms,
                bars: document.querySelectorAll("#qCi .bar").length,
                lines: document.querySelectorAll("#qCi path.rolling").length,
              };
            }, undefined);
            expect(page.errors()).toEqual([]);
            expect(g.pageScroll).toBeLessThanOrEqual(0);
            expect(g.mainScroll).toBeLessThanOrEqual(0);
            expect(g.bottoms).toHaveLength(4);
            for (const b of g.bottoms) expect(b).toBeLessThanOrEqual(g.mainBottom + 1);
            expect(g.bars).toBe(4);
            expect(g.lines).toBe(1);
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(
                join(evidence, `telemetry-quality-${width}x${height}-${scheme}.png`),
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
});
