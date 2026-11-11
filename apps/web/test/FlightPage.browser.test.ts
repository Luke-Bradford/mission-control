// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { item, NOW, REPOS } from "./fixtures.ts";
import { flightPageApi, type PageState } from "./flightPageFixtures.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports for the page review. */
const SIZES = [
  [1920, 940],
  [2560, 1200],
] as const;
const STATES: PageState[] = ["stopped", "running", "blocked"];

describeRendered("FLIGHT page in a browser", () => {
  it(
    "moves an older decision from the main page into Records at its deep link",
    async () => {
      const api = { ...flightPageApi("blocked"), "/api/repos": REPOS };
      const main = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1280,
        height: 800,
        search: `?dock=folded&at=${encodeURIComponent("/flight")}`,
        api,
      });
      await main.box("#decisions li");
      expect(await main.evaluate(() => document.getElementById("decision-30") !== null, null)).toBe(
        false,
      );
      await main.close();
      const records = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1280,
        height: 800,
        search: `?dock=folded&at=${encodeURIComponent("/flight#decision-30")}`,
        api,
      });
      await records.box("#decision-30");
      expect(
        await records.evaluate(() => document.getElementById("decision-30") !== null, null),
      ).toBe(true);
      await records.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  for (const [width, height] of [
    [1280, 800],
    [1600, 1000],
  ] as const) {
    for (const theme of ["dark", "light"] as const) {
      const where = `${width}x${height}, ${theme}, Records`;
      it(
        `opens Records with a visible return action at ${where}`,
        async () => {
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            search: `?dock=folded&at=${encodeURIComponent("/flight#handlingP")}`,
            colorScheme: theme,
            api: {
              ...flightPageApi("blocked"),
              "/api/repos": REPOS,
              "/api/prs/flow": { generatedAt: 0, repos: [] },
              "/api/notifications": { open: [], handledToday: [] },
              "/api/attention/held": [],
            },
          });
          await page.box("#handlingP");
          expect(page.errors()).toEqual([]);
          const record = await page.evaluate(() => {
            const doc = document.documentElement;
            const title = document.querySelector(".flight-records-title")?.getBoundingClientRect();
            const back = document.querySelector<HTMLAnchorElement>(".flight-records-title a");
            const panel = document.getElementById("handlingP")?.getBoundingClientRect();
            return {
              sideScroll: doc.scrollWidth - doc.clientWidth,
              title: title ? { width: title.width, height: title.height } : null,
              back: back ? { text: back.textContent, href: back.getAttribute("href") } : null,
              panel: panel ? { width: panel.width, height: panel.height } : null,
            };
          }, null);
          const shots = process.env.MC_FLIGHT_RECORDS_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `flight-records-${width}x${height}-${theme}.png`));
          }
          expect(record.sideScroll, `${where}: no sideways scroll`).toBeLessThanOrEqual(0);
          expect(record.title, `${where}: Records heading is visible`).not.toBeNull();
          expect(record.title?.height).toBeGreaterThanOrEqual(24);
          expect(record.back).toEqual({ text: "Back to FLIGHT", href: "/flight" });
          expect(record.panel, `${where}: selected record panel is visible`).not.toBeNull();
          expect(record.panel?.width).toBeGreaterThan(240);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  for (const [width, height] of [
    [1280, 900],
    [1600, 1000],
  ] as const) {
    for (const theme of ["dark", "light"] as const) {
      it(
        `shows the Watch list at ${width}x${height} in ${theme}`,
        async () => {
          const page = await renderAt({
            page: "test/flightBrowser.html",
            width,
            height,
            search: `?view=page&theme=${theme}`,
            colorScheme: theme,
            api: flightPageApi("running", {
              "/api/attention/held": [
                item({
                  key: "hold:watch",
                  text: "Wait for CI to finish before the next release.",
                  hold: {
                    reason: "CI is still running",
                    condition: { kind: "manual" },
                    by: "flight-1",
                    at: NOW,
                  },
                }),
              ],
            }),
          });
          await page.box("#heldWatchP [data-testid=held-row]");
          expect(page.errors()).toEqual([]);
          expect(await page.reachable("#heldWatchP")).toEqual([true]);
          expect(await page.reachable("#heldWatchP [data-testid=held-row]", "#heldWatchP")).toEqual(
            [true],
          );
          const text = await page.evaluate(
            () => document.getElementById("heldWatchP")?.textContent ?? "",
            null,
          );
          expect(text).toContain("Watch list");
          expect(text).toContain("Wait for CI to finish before the next release.");
          expect(text).toContain("Release");
          const shots = process.env.MC_FLIGHT_PAGE_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `flight-watch-${width}x${height}-${theme}.png`));
          }
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

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
            expect(page.errors()).toEqual([]);
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
          expect(page.errors()).toEqual([]);
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
              act: (() => {
                const a = document.querySelector<HTMLElement>("#blockers .fp-brow .fp-act");
                return {
                  wrap: a ? getComputedStyle(a).whiteSpace : "",
                  height: a?.clientHeight ?? 0,
                  hidden: a ? a.scrollHeight - a.clientHeight : 0,
                };
              })(),
              owners: [...document.querySelectorAll<HTMLElement>("#blockers .fp-owner")].map(
                (o) => ({ text: o.textContent ?? "", cut: o.scrollWidth - o.clientWidth }),
              ),
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
          // The longest action wraps to two lines and is cut with an ellipsis, not run off one line.
          expect(r.act.wrap, `${where}: the action wraps`).toBe("normal");
          expect(r.act.height, `${where}: closed action is two lines`).toBeGreaterThan(30);
          expect(r.act.height, `${where}: closed action is two lines`).toBeLessThanOrEqual(44);
          expect(r.act.hidden, `${where}: the long action is truncated`).toBeGreaterThan(0);
          // Opening the first row from the keyboard shows the whole text.
          await page.evaluate(
            () => document.querySelector<HTMLElement>("#blockers .fp-brow")?.focus(),
            null,
          );
          await page.press("Enter");
          const open = await page.evaluate(() => {
            const row = document.querySelector<HTMLElement>("#blockers .fp-brow");
            const a = row?.querySelector<HTMLElement>(".fp-act");
            return {
              expanded: row?.getAttribute("aria-expanded"),
              height: a?.clientHeight ?? 0,
              hidden: a ? a.scrollHeight - a.clientHeight : 1,
            };
          }, null);
          expect(open.expanded, `${where}: Enter opens the row`).toBe("true");
          expect(open.hidden, `${where}: the opened action is whole`).toBeLessThanOrEqual(1);
          expect(open.height, `${where}: the opened action is taller`).toBeGreaterThan(44);
          expect(r.owners.length).toBe(16);
          for (const o of r.owners) {
            expect(o.cut, `${where}: the owner tag "${o.text}" is cut`).toBeLessThanOrEqual(0);
          }
          expect(r.owners.map((o) => o.text)).toContain("#1572");
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

  // The real application shell: header, footer, and the page where an operator reaches it. The
  // FLIGHT page is a full-width page, so no FLIGHT rail sits beside it; this is the widths and
  // heights the checklist names, with 16 long blockers.
  const SHELL_SIZES = [
    [1280, 800],
    [1600, 1000],
    [1600, 700],
    [1920, 940],
    [2560, 1200],
  ] as const;
  for (const [width, height] of SHELL_SIZES) {
    for (const theme of ["dark", "light"] as const) {
      const where = `${width}x${height}, busy, ${theme}, real shell`;
      it(
        `keeps the hierarchy, readable columns and reachable lists in the app shell at ${where}`,
        async () => {
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            search: `?dock=folded&at=${encodeURIComponent("/flight")}`,
            colorScheme: theme,
            api: {
              ...flightPageApi("busy"),
              "/api/repos": REPOS,
              "/api/crew?shape=summary": { rows: [], firstRunToday: null },
              "/api/prs/flow": { generatedAt: 0, repos: [] },
              "/api/notifications": { open: [], handledToday: [] },
              "/api/attention/held": [],
            },
          });
          await page.box("#page-flight #blockers .fp-brow");
          expect(page.errors()).toEqual([]);
          const r = await page.evaluate(() => {
            const doc = document.documentElement;
            const box = (sel: string) =>
              document.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
            const scroller = document.querySelector<HTMLElement>(".fp-brows");
            const edge = scroller?.getBoundingClientRect() ?? new DOMRect();
            const rows = [...document.querySelectorAll<HTMLElement>("#blockers .fp-brow")];
            const whole = rows.filter((row) => {
              const b = row.getBoundingClientRect();
              return b.top >= edge.top - 1 && b.bottom <= edge.bottom + 1;
            });
            const first = rows[0];
            return {
              pageScroll: doc.scrollHeight - doc.clientHeight,
              sideScroll: doc.scrollWidth - doc.clientWidth,
              dock: document.querySelectorAll(".dock").length,
              bandBottom: box(".fp-band")?.bottom ?? 0,
              midTop: box(".fp-mid")?.top ?? 0,
              decTop: box("#decisionsP")?.top ?? 0,
              whole: whole.length,
              total: rows.length,
              more: document.querySelector(".fp-more")?.textContent ?? "",
              columns: ["fp-what", "fp-act"].map(
                (c) =>
                  first?.querySelector<HTMLElement>(`.${c}`)?.getBoundingClientRect().width ?? 0,
              ),
              owners: [...document.querySelectorAll<HTMLElement>("#blockers .fp-owner")].map(
                (o) => o.scrollWidth - o.clientWidth,
              ),
              decisions: document.querySelectorAll("#decisions li").length,
              panels: [...document.querySelectorAll<HTMLElement>("main .fp-panel")].map(
                (p) => p.scrollHeight > p.clientHeight + 1,
              ),
            };
          }, null);
          const shots = process.env.MC_FLIGHT_PAGE_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(
              join(shots, `flight-page-shell-${width}x${height}-busy-${theme}.png`),
            );
          }
          expect(r.dock, `${where}: no rail beside the page`).toBe(0);
          expect(r.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
          expect(r.sideScroll, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
          // Hierarchy: status band, then Doing now and Blockers, then Recent decisions, in that order.
          expect(
            r.midTop,
            `${where}: Doing now and Blockers sit under the status band`,
          ).toBeGreaterThanOrEqual(r.bandBottom);
          expect(r.decTop, `${where}: Recent decisions sits under them`).toBeGreaterThan(r.midTop);
          // Blockers: some rows wholly in view, the rest counted, columns wide enough to read.
          expect(r.total).toBe(16);
          expect(r.whole, `${where}: blocker rows in view`).toBeGreaterThanOrEqual(2);
          expect(r.more, `${where}: the hidden count`).toMatch(
            new RegExp(`^${r.total - r.whole} more below`),
          );
          for (const w of r.columns)
            expect(w, `${where}: blocker and action columns are readable`).toBeGreaterThanOrEqual(
              120,
            );
          for (const cut of r.owners)
            expect(cut, `${where}: an owner tag is cut`).toBeLessThanOrEqual(0);
          expect(r.decisions, `${where}: Recent decisions keeps its rows`).toBeGreaterThanOrEqual(
            3,
          );
          for (const clipped of r.panels)
            expect(clipped, `${where}: a panel hides content`).toBe(false);
          // Reach: Tab reaches the first row, and the keyboard opens it to the whole action.
          await page.evaluate(
            () => document.querySelector<HTMLElement>("#blockers .fp-brow")?.focus(),
            null,
          );
          await page.press("Enter");
          const open = await page.evaluate(() => {
            const a = document.querySelector<HTMLElement>("#blockers .fp-brow .fp-act");
            return a ? a.scrollHeight - a.clientHeight : 1;
          }, null);
          expect(open, `${where}: the opened action is whole`).toBeLessThanOrEqual(1);
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }
});
