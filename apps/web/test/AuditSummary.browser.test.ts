// @vitest-environment node
import { CODE_HEALTH_OVERVIEW_FILES_MAX } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";
import { overviewFixture } from "./codeHealthOverviewFixtures.ts";

const { renderAt } = browserSession();

interface Options {
  rows?: number;
  long?: boolean;
  files?: number;
  outside?: number;
  longPath?: boolean;
}
function api(options: Options = {}) {
  const at = Date.now();
  const long = "A very long recorded title that keeps going and going so it has to wrap. ".repeat(
    6,
  );
  const over = overviewFixture({
    rows: options.rows ?? 8,
    generatedAt: at,
    // The server sends up to ten landing files; the first screen is checked with all of them.
    files: options.files ?? CODE_HEALTH_OVERVIEW_FILES_MAX,
    outside: options.outside,
    longPath: options.longPath,
    rowOver: (n) =>
      options.long
        ? { title: `${long}${n}`, observation: `${long.repeat(3)}${n}`, uncertainty: long }
        : {},
  });
  return { ...codeHealthBrowserApi(at), "/api/code-health/overview?repo=sample&window=30d": over };
}

const measure = (page: Awaited<ReturnType<typeof renderAt>>) =>
  page.evaluate(() => {
    const rect = (e: Element) => e.getBoundingClientRect();
    const list = document.querySelector(".as-do .as-scroll");
    const rows = [...document.querySelectorAll(".as-rec")];
    const visible = list
      ? rows.filter((r) => rect(r).top >= rect(list).top && rect(r).bottom <= rect(list).bottom)
      : [];
    const cols = [...document.querySelectorAll(".as-col")].map((c) => rect(c));
    const main = document.querySelector("main");
    return {
      height: innerHeight,
      pageScrolls:
        document.documentElement.scrollHeight > innerHeight ||
        (main ? main.scrollHeight > main.clientHeight + 1 : true),
      sideways: document.documentElement.scrollWidth > innerWidth,
      columns: cols.length,
      leftBeforeRight: cols.length === 2 && cols[0].left < cols[1].left,
      verdict: !!document.querySelector(".as-verdict")?.textContent,
      visibleRows: visible.length,
      totalRows: rows.length,
      firstOpen: document.querySelector("button.as-rt")?.getAttribute("aria-expanded") === "true",
      panelsInside: [...document.querySelectorAll(".as-cols > .as-col > .panel")].every(
        (p) => rect(p).bottom <= innerHeight + 1,
      ),
      // Every section of the open row's detail sits inside the Do next list, with no sideways travel.
      detailInside: (() => {
        const sections = [...document.querySelectorAll(".as-more .as-mg > div")];
        if (!list || sections.length === 0) return false;
        const b = rect(list);
        const right = b.left + list.clientWidth;
        return (
          list.scrollWidth <= list.clientWidth + 1 &&
          sections.every((d) => rect(d).left >= b.left - 1 && rect(d).right <= right + 1)
        );
      })(),
      detailDebug: JSON.stringify({
        list: list && { left: rect(list).left, client: list.clientWidth, scroll: list.scrollWidth },
        sections: [...document.querySelectorAll(".as-more .as-mg > div")].map((d) => ({
          left: Math.round(rect(d).left),
          right: Math.round(rect(d).right),
          scroll: d.scrollWidth,
          client: d.clientWidth,
        })),
      }),
      figures: [...document.querySelectorAll(".as-hrow")].length,
      figuresDebug: JSON.stringify(
        [...document.querySelectorAll(".as-hrow")].map((r) => {
          const l = r.closest(".as-scroll");
          return {
            rowBottom: Math.round(rect(r).bottom),
            boxBottom: l ? Math.round(rect(l).bottom) : null,
          };
        }),
      ),
      figuresVisible: [...document.querySelectorAll(".as-hrow")].filter((r) => {
        const l = r.closest(".as-scroll");
        return !!l && rect(r).top >= rect(l).top && rect(r).bottom <= rect(l).bottom + 1;
      }).length,
      landingRows: [...document.querySelectorAll(".as-files tr.as-frow")].filter((r) => {
        const l = r.closest(".as-scroll");
        return !!l && rect(r).top >= rect(l).top && rect(r).bottom <= rect(l).bottom;
      }).length,
      landingOverlapsPast: (() => {
        const past = document.querySelector(".as-past");
        if (!past) return false;
        const p = rect(past);
        // A row scrolled out of its list is clipped, not painted: only the part inside the list counts.
        return [...document.querySelectorAll(".as-files tr.as-frow")].some((r) => {
          const l = r.closest(".as-scroll");
          if (!l) return false;
          const b = rect(r),
            box = rect(l),
            top = Math.max(b.top, box.top),
            bottom = Math.min(b.bottom, box.bottom);
          return bottom > top && bottom > p.top && top < p.bottom;
        });
      })(),
      // A ranked row cut through its middle by the bottom of the Do next list.
      cutRow: list
        ? rows.filter((r) => {
            const b = rect(r),
              l = rect(list);
            return b.top < l.bottom - 1 && b.bottom > l.bottom + 1;
          }).length
        : 0,
      // The verdict is the first line under the nav, with Repo and the window control beside it.
      verdictTop: document.querySelector(".as-verdict")?.getBoundingClientRect().top ?? -1,
      verdictBeside: (() => {
        const v = document.querySelector(".as-verdict"),
          f = document.querySelector(".ch-filters");
        if (!v || !f) return false;
        const a = rect(v),
          b = rect(f);
        return b.top < a.bottom && b.bottom > a.top;
      })(),
      doNextTop: document.querySelector(".as-do")?.getBoundingClientRect().top ?? -1,
      recHeights: [...document.querySelectorAll(".as-do tr.as-rec:not(.as-open)")].map((r) =>
        Math.round(rect(r).height),
      ),
      measureRowHeights: [
        ...document.querySelectorAll(".as-hrow"),
        ...document.querySelectorAll(".as-frow"),
      ].map((r) => Math.round(rect(r).height)),
      headCase: getComputedStyle(document.querySelector(".as-do thead th") as Element)
        .textTransform,
      heads: [...document.querySelectorAll(".as-do thead th")].map((h) => h.textContent),
      stageCells: document.querySelectorAll(".as-past .as-cell").length,
      dayLabels: [...document.querySelectorAll(".as-axis span")].filter((e) => e.textContent)
        .length,
      legendInHeader: !!document.querySelector(".as-build .ph .as-lg"),
      truncatedMeta: [...document.querySelectorAll(".as-hrow .as-fmeta")].filter(
        (e) => e.scrollWidth > e.clientWidth,
      ).length,
      plotHeight: document.querySelector(".as-plot svg")?.getBoundingClientRect().height ?? 0,
      filesScroll: (() => {
        const l = document.querySelector(".as-files .as-scroll");
        return !!l && l.scrollHeight > l.clientHeight;
      })(),
      listScrolls: list ? list.scrollHeight > list.clientHeight : false,
      small: [
        ...document.querySelectorAll(".as-cols button, .as-cols select, .as-cols a[href]"),
      ].filter((e) => {
        const r = rect(e);
        return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
      }).length,
    };
  }, undefined);

describeRendered("Audit first screen in a real browser", () => {
  for (const [width, height] of [
    [1920, 940],
    [2560, 1145],
  ])
    for (const colorScheme of ["dark", "light"] as const)
      it(
        `shows the verdict, both columns and five ranked rows at ${width}x${height} in ${colorScheme}`,
        async () => {
          const page = await renderAt({
            page: "test/auditSummaryBrowser.html",
            width,
            height,
            colorScheme,
            api: api(),
          });
          try {
            await page.boxes(".as-rec");
            await page.evaluate(() => document.fonts.ready.then(() => 0), undefined);
            const m = await measure(page);
            expect(m.verdict).toBe(true);
            expect(m.columns).toBe(2);
            expect(m.leftBeforeRight).toBe(true);
            expect(m.totalRows).toBe(8);
            expect(m.visibleRows).toBeGreaterThanOrEqual(5);
            expect(m.firstOpen).toBe(true);
            expect(m.landingRows).toBeGreaterThanOrEqual(2);
            expect(m.plotHeight, "the chart is a useful plot").toBeGreaterThanOrEqual(
              width < 2200 ? 64 : 100,
            );
            expect(m.filesScroll, "the files list scrolls its extra rows").toBe(true);
            expect(m.truncatedMeta, "no figure unit or window is cut off").toBe(0);
            expect(m.cutRow, "Do next ends on a whole row").toBe(0);
            expect(m.verdictTop, "the verdict is the first line under the nav").toBeLessThan(90);
            expect(m.verdictBeside, "Repo and the window control sit on the verdict line").toBe(
              true,
            );
            expect(m.doNextTop, "Do next starts high").toBeLessThan(160);
            expect(m.heads, "Do next has a From column").toContain("From");
            expect(m.headCase, "column heads are mixed case").toBe("none");
            for (const h of m.recHeights)
              expect(h, "a closed Do next row is about 49 px").toBeGreaterThanOrEqual(47);
            for (const h of m.recHeights)
              expect(h, "a closed Do next row is about 49 px").toBeLessThanOrEqual(52);
            for (const h of m.measureRowHeights)
              expect(h, "a measure or file row is about 32 px").toBeLessThanOrEqual(35);
            expect(m.stageCells, "the stage strip has eight cells").toBe(8);
            expect(m.dayLabels, "every day is labelled on the axis").toBe(14);
            expect(m.legendInHeader, "the legend sits in the panel header").toBe(true);
            expect(m.figures).toBe(5);
            expect(m.figuresVisible, `every figure is fully visible: ${m.figuresDebug}`).toBe(5);
            expect(m.detailInside, m.detailDebug).toBe(true);
            expect(m.pageScrolls).toBe(false);
            expect(m.sideways).toBe(false);
            expect(m.panelsInside).toBe(true);
            expect(m.small).toBe(0);
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );

  for (const [name, options] of [
    ["none", { rows: 0 }],
    ["one", { rows: 1 }],
    ["fifty", { rows: 50, files: 10, outside: 30 }],
    ["long text", { rows: 8, long: true }],
    ["long file paths", { rows: 8, longPath: true }],
  ] as const)
    it(
      `keeps the page still and the lists reachable with ${name} rows at 1920x940`,
      async () => {
        const page = await renderAt({
          page: "test/auditSummaryBrowser.html",
          width: 1920,
          height: 940,
          colorScheme: "dark",
          api: api(options),
        });
        try {
          await page.boxes(options.rows === 0 ? ".as-empty" : ".as-rec");
          const m = await measure(page);
          expect(m.pageScrolls).toBe(false);
          expect(m.sideways).toBe(false);
          expect(m.panelsInside).toBe(true);
          if (options.rows === 50) expect(m.listScrolls).toBe(true);
          if ("longPath" in options) {
            expect(m.landingRows, "two landing rows fit").toBeGreaterThanOrEqual(2);
            const p = await page.evaluate(async () => {
              const b = document.querySelector<HTMLButtonElement>(".as-files button.as-pathbtn");
              if (!b) return null;
              const cut = b.scrollWidth > b.clientWidth;
              b.focus();
              b.click();
              // React applies the state change on a later frame.
              await new Promise<void>((done) =>
                requestAnimationFrame(() => requestAnimationFrame(() => done())),
              );
              const r = b.getBoundingClientRect();
              const list = b.closest(".as-scroll");
              return {
                cut,
                focused: document.activeElement === b,
                open: b.getAttribute("aria-expanded") === "true",
                whole: b.scrollWidth <= b.clientWidth + 1,
                reachable:
                  !!list && list.scrollHeight >= r.bottom - list.getBoundingClientRect().top,
              };
            }, undefined);
            expect(p).toEqual({
              cut: true,
              focused: true,
              open: true,
              whole: true,
              reachable: true,
            });
          }
          if (options.rows !== 0) expect(m.detailInside, m.detailDebug).toBe(true);
          if (options.rows !== 0) {
            const reachable = await page.reachable(".as-do .as-scroll tr.as-rec");
            expect(reachable).toHaveLength(options.rows);
            expect(reachable.every(Boolean)).toBe(true);
          }
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );

  // The real shell has a footer bar, and a notice appears when the page is disconnected: the files
  // list must keep a header and two rows, and no panel may paint over another.
  for (const [width, height] of [
    [1920, 940],
    [2560, 1145],
  ])
    it(
      `keeps two landing rows and no overlap with the footer bar and a disconnected notice at ${width}x${height}`,
      async () => {
        const page = await renderAt({
          page: "test/auditSummaryBrowser.html",
          width,
          height,
          colorScheme: "dark",
          api: api(),
        });
        try {
          await page.boxes(".as-rec");
          await page.evaluate(() => {
            (globalThis as { __streamDown?: () => void }).__streamDown?.();
            return new Promise<number>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done(0))),
            );
          }, undefined);
          const m = await measure(page);
          expect(m.landingRows, "two landing rows fit").toBeGreaterThanOrEqual(2);
          expect(m.figuresVisible, m.figuresDebug).toBe(5);
          expect(m.plotHeight, "the chart is a useful plot").toBeGreaterThanOrEqual(
            width < 2200 ? 64 : 100,
          );
          expect(m.filesScroll, "the files list scrolls").toBe(true);
          expect(m.landingOverlapsPast, "landing rows do not overlap past results").toBe(false);
          expect(m.pageScrolls).toBe(false);
          expect(m.panelsInside).toBe(true);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
});
