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
import { costTelemetry, costTelemetryApi } from "./telemetryCostFixture.ts";

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

const apiWithMissingCosts = () => {
  const data = costTelemetry();
  data.totals = data.totals.map((row, i) => (i < 3 ? { ...row, costUsd: null } : row));
  return { ...api(), "/api/telemetry?range=24h": data };
};

const apiWithLongTicketTitle = () => {
  const base = api();
  const config = base["/api/config"] as { repos: { id: string }[] };
  return {
    ...base,
    "/api/config": {
      ...config,
      repos: [...config.repos, { id: "mission-control" }],
    },
    "/api/boards/mission-control": [
      {
        repoId: "mission-control",
        issueNumber: 1900,
        title: "A complete ranked ticket title stays readable when the chart label is clipped",
        status: "In Progress",
        state: "open",
        labels: [],
      },
    ],
  };
};

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
      stepTotal: box("#tStepBars .step-summary"),
      stepNote: box("#tStepBars .pnote"),
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
            // The desktop fixture keeps only `path`; encode the tab query inside it.
            search: "?path=/telemetry%3Ftab%3Dcost",
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
            expect(g.stepTotal).not.toBeNull();
            expect(g.stepNote).not.toBeNull();
            expect((g.stepTotal as { b: number }).b).toBeLessThanOrEqual(
              (g.stepNote as { y: number }).y,
            );
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
    "shows the complete missing-cost explanation on keyboard focus",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "dark",
        api: apiWithMissingCosts(),
        search: "?path=/telemetry%3Ftab%3Dcost",
      });
      try {
        await ready(page);
        const coverage = await page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>('[data-stat="ccover"] button');
          const tip = document.querySelector<HTMLElement>('[data-stat="ccover"] [role="tooltip"]');
          button?.focus();
          return {
            text: tip?.textContent ?? "",
            visible: tip && getComputedStyle(tip).display !== "none",
          };
        }, undefined);
        expect(coverage.visible).toBe(true);
        expect(coverage.text).toContain("not counted as $0.");
        expect(coverage.text).toContain("dev-2 on sonnet");
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot(join(evidence, "telemetry-cost-coverage-focus-1600x1000-dark.png"));
        }
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  for (const interaction of ["hover", "focus"] as const) {
    it(
      `shows a complete ranked ticket title inside the viewport on ${interaction}`,
      async () => {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1600,
          height: 700,
          colorScheme: "dark",
          api: apiWithLongTicketTitle(),
          search: "?path=/telemetry%3Ftab%3Dcost",
        });
        try {
          await ready(page);
          const title = await page.evaluate(async (kind) => {
            const label = document.querySelector<HTMLElement>(".ticket-label");
            if (kind === "focus") label?.focus();
            else label?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const tip = document.querySelector<HTMLElement>("[data-ticket-title-tooltip]");
            const box = tip?.getBoundingClientRect();
            return {
              text: tip?.textContent ?? "",
              visible: Boolean(box && box.width > 0 && box.height > 0),
              inside: Boolean(
                box &&
                  box.left >= 0 &&
                  box.top >= 0 &&
                  box.right <= innerWidth &&
                  box.bottom <= innerHeight,
              ),
            };
          }, interaction);
          expect(title.visible).toBe(true);
          expect(title.inside).toBe(true);
          expect(title.text).toContain("A complete ranked ticket title stays readable");
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "keeps token throughput and quota readings in a short viewport",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 700,
        colorScheme: "dark",
        api: api(),
        search: "?path=/telemetry%3Ftab%3Dcost",
      });
      try {
        await ready(page);
        const short = await page.evaluate(() => {
          const visible = (selector: string) => {
            const r = document.querySelector(selector)?.getBoundingClientRect();
            return Boolean(r && r.top >= 0 && r.bottom <= innerHeight);
          };
          return {
            pageScroll: document.documentElement.scrollHeight - innerHeight,
            mainScroll:
              (document.querySelector("main") as HTMLElement).scrollHeight -
              (document.querySelector("main") as HTMLElement).clientHeight,
            tokenChart: visible("#tTok [role=img]"),
            quotaMeter: visible("#tQuotaUsed .quota-row"),
          };
        }, undefined);
        expect(short.pageScroll).toBeLessThanOrEqual(0);
        expect(short.mainScroll).toBeLessThanOrEqual(0);
        expect(short.tokenChart).toBe(true);
        expect(short.quotaMeter).toBe(true);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot(join(evidence, "telemetry-cost-1600x700-dark.png"));
        }
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the table view inside the work area, scrolling within it",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "dark",
        api: api(),
        // The desktop fixture keeps only `path`; encode the tab and view queries inside it.
        search: "?path=/telemetry%3Ftab%3Dcost%26view%3Dtable",
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
