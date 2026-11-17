// @vitest-environment node
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
}
function api(options: Options = {}) {
  const at = Date.now();
  const long = "A very long recorded title that keeps going and going so it has to wrap. ".repeat(
    6,
  );
  const over = overviewFixture({
    rows: options.rows ?? 8,
    generatedAt: at,
    files: options.files,
    outside: options.outside,
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
            expect(m.detailInside).toBe(true);
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
          if (options.rows !== 0) expect(m.detailInside).toBe(true);
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
});
