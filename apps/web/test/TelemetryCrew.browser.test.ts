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
import { crewTelemetryApi } from "./telemetryCrewFixture.ts";

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

const api = (many = 1) => ({ ...desktopFixture().api, ...crewTelemetryApi(many) });

/** What a person sees: whether the work area scrolls, and where each part sits. */
async function geometry(page: RenderedPage) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom, r: r.right };
    };
    const main = document.querySelector("main") as HTMLElement;
    const tiles = [...document.querySelectorAll(".band .stat")].map(
      (e) => e.getBoundingClientRect().top,
    );
    return {
      vw: innerWidth,
      vh: innerHeight,
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      mainScroll: main.scrollHeight - main.clientHeight,
      mainBottom: main.getBoundingClientRect().bottom,
      bandRows: new Set(tiles.map((t) => Math.round(t))).size,
      bandCount: tiles.length,
      page: box("#page-telemetry"),
      state: box("#tCrewState"),
      time: box("#tUtil"),
      summary: box(".summary"),
      tabs: box(".tablist"),
      lanes: document.querySelectorAll("#tCrewState .lane").length,
      laneScroll: (() => {
        const l = document.querySelector("#tCrewState .crew-lanes") as HTMLElement | null;
        return l ? l.scrollHeight - l.clientHeight : null;
      })(),
      timeScroll: (() => {
        const l = document.querySelector("#tUtil .rows") as HTMLElement | null;
        return l ? l.scrollHeight - l.clientHeight : null;
      })(),
      sideBySide: (() => {
        const a = document.querySelector("#tCrewState")?.getBoundingClientRect();
        const b = document.querySelector("#tUtil")?.getBoundingClientRect();
        return !!a && !!b && Math.abs(a.top - b.top) < 2;
      })(),
    };
  }, undefined);
}

describeRendered("Telemetry, Crew tab, in a browser", () => {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [
      [1600, 1000],
      [2560, 1250],
    ] as const) {
      it(
        `fits one screen with eleven seats at ${width}x${height}, ${scheme}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api(),
            search: "?path=/telemetry",
          });
          try {
            await ready(page);
            const g = await geometry(page);
            expect(page.errors()).toEqual([]);
            // the page does not scroll, and neither does the work area
            expect(g.pageScroll).toBeLessThanOrEqual(0);
            expect(g.mainScroll).toBeLessThanOrEqual(0);
            // the health band is eight stats in one row
            expect(g.bandCount).toBe(8);
            expect(g.bandRows).toBe(1);
            // both panels are in view and the lanes list every seat
            expect((g.state as { b: number }).b).toBeLessThanOrEqual(g.mainBottom + 1);
            expect((g.time as { b: number }).b).toBeLessThanOrEqual(g.mainBottom + 1);
            expect(g.lanes).toBe(11);
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(
                join(evidence, `telemetry-crew-${width}x${height}-${scheme}.png`),
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
    "keeps lanes and agent time readable at 1600x700 and scrolls them inside their panels",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 700,
        colorScheme: "dark",
        api: api(),
        search: "?path=/telemetry",
      });
      try {
        await ready(page);
        const g = await geometry(page);
        expect(page.errors()).toEqual([]);
        // a short window may scroll the work area, never clip a panel
        expect(g.pageScroll).toBeLessThanOrEqual(0);
        expect(g.lanes).toBe(11);
        expect((g.state as { h: number }).h).toBeGreaterThanOrEqual(256);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "puts lanes and agent time side by side on a very wide work area",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 2560,
        height: 1250,
        colorScheme: "dark",
        api: api(),
        search: "?path=/telemetry",
      });
      try {
        await ready(page);
        expect((await geometry(page)).sideBySide).toBe(true);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the table view inside its panels with many rows",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "light",
        api: api(7),
        search: `?path=${encodeURIComponent("/telemetry?view=table")}`,
      });
      try {
        await ready(page);
        const g = await page.evaluate(() => {
          const wraps = [...document.querySelectorAll("#tLat .pb, #tSubs .pb")] as HTMLElement[];
          return {
            pageScroll: document.documentElement.scrollHeight - innerHeight,
            panels: wraps.map((w) => w.clientHeight),
            scrolls: wraps.map(
              (w) => w.scrollHeight > w.clientHeight && getComputedStyle(w).overflowY !== "visible",
            ),
          };
        }, undefined);
        expect(g.pageScroll).toBeLessThanOrEqual(0);
        expect(g.panels).toHaveLength(2);
        expect(g.scrolls.every(Boolean)).toBe(true);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
