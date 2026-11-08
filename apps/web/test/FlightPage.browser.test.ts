// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { flightPageApi, type PageState } from "./flightPageFixtures.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports for the page review. */
const SIZES = [
  [1920, 940],
  [2560, 1200],
] as const;
const STATES: PageState[] = ["stopped", "running", "blocked"];

describeRendered("FLIGHT page in a browser", () => {
  for (const [width, height] of SIZES) {
    for (const state of STATES) {
      for (const theme of ["dark", "light"] as const) {
        const where = `${width}x${height}, ${state}, ${theme}`;
        it(
          `answers working, doing now and blocked on one screen at ${where}`,
          async () => {
            const page = await renderAt({
              page: "test/flightBrowser.html",
              width,
              height,
              search: `?view=page&theme=${theme}`,
              colorScheme: theme,
              api: flightPageApi(state),
            });
            await page.box("#decisions li");
            const r = await page.evaluate(() => {
              const doc = document.documentElement;
              const visible = (el: Element) => el.getClientRects().length > 0;
              const panels = [...document.querySelectorAll<HTMLElement>("main .fp-panel")].map(
                (p) => {
                  const b = p.getBoundingClientRect();
                  const last = p.lastElementChild?.getBoundingClientRect();
                  return {
                    id: p.id,
                    bottom: b.bottom,
                    clipped: p.scrollHeight > p.clientHeight + 1,
                    scroll: `${p.scrollHeight} of ${p.clientHeight}`,
                    lastBottom: last?.bottom ?? 0,
                  };
                },
              );
              const list = document.getElementById("decisions") as HTMLElement;
              const rows = [...list.children];
              const lastRow = rows.at(-1)?.getBoundingClientRect();
              const small = [...document.querySelectorAll<HTMLElement>("a, button, select, input")]
                .filter(visible)
                .filter((el) => {
                  const b = el.getBoundingClientRect();
                  return b.width < 24 || b.height < 24;
                })
                .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim()}"`);
              const tiny = [...document.querySelectorAll<HTMLElement>("main *")]
                .filter((el) => visible(el))
                .filter((el) =>
                  [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()),
                )
                .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11)
                .map((el) => el.textContent?.slice(0, 30) ?? "");
              const text = (sel: string) => document.querySelector(sel)?.textContent ?? "";
              return {
                pageScroll: doc.scrollHeight - doc.clientHeight,
                sideScroll: doc.scrollWidth - doc.clientWidth,
                panels,
                small,
                tiny,
                labels: [...document.querySelectorAll(".fp-k")].map((e) => e.textContent),
                doing: document.querySelectorAll("#doing li").length,
                blockerRows: document.querySelectorAll("#blockers .fp-brow").length,
                blockers: text("#blockers"),
                decisions: rows.length,
                decSub: text("#decH .fp-sub"),
                decGap: list.getBoundingClientRect().bottom - (lastRow?.bottom ?? 0),
                decRowH: lastRow?.height ?? 0,
                decTop:
                  (rows[0]?.getBoundingClientRect().top ?? 0) - list.getBoundingClientRect().top,
                tables: document.querySelectorAll("main table").length,
                board: document
                  .querySelector<HTMLAnchorElement>("a.fp-board")
                  ?.getAttribute("href"),
                status: text(".fp-band"),
                theme: doc.dataset.theme,
              };
            }, null);
            // Set MC_FLIGHT_PAGE_SHOTS to a folder to keep a PNG of each size, state and theme.
            const shots = process.env.MC_FLIGHT_PAGE_SHOTS;
            if (shots) {
              mkdirSync(shots, { recursive: true });
              await page.screenshot(
                join(shots, `flight-page-${width}x${height}-${state}-${theme}.png`),
              );
            }
            expect(r.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
            expect(r.sideScroll, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
            for (const p of r.panels) {
              expect(
                p.clipped,
                `${where}: ${p.id} hides content (scrollHeight of clientHeight: ${p.scroll})`,
              ).toBe(false);
              expect(p.lastBottom, `${where}: ${p.id} last row inside`).toBeLessThanOrEqual(
                p.bottom + 1,
              );
            }
            expect(r.small, `${where}: controls are 24 px each way`).toEqual([]);
            expect(r.tiny, `${where}: no text under 11 px`).toEqual([]);
            expect(r.labels).toEqual([
              "FLIGHT",
              "Cost per hour",
              "Sessions per hour",
              "Context size",
            ]);
            expect(r.tables, `${where}: no PR flow table`).toBe(0);
            expect(r.board).toBe("/board");
            expect(r.theme).toBe(theme);
            expect(r.doing, `${where}: Doing now has 1 to 5 lines`).toBeGreaterThan(0);
            expect(r.doing).toBeLessThanOrEqual(5);
            expect(r.decisions).toBeGreaterThanOrEqual(width >= 2560 ? 12 : 8);
            expect(r.decSub).toBe(`last ${r.decisions} · newest first`);
            expect(r.decTop, `${where}: rows start at the top`).toBe(0);
            expect(r.decGap, `${where}: blank under decisions`).toBeLessThan(r.decRowH);
            expect(r.status).toMatch(state === "stopped" ? /Stopped/ : /Running/);
            if (state === "blocked") expect(r.blockerRows).toBe(3);
            else if (state === "running") expect(r.blockers).toMatch(/Nothing is blocking FLIGHT/);
            else expect(r.blockerRows).toBe(1);
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }

  // Sixteen blockers with long text: the first screen still answers what blocks FLIGHT.
  for (const [width, height] of SIZES) {
    for (const theme of ["dark", "light"] as const) {
      const where = `${width}x${height}, busy, ${theme}`;
      it(
        `shows several blockers and says how many are below with 16 of them at ${where}`,
        async () => {
          const page = await renderAt({
            page: "test/flightBrowser.html",
            width,
            height,
            search: `?view=page&theme=${theme}`,
            colorScheme: theme,
            api: flightPageApi("busy"),
          });
          await page.box("#blockers .fp-brow");
          const r = await page.evaluate(() => {
            const doc = document.documentElement;
            const scroller = document.querySelector<HTMLElement>(".fp-brows");
            const edge = scroller?.getBoundingClientRect() ?? new DOMRect();
            const rows = [...document.querySelectorAll<HTMLElement>("#blockers .fp-brow")];
            const whole = rows.filter((row) => {
              const b = row.getBoundingClientRect();
              return b.top >= edge.top - 1 && b.bottom <= edge.bottom + 1;
            });
            return {
              pageScroll: doc.scrollHeight - doc.clientHeight,
              sideScroll: doc.scrollWidth - doc.clientWidth,
              total: rows.length,
              whole: whole.length,
              rowHeight: whole[0]?.getBoundingClientRect().height ?? 0,
              more: document.querySelector(".fp-more")?.textContent ?? "",
              decisions: document.querySelectorAll("#decisions li").length,
              panels: [...document.querySelectorAll<HTMLElement>("main .fp-panel")].map((p) => ({
                id: p.id,
                clipped: p.scrollHeight > p.clientHeight + 1,
              })),
            };
          }, null);
          const shots = process.env.MC_FLIGHT_PAGE_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `flight-page-${width}x${height}-busy-${theme}.png`));
          }
          expect(r.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
          expect(r.sideScroll, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
          expect(r.total).toBe(16);
          expect(r.whole, `${where}: blocker rows wholly in view`).toBeGreaterThanOrEqual(6);
          expect(r.rowHeight, `${where}: compact rows`).toBeLessThanOrEqual(64);
          expect(r.more, `${where}: the hidden count`).toMatch(
            new RegExp(`^${r.total - r.whole} more below`),
          );
          expect(r.decisions, `${where}: Recent decisions keeps its rows`).toBeGreaterThanOrEqual(
            3,
          );
          for (const p of r.panels)
            expect(p.clipped, `${where}: ${p.id} hides content`).toBe(false);
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }
});
