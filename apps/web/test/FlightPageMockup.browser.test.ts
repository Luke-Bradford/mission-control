// @vitest-environment node

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports for the page review. */
const SIZES = [
  [1920, 940],
  [2560, 1200],
] as const;
const STATES = ["stopped", "running", "blocked"] as const;

describeRendered("FLIGHT page mockup in a browser", () => {
  for (const [width, height] of SIZES) {
    for (const state of STATES) {
      for (const theme of ["dark", "light"]) {
        const where = `${width}x${height}, ${state}, ${theme}`;
        it(
          `answers working, doing now and blocked on one screen at ${where}`,
          async () => {
            const page = await renderAt({
              page: "test/flightPageMockupBrowser.html",
              width,
              height,
              search: `?state=${state}&theme=${theme}`,
            });
            const r = await page.evaluate(() => {
              const doc = document.documentElement;
              const visible = (el: Element) => el.getClientRects().length > 0;
              const text = (sel: string) => document.querySelector(sel)?.textContent ?? "";
              // Hidden rows stay in the DOM, so only visible rows count as shown.
              const decRows = [...document.querySelectorAll<HTMLElement>("#decisions li")].filter(
                visible,
              );
              const decList = (
                document.getElementById("decisions") as HTMLElement
              ).getBoundingClientRect();
              const lastDec = decRows.at(-1)?.getBoundingClientRect();
              const panels = [...document.querySelectorAll<HTMLElement>("main .panel")].map((p) => {
                const b = p.getBoundingClientRect();
                const last = p.lastElementChild?.getBoundingClientRect();
                return {
                  id: p.id,
                  bottom: b.bottom,
                  clipped: p.scrollHeight > p.clientHeight + 1,
                  lastBottom: last?.bottom ?? 0,
                };
              });
              const small = [...document.querySelectorAll<HTMLElement>("a, button, select, input")]
                .filter(visible)
                .filter((el) => {
                  const b = el.getBoundingClientRect();
                  return b.width < 24 || b.height < 24;
                })
                .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim()}"`);
              const tiny = [...document.querySelectorAll<HTMLElement>("main *")]
                .filter((el) => visible(el) && el.childNodes.length > 0)
                .filter((el) =>
                  [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()),
                )
                .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 11)
                .map((el) => el.textContent?.slice(0, 30) ?? "");
              const cells = [...document.querySelectorAll<HTMLElement>(".stat")].map((s) => ({
                label: s.querySelector(".k")?.textContent ?? "",
                value: s.querySelector(".v")?.textContent ?? "",
                note: s.querySelector(".d")?.textContent ?? "",
              }));
              const rows = [...document.querySelectorAll<HTMLElement>("#blockers .brow")].map(
                (r) => ({
                  owner: r.querySelector(".owner")?.textContent ?? "",
                  wait: r.querySelector(".wait")?.textContent ?? "",
                  action: r.querySelector(".act")?.textContent ?? "",
                }),
              );
              return {
                listScroll: [...document.querySelectorAll<HTMLElement>(".lines")].some(
                  (l) => l.scrollHeight > l.clientHeight + 1,
                ),
                pageScroll: doc.scrollHeight - doc.clientHeight,
                sideScroll: doc.scrollWidth - doc.clientWidth,
                viewport: doc.clientHeight,
                panels,
                small,
                tiny,
                cells,
                rows,
                doing: document.querySelectorAll("#doing li").length,
                decisions: decRows.length,
                decTotal: document.querySelectorAll("#decisions li").length,
                decSub: text("#decSub"),
                decGap: decList.bottom - (lastDec?.bottom ?? decList.bottom),
                decRowH: lastDec?.height ?? 0,
                status: text("#status"),
                startVisible: [...document.querySelectorAll("button")].some(
                  (b) => visible(b) && b.textContent === "Start FLIGHT",
                ),
                switchPressed: [
                  ...document.querySelectorAll<HTMLElement>(".switch [aria-pressed=true]"),
                ].map((b) => b.dataset.state),
                emptyBlockers: text("#blockers"),
                tables: document.querySelectorAll("main table").length,
                boardLink: document.querySelector<HTMLAnchorElement>("a.board")?.textContent ?? "",
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
            expect(r.listScroll, `${where}: a list needs its own scroll`).toBe(false);
            for (const p of r.panels) {
              expect(p.clipped, `${where}: ${p.id} hides content`).toBe(false);
              expect(p.lastBottom, `${where}: ${p.id} last row inside`).toBeLessThanOrEqual(
                p.bottom + 1,
              );
            }
            expect(r.small, `${where}: controls are 24 px each way`).toEqual([]);
            expect(r.tiny, `${where}: no text under 11 px`).toEqual([]);
            expect(r.cells.map((c) => c.label)).toEqual([
              "FLIGHT",
              "Cost per hour",
              "Sessions per hour",
              "Context size",
            ]);
            for (const c of r.cells)
              expect(c.note.length, `${where}: ${c.label} defined`).toBeGreaterThan(8);
            expect(r.switchPressed).toEqual([state]);
            expect(r.theme).toBe(theme);
            expect(r.tables, `${where}: no PR flow table`).toBe(0);
            expect(r.boardLink).toMatch(/Board/);
            expect(r.doing, `${where}: Doing now has 1 to 5 lines`).toBeGreaterThan(0);
            expect(r.doing).toBeLessThanOrEqual(5);
            expect(r.decisions).toBeGreaterThanOrEqual(width >= 2560 ? 12 : 8);
            expect(r.decSub, `${where}: the heading counts the shown decisions`).toBe(
              `last ${r.decisions} · newest first`,
            );
            if (r.decisions < r.decTotal) {
              expect(r.decGap, `${where}: blank under decisions`).toBeLessThan(r.decRowH);
            }
            expect(r.startVisible, `${where}: Start FLIGHT only when stopped`).toBe(
              state === "stopped",
            );
            expect(r.status).toMatch(state === "stopped" ? /Stopped/ : /Running/);
            if (state === "blocked") {
              expect(r.rows).toHaveLength(3);
              for (const row of r.rows) {
                expect(row.owner.length).toBeGreaterThan(0);
                expect(row.wait).toMatch(/\d/);
                expect(row.action.length).toBeGreaterThan(8);
              }
            } else if (state === "running") {
              expect(r.rows).toHaveLength(0);
              expect(r.emptyBlockers).toMatch(/Nothing is blocking FLIGHT/);
            } else {
              expect(r.rows).toHaveLength(1);
              expect(r.rows[0]?.owner).toMatch(/Operator/);
            }
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }

  it(
    "switches state from the page without a reload",
    async () => {
      const page = await renderAt({
        page: "test/flightPageMockupBrowser.html",
        width: 1920,
        height: 940,
        search: "?state=running",
      });
      await page.click('.switch [data-state="blocked"]');
      const n = await page.evaluate(
        () => document.querySelectorAll("#blockers .brow").length,
        null,
      );
      expect(n).toBe(3);
      await page.click('.switch [data-state="stopped"]');
      const start = await page.evaluate(
        () =>
          [...document.querySelectorAll("button")].some((b) => b.textContent === "Start FLIGHT"),
        null,
      );
      expect(start).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});

it("README names what moved off the page and each number's source", () => {
  const readme = readFileSync(
    join(import.meta.dirname, "../mockups/flight-page/README.md"),
    "utf8",
  );
  expect(readme).toMatch(/PR flow/);
  expect(readme).toMatch(/Board/);
  for (const k of ["Cost per hour", "Sessions per hour", "Context size", "FLIGHT status"]) {
    expect(readme, k).toContain(k);
  }
});
