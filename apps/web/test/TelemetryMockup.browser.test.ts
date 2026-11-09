// @vitest-environment node

import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";

const { renderAt } = browserSession();

const TABS = ["crew", "cost", "throughput", "quality", "machine"] as const;
const THEMES = ["dark", "light"] as const;
const SIZES = [
  [1280, 900],
  [1600, 1000],
  [1920, 940],
] as const;
const STATES = ["loading", "empty", "error", "stale", "disconnected"] as const;
const PAGE = "test/telemetryMockupBrowser.html";

interface Probe {
  clipped: string[];
  overflowX: number;
  height: number;
  bandHeight: number;
  gridTop: number;
  lastPanelBottom: number;
  workBottom: number;
  tileMin: number;
  tilesClipped: string[];
  valueSpill: string[];
  thin: string[];
}

/** What a person would find broken on the settled page: clipped panels, spill, sideways scroll. */
const probe = (page: RenderedPage): Promise<Probe> =>
  page.evaluate(() => {
    const root = document.documentElement;
    const clipped: string[] = [];
    const thin: string[] = [];
    for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
      const name = panel.dataset.panel ?? "state";
      const box = panel.getBoundingClientRect();
      if (panel.scrollHeight > panel.clientHeight + 1) clipped.push(`${name} tall`);
      if (panel.scrollWidth > panel.clientWidth + 1) clipped.push(`${name} wide`);
      for (const el of panel.querySelectorAll<HTMLElement>("*")) {
        if (el.closest("[data-scroll]") && !el.matches("[data-scroll]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > box.right + 1 || r.bottom > box.bottom + 1)
          clipped.push(`${name} ${el.className}`);
      }
      for (const s of panel.querySelectorAll<HTMLElement>("[data-scroll]")) {
        const r = s.getBoundingClientRect();
        if (r.height < 40 || r.width < 80) clipped.push(`${name} scroller tiny`);
      }
      // A chart and its readout, or a list, should use the panel's width.
      const body = panel.querySelector<HTMLElement>(".pbody");
      if (body && panel.querySelector(".chart, .rows")) {
        const used = [...body.children].reduce(
          (sum, child) => sum + child.getBoundingClientRect().width,
          0,
        );
        if (used < body.getBoundingClientRect().width * 0.8) thin.push(name);
      }
    }
    const tiles = [...document.querySelectorAll<HTMLElement>(".band .stat, .summary .stat")];
    return {
      clipped,
      overflowX: root.scrollWidth - root.clientWidth,
      height: root.scrollHeight,
      bandHeight: document.querySelector(".band")?.getBoundingClientRect().height ?? 0,
      gridTop: document.querySelector(".grid")?.getBoundingClientRect().top ?? 0,
      lastPanelBottom: Math.max(
        ...[...document.querySelectorAll(".panel")].map((p) => p.getBoundingClientRect().bottom),
      ),
      workBottom: document.querySelector(".work")?.getBoundingClientRect().bottom ?? 0,
      tileMin: Math.min(
        ...[...document.querySelectorAll<HTMLElement>(".band .stat")].map(
          (t) => t.getBoundingClientRect().width,
        ),
      ),
      tilesClipped: tiles
        .filter((t) => t.scrollHeight > t.clientHeight + 1)
        .map((t) => t.dataset.stat ?? ""),
      // A value or its unit must stay inside its own tile.
      valueSpill: tiles
        .filter((t) => {
          const tile = t.getBoundingClientRect();
          return [...t.querySelectorAll<HTMLElement>(".stat-value, .stat-unit, .stat-sub")].some(
            (child) => child.getBoundingClientRect().right > tile.right + 1,
          );
        })
        .map((t) => t.dataset.stat ?? ""),
      thin,
    };
  }, null);

const expectSound = (result: Probe, where: string) => {
  expect(result.clipped, where).toEqual([]);
  expect(result.overflowX, where).toBeLessThanOrEqual(0);
  expect(result.tilesClipped, where).toEqual([]);
  expect(result.valueSpill, where).toEqual([]);
  expect(result.bandHeight, where).toBeLessThanOrEqual(96);
};

describeRendered("Telemetry mockup in a browser", () => {
  it(
    "fits every tab at each width and theme",
    async () => {
      for (const [width, height] of SIZES) {
        for (const theme of THEMES) {
          for (const tab of TABS) {
            const where = `${tab} ${theme} ${width}x${height}`;
            const page = await renderAt({
              page: PAGE,
              search: `?tab=${tab}&theme=${theme}`,
              width,
              height,
              colorScheme: theme,
            });
            await page.box(".panel");
            const result = await probe(page);
            expect(page.errors(), where).toEqual([]);
            expectSound(result, where);
            expect(result.thin, where).toEqual([]);
            expect(await page.evaluate(() => document.documentElement.dataset.theme, null)).toBe(
              theme,
            );
            expect(result.tileMin, where).toBeGreaterThanOrEqual(width >= 1600 ? 180 : 140);
            if (width === 1600 && height === 1000) {
              expect(result.height, where).toBeLessThanOrEqual(1000);
              expect(result.lastPanelBottom, where).toBeLessThanOrEqual(result.workBottom + 1);
            }
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "adds no page height when the Table view replaces the charts",
    async () => {
      for (const [width, height] of SIZES) {
        for (const tab of TABS) {
          const where = `${tab} ${width}x${height}`;
          const page = await renderAt({
            page: PAGE,
            search: `?tab=${tab}&theme=dark`,
            width,
            height,
            colorScheme: "dark",
          });
          await page.box(".panel");
          const charts = await probe(page);
          await page.click('#view [data-view="table"]');
          await page.box(".panel table");
          const table = await probe(page);
          expect(page.errors(), where).toEqual([]);
          // The contract permits a shorter table; it prohibits adding page height.
          expect(table.height, where).toBeLessThanOrEqual(charts.height);
          expect(table.gridTop, where).toBe(charts.gridTop);
          expectSound(table, where);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );

  it(
    "draws every state on every tab without clipping or errors",
    async () => {
      for (const tab of TABS) {
        for (const state of STATES) {
          const where = `${tab} ${state}`;
          const page = await renderAt({
            page: PAGE,
            search: `?tab=${tab}&theme=dark&state=${state}`,
            width: 1600,
            height: 1000,
            colorScheme: "dark",
          });
          await page.box(".grid");
          const result = await probe(page);
          expect(page.errors(), where).toEqual([]);
          expectSound(result, where);
          expect(result.height, where).toBeLessThanOrEqual(1000);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "recomposes with FLIGHT's dock open, and at 2560",
    async () => {
      const cases = [
        [1600, 1000, "&flight=open"],
        [1920, 940, "&flight=open"],
        [2560, 1145, "&flight=open"],
        [2560, 1145, ""],
        [2560, 1250, ""],
      ] as const;
      for (const [width, height, extra] of cases) {
        for (const tab of TABS) {
          const where = `${tab} ${width}x${height}${extra}`;
          const page = await renderAt({
            page: PAGE,
            search: `?tab=${tab}&theme=dark${extra}`,
            width,
            height,
            colorScheme: "dark",
          });
          await page.box(".panel");
          const result = await probe(page);
          expect(page.errors(), where).toEqual([]);
          expectSound(result, where);
          expect(result.thin, where).toEqual([]);
          expect(result.tileMin, where).toBeGreaterThanOrEqual(140);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "holds the worst case: a long verdict, a 300-character title and 50 tickets",
    async () => {
      for (const [width, height] of SIZES) {
        for (const tab of TABS) {
          const where = `worst ${tab} ${width}x${height}`;
          const page = await renderAt({
            page: PAGE,
            search: `?tab=${tab}&theme=dark&data=worst`,
            width,
            height,
            colorScheme: "dark",
          });
          await page.box(".panel");
          const result = await probe(page);
          expect(page.errors(), where).toEqual([]);
          expectSound(result, where);
          if (width === 1600) {
            expect(result.height, where).toBeLessThanOrEqual(height);
            expect(result.lastPanelBottom, where).toBeLessThanOrEqual(result.workBottom + 1);
          }
          await page.click('#view [data-view="table"]');
          await page.box(".panel table");
          expectSound(await probe(page), `${where} table`);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );

  it(
    "keeps every definition inside the window when its number takes focus",
    async () => {
      for (const [width, height] of SIZES) {
        const page = await renderAt({
          page: PAGE,
          search: "?tab=cost&theme=dark",
          width,
          height,
          colorScheme: "dark",
        });
        await page.box(".panel");
        const result = await page.evaluate(() => {
          const spill: string[] = [];
          for (const value of document.querySelectorAll<HTMLElement>(
            ".band .stat-value, .summary .stat-value",
          )) {
            value.focus();
            const def = value.closest(".stat")?.querySelector<HTMLElement>(".stat-def");
            const box = def?.getBoundingClientRect();
            const root = document.documentElement;
            if (!box || box.left < 0 || box.right > root.clientWidth + 0.5)
              spill.push(value.closest<HTMLElement>(".stat")?.dataset.stat ?? "");
            if (root.scrollWidth > root.clientWidth)
              spill.push(`scroll after ${value.dataset.label}`);
          }
          return spill;
        }, null);
        expect(result, `${width}x${height}`).toEqual([]);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );

  it(
    "scrolls instead of clipping at 1600x700",
    async () => {
      const page = await renderAt({ page: PAGE, search: "?tab=cost", width: 1600, height: 700 });
      await page.box(".panel");
      const result = await probe(page);
      expect(result.clipped).toEqual([]);
      const space = await page.evaluate(() => {
        const work = document.querySelector<HTMLElement>(".work");
        work?.focus();
        return { height: work?.clientHeight ?? 0, total: work?.scrollHeight ?? 0 };
      }, null);
      expect(space.total).toBeGreaterThan(space.height);
      await page.press("End");
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const work = document.querySelector<HTMLElement>(".work");
              const last = document.querySelector<HTMLElement>(".panel:last-child");
              return (
                !!work &&
                !!last &&
                work.scrollTop > 0 &&
                last.getBoundingClientRect().bottom <= work.getBoundingClientRect().bottom + 1
              );
            }, null),
          { timeout: 2000 },
        )
        .toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it("keeps the enlarged 4K shell inside its viewport", async () => {
    const page = await renderAt({
      page: PAGE,
      search: "?tab=crew&theme=dark",
      width: 3840,
      height: 2160,
      colorScheme: "dark",
    });
    try {
      await page.box(".panel");
      const geometry = await page.evaluate(
        () => ({
          height: document.documentElement.scrollHeight,
          bottom: document.querySelector(".keys")?.getBoundingClientRect().bottom,
        }),
        null,
      );
      expect(geometry.height).toBeLessThanOrEqual(2160);
      expect(geometry.bottom).toBeLessThanOrEqual(2160);
      expect(page.errors()).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

describeRendered("Telemetry readout actions", () => {
  it(
    "reaches and activates a named readout target with the keyboard on every tab",
    async () => {
      for (const tab of TABS) {
        const page = await renderAt({
          page: PAGE,
          width: 1600,
          height: 1000,
          search: `?tab=${tab}`,
        });
        try {
          await page.evaluate(
            () => document.querySelector<HTMLElement>(".readout")?.focus(),
            undefined,
          );
          await page.press("Tab");
          const focused = await page.evaluate(() => {
            const button = document.activeElement as HTMLButtonElement;
            return {
              readout: !!button.closest(".readout"),
              tag: button.tagName,
              target: button.dataset.target,
              drill: button.dataset.drill,
            };
          }, undefined);
          expect(focused.readout, tab).toBe(true);
          expect(focused.tag).toBe("BUTTON");
          expect(focused.target?.length).toBeGreaterThan(0);
          const box = await page.box(".readout button:focus");
          expect(box.width).toBeGreaterThanOrEqual(24);
          expect(box.height).toBeGreaterThanOrEqual(24);
          await page.press("Enter");
          if (focused.drill === "needs-build") {
            expect(
              await page.evaluate(
                () => !document.querySelector<HTMLElement>("#dlg")?.hidden,
                undefined,
              ),
            ).toBe(true);
            await page.press("Escape");
            expect(
              await page.evaluate(() => !!document.activeElement?.closest(".readout"), undefined),
            ).toBe(true);
          } else {
            expect(
              await page.evaluate(() => document.querySelector("#notice")?.textContent, undefined),
            ).toContain(focused.target);
          }
          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
