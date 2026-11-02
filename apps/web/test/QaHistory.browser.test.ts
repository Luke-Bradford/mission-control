// @vitest-environment node
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { nativeQaFixture, qaHistoryApi, qaHistoryFixture } from "./qaHistoryFixture.ts";
import { qaReportApi, qaReportFixture } from "./qaReportFixture.ts";

const { renderAt } = browserSession();
describeRendered("QA history in the application shell", () => {
  it(
    "keeps history columns readable at required widths/themes and both rail states",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ])
        for (const colorScheme of ["light", "dark"] as const)
          for (const expanded of [false, true]) {
            const f = qaHistoryFixture(50),
              shell = desktopFixture();
            const long = width === 1280;
            if (long) {
              f.entries[0].title = "A deliberately long change title / ".repeat(24);
              f.entries[0].reviewer.label = "reviewer-with-a-long-specific-identity-".repeat(12);
            }
            const page = await renderAt({
              page: "test/desktopBrowser.html",
              width,
              height,
              colorScheme,
              search: `?path=${encodeURIComponent("/qa?view=history")}`,
              api: { ...shell.api, "/api/qa/history?limit=50": f },
            });
            try {
              await page.boxes(".qa-history-table tbody tr");
              if (expanded) await page.click("#dock .dockrail button");
              const facts = await page.evaluate(() => {
                const area = document.querySelector(".qa-history-scroll") as HTMLElement,
                  main = document.querySelector("main") as HTMLElement;
                const cells = [...document.querySelectorAll(".qa-history-table thead th")].map(
                  (el) => ({
                    text: el.textContent,
                    width: el.getBoundingClientRect().width,
                    scroll: el.scrollWidth,
                    client: el.clientWidth,
                  }),
                );
                const title = document
                  .querySelector(".qa-history > header")
                  ?.getBoundingClientRect();
                const filters = document
                  .querySelector(".qa-history > .qa-history-toolbar")
                  ?.getBoundingClientRect();
                const panel = document
                  .querySelector(".qa-history > .panel")
                  ?.getBoundingClientRect();
                if (!title || !filters || !panel) throw new Error("History layout regions missing");
                return {
                  headerFilterGap: filters.top - title.bottom,
                  filterTableGap: panel.top - filters.bottom,
                  width: document.documentElement.scrollWidth,
                  viewport: innerWidth,
                  table: area.scrollHeight > area.clientHeight,
                  tab: area.tabIndex,
                  cells,
                  mainScroll: main.scrollHeight,
                  mainHeight: main.clientHeight,
                };
              }, null);
              expect(facts.headerFilterGap).toBeGreaterThanOrEqual(0);
              expect(facts.headerFilterGap).toBeLessThanOrEqual(24);
              expect(facts.filterTableGap).toBeGreaterThanOrEqual(0);
              expect(facts.filterTableGap).toBeLessThanOrEqual(24);
              expect(facts.width).toBeLessThanOrEqual(width);
              expect(facts.table).toBe(true);
              expect(facts.tab).toBe(0);
              expect(facts.cells.every((c) => c.width >= 80 && c.scroll <= c.client + 1)).toBe(
                true,
              );
              await page.evaluate(() => {
                (document.querySelector(".qa-history-scroll") as HTMLElement).focus();
              }, null);
              await page.press("End");
              await page.evaluate(
                () =>
                  new Promise<void>((resolve, reject) => {
                    const started = performance.now();
                    const check = () => {
                      const area = document.querySelector(".qa-history-scroll") as HTMLElement;
                      if (area.scrollTop >= area.scrollHeight - area.clientHeight - 1) resolve();
                      else if (performance.now() - started > 1500)
                        reject(new Error("End did not reach the last history row"));
                      else requestAnimationFrame(check);
                    };
                    check();
                  }),
                null,
              );
              expect(
                await page.evaluate(() => {
                  const s = document.querySelector(".qa-history-scroll") as HTMLElement;
                  return s.scrollTop > 0;
                }, null),
              ).toBe(true);
              await page.evaluate(() => {
                const s = document.querySelector(".qa-history-scroll") as HTMLElement;
                s.scrollTop = 0;
                s.scrollLeft = 0;
                (document.querySelector(".qa-history-table summary") as HTMLElement).focus();
              }, null);
              await page.press("Enter");
              const identity = await page.evaluate(() => {
                const detail = document.querySelector(
                    ".qa-history-table details",
                  ) as HTMLDetailsElement,
                  cell = detail.closest("th");
                if (!cell) throw new Error("Identity cell missing");
                const bounds = cell.getBoundingClientRect(),
                  walker = document.createTreeWalker(detail, NodeFilter.SHOW_TEXT);
                let node = walker.nextNode(),
                  overflow = 0;
                while (node) {
                  const r = document.createRange();
                  r.selectNodeContents(node);
                  for (const rect of r.getClientRects())
                    if (
                      rect.width &&
                      (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5)
                    )
                      overflow++;
                  node = walker.nextNode();
                }
                return { open: detail.open, text: detail.textContent, overflow };
              }, null);
              expect(identity.open).toBe(true);
              expect(identity.text).toContain(f.entries[0].headSha);
              expect(identity.text).toContain(f.entries[0].reviewer.label);
              expect(identity.overflow).toBe(0);
              expect(page.errors()).toEqual([]);
            } finally {
              await page.close();
            }
          }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "opens older versions and native records by keyboard without current approval controls",
    async () => {
      const f = qaHistoryFixture(),
        r = qaReportFixture();
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 700,
        search: `?path=${encodeURIComponent("/qa?view=history")}`,
        api: {
          ...desktopFixture().api,
          ...qaHistoryApi(),
          "/api/qa/history?limit=50": f,
          [`/api/qa-reports/${r.id}`]: r,
          [`/api/qa/history/native/2?identity=${"d".repeat(64)}`]: nativeQaFixture(),
        },
      });
      try {
        await page.boxes(".qa-history-table");
        await page.evaluate(() => {
          (document.querySelector(".qa-history-table tbody a") as HTMLElement).focus();
        }, null);
        await page.press("Enter");
        await page.boxes("article.qa-report");
        expect(
          await page.evaluate(() => document.querySelector("article.qa-report")?.textContent, null),
        ).toContain(f.entries[0].headSha);
        expect(
          await page.evaluate(() => document.querySelectorAll(".uat-accept").length, null),
        ).toBe(0);
        await page.click('.qa-navigation a[href="/qa?view=history"]');
        await page.boxes(".qa-history-table");
        await page.click('.qa-history-table a[href*="native=2"]');
        await page.boxes(".qa-history-native");
        expect(
          await page.evaluate(
            () => ({
              text: document.body.textContent,
              images: document.querySelectorAll(".qa-history-native img").length,
            }),
            null,
          ),
        ).toMatchObject({ images: 0 });
        await page.click(".qa-history-native figure button");
        await page.boxes(".qa-history-native img");
        const image = await page.evaluate(async () => {
          const image = document.querySelector<HTMLImageElement>(".qa-history-native img");
          if (!image) throw new Error("Requested fixture screenshot missing");
          await image.decode();
          return {
            data: image.src.startsWith("data:image/png;base64,"),
            width: image.naturalWidth,
          };
        }, null);
        expect(image).toEqual({ data: true, width: 1 });

        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "names empty, one, loading, error and disconnected history states",
    async () => {
      for (const state of ["empty", "one", "loading", "error", "disconnected"]) {
        const count = state === "empty" ? 0 : state === "one" ? 1 : 3;
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1280,
          height: 700,
          colorScheme: "dark",
          search: `?path=${encodeURIComponent("/qa?view=history")}&qaState=${state}&state=${state === "disconnected" ? state : "default"}`,
          api: { ...desktopFixture().api, "/api/qa/history?limit=50": qaHistoryFixture(count) },
        });
        try {
          await page.boxes(
            state === "loading"
              ? ".qa-history [role=status]"
              : state === "error"
                ? ".qa-history [role=alert]"
                : state === "empty"
                  ? ".qa-history .panel"
                  : ".qa-history-table",
          );
          const text = await page.evaluate(() => document.body.textContent ?? "", null);
          expect(text).toContain(
            state === "empty"
              ? "No retained reviews"
              : state === "loading"
                ? "Loading review history"
                : state === "error"
                  ? "Review history could not be loaded"
                  : state === "disconnected"
                    ? "Disconnected from the hub"
                    : "Independent reviewer",
          );
          if (state === "one")
            expect(await page.boxes(".qa-history-table tbody tr")).toHaveLength(1);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth, null),
          ).toBe(true);
          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps Current and filled saved reports reachable below persistent navigation at short height",
    async () => {
      for (const colorScheme of ["light", "dark"] as const)
        for (const expanded of [false, true])
          for (const archived of [false, true]) {
            const report = qaReportFixture();
            const page = await renderAt({
              page: "test/desktopBrowser.html",
              width: 1600,
              height: 700,
              colorScheme,
              search: `?path=${encodeURIComponent(archived ? report.permalink : "/qa")}`,
              api: { ...desktopFixture().api, ...qaReportApi(3) },
            });
            try {
              await page.boxes("article.qa-report");
              if (expanded) await page.click("#dock .dockrail button");
              const before = await page.evaluate(() => {
                const items = [
                  ...document.querySelectorAll<HTMLElement>(
                    "main a[href], main button:not(:disabled), main textarea:not(:disabled), main summary, main input:not(:disabled)",
                  ),
                ].filter((e) => e.getBoundingClientRect().height > 0);
                const last = items.at(-1);
                if (!last) throw new Error("Last interactive content missing");
                last.focus();
                return last.textContent || last.getAttribute("aria-label") || last.tagName;
              }, null);
              await page.press("Shift+Tab");
              await page.press("Tab");
              const after = await page.evaluate(() => {
                const active = document.activeElement as HTMLElement,
                  rect = active.getBoundingClientRect(),
                  main = document.querySelector("main") as HTMLElement,
                  area = main.getBoundingClientRect();
                return {
                  text: active.textContent || active.getAttribute("aria-label") || active.tagName,
                  visible: rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1,
                  nav: document.querySelectorAll(".qa-navigation").length,
                  documentWidth: document.documentElement.scrollWidth,
                };
              }, null);
              expect(after.text).toBe(before);
              expect(after.visible).toBe(true);
              expect(after.nav).toBe(1);
              expect(after.documentWidth).toBeLessThanOrEqual(1600);
              expect(page.errors()).toEqual([]);
            } finally {
              await page.close();
            }
          }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a short history next to its heading and filters",
    async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1600,
          height: 1000,
          colorScheme,
          search: `?path=${encodeURIComponent("/qa?view=history")}`,
          api: { ...desktopFixture().api, ...qaHistoryApi(3) },
        });
        try {
          await page.boxes(".qa-history-table");
          await page.click("#dock .dockrail button");
          const flow = await page.evaluate(() => {
            const heading = document.querySelector(".qa-history > header")?.getBoundingClientRect(),
              filters = document
                .querySelector(".qa-history > .qa-history-toolbar")
                ?.getBoundingClientRect(),
              panel = document.querySelector(".qa-history > .panel")?.getBoundingClientRect(),
              page = document.querySelector(".qa-history")?.getBoundingClientRect();
            if (!heading || !filters || !panel || !page) throw new Error("History regions missing");
            return {
              headingGap: filters.top - heading.bottom,
              tableGap: panel.top - filters.bottom,
              height: page.height,
            };
          }, null);
          expect(flow.headingGap).toBeLessThanOrEqual(24);
          expect(flow.tableGap).toBeLessThanOrEqual(24);
          expect(flow.height).toBeLessThan(700);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
