// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

const PAGE = "test/dependenciesMockupBrowser.html";
const VIEWS = ["board", "flight", "qa"] as const;
const THEMES = ["light", "dark"] as const;
/** The Design section's viewports; the last may scroll the page. */
const VIEWPORTS: ReadonlyArray<readonly [number, number, boolean]> = [
  [1920, 1080, false],
  [2560, 1440, false],
  [1920, 940, false],
  [2560, 1145, false],
  [2560, 1250, false],
  [3840, 2160, false],
  [1280, 900, true],
  [1600, 700, true],
];

/**
 * Runs in the page, so it uses nothing from this file. `clipped` names panels whose content
 * spills past their box (a scroller inside a panel is fine); `small` names text under 11 px.
 */
const measure = () => {
  const root = document.scrollingElement ?? document.documentElement;
  const panels = [...document.querySelectorAll<HTMLElement>(".panel")];
  return {
    panels: panels.length,
    sideways: root.scrollWidth - root.clientWidth,
    pageScroll: root.scrollHeight - root.clientHeight,
    clipped: panels
      .filter(
        (panel) =>
          panel.scrollWidth > panel.clientWidth + 1 || panel.scrollHeight > panel.clientHeight + 1,
      )
      .map((panel) => panel.id || panel.className),
    small: [...document.querySelectorAll<HTMLElement>("main *")]
      .filter(
        (el) =>
          [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
          Number.parseFloat(getComputedStyle(el).fontSize) < 11,
      )
      .map((el) => el.className),
  };
};

describeRendered("Dependencies mockup in a browser", () => {
  for (const view of VIEWS) {
    for (const theme of THEMES) {
      it(
        `renders each view at the ticket's sizes: ${view}, ${theme}`,
        async () => {
          for (const [width, height, mayScroll] of VIEWPORTS) {
            const page = await renderAt({
              page: PAGE,
              width,
              height,
              search: `?view=${view}&state=normal&theme=${theme}`,
              colorScheme: theme,
            });
            const where = `${view} ${theme} ${width}x${height}`;
            await page.boxes(".view-ready");
            expect(page.errors(), `${where}: script errors`).toEqual([]);
            const report = await page.evaluate(measure, null);
            expect(report.panels, `${where}: panels`).toBeGreaterThan(0);
            expect(report.sideways, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
            expect(report.clipped, `${where}: clipped panels`).toEqual([]);
            if (!mayScroll) {
              expect(report.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
            }
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS * 4,
      );
    }
  }

  it(
    "recomposes every view with the FLIGHT rail open",
    async () => {
      for (const view of VIEWS) {
        for (const [width, height, theme] of [
          [1920, 940, "dark"],
          [2560, 1145, "dark"],
          [1920, 940, "light"],
          [2560, 1145, "light"],
        ] as const) {
          const page = await renderAt({
            page: PAGE,
            width,
            height,
            search: `?view=${view}&state=normal&theme=${theme}&rail=open`,
            colorScheme: theme,
          });
          await page.boxes(".rail");
          const where = `${view} ${width}x${height} ${theme} rail open`;
          expect(page.errors(), `${where}: script errors`).toEqual([]);
          const report = await page.evaluate(measure, null);
          expect(report.clipped, `${where}: clipped panels`).toEqual([]);
          expect(report.sideways, `${where}: sideways`).toBeLessThanOrEqual(0);
          expect(report.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );

  it(
    "shows PR 1033's root row without page scrolling at 1920x940",
    async () => {
      const page = await renderAt({
        page: PAGE,
        width: 1920,
        height: 940,
        search: "?view=flight&state=normal&theme=dark",
        colorScheme: "dark",
      });
      await page.boxes('[data-ref="PR 1033"]');
      expect(await page.reachable('[data-ref="PR 1033"]', "#chainsP")).toEqual([true]);
      const box = await page.box('[data-ref="PR 1033"]');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(940);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps every state readable and unclipped at 1920x940, dark",
    async () => {
      for (const view of VIEWS) {
        for (const state of [
          "normal",
          "many",
          "long",
          "loading",
          "empty",
          "error",
          "stale",
          "disconnected",
        ]) {
          const page = await renderAt({
            page: PAGE,
            width: 1920,
            height: 940,
            search: `?view=${view}&state=${state}&theme=dark`,
            colorScheme: "dark",
          });
          await page.boxes(".view-ready");
          const where = `${view} ${state}`;
          expect(page.errors(), `${where}: script errors`).toEqual([]);
          const report = await page.evaluate(measure, null);
          expect(report.sideways, `${where}: sideways`).toBeLessThanOrEqual(0);
          expect(report.small, `${where}: text under 11px`).toEqual([]);
          expect(report.clipped, `${where}: clipped panels`).toEqual([]);
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 6,
  );

  it(
    "makes every drill-through link at least 24x24 px",
    async () => {
      for (const view of VIEWS) {
        const page = await renderAt({
          page: PAGE,
          width: 1920,
          height: 940,
          search: `?view=${view}&state=normal&theme=dark`,
          colorScheme: "dark",
        });
        await page.boxes(".view-ready");
        const small = await page.evaluate(
          () =>
            [
              ...document.querySelectorAll<HTMLElement>(
                "#chainsP a, #wifP a, [data-chip] a, .reason a, [data-frees] a, .card .ctop a",
              ),
            ]
              .map((a) => ({ text: a.textContent, box: a.getBoundingClientRect() }))
              .filter(({ box }) => box.width < 24 || box.height < 24)
              .map(({ text }) => text),
          null,
        );
        expect(small, `${view}: links under 24x24`).toEqual([]);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );

  it(
    "scrolls a chain list that has more rows than fit, visibly, inside its panel",
    async () => {
      const page = await renderAt({
        page: PAGE,
        width: 1920,
        height: 940,
        search: "?view=flight&state=many&theme=dark",
        colorScheme: "dark",
      });
      await page.boxes("#chainsP .chains-scroll");
      const result = await page.evaluate(() => {
        const scroll = document.querySelector<HTMLElement>("#chainsP .chains-scroll");
        if (!scroll) return null;
        return {
          overflowY: getComputedStyle(scroll).overflowY,
          taller: scroll.scrollHeight > scroll.clientHeight,
          page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        };
      }, null);
      expect(result).toEqual({ overflowY: "auto", taller: true, page: 0 });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
