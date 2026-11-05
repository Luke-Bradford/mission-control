// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports (dashboard-layout.md), each with FLIGHT folded and open. */
const SIZES = [
  [1920, 940],
  [2560, 1145],
  [2560, 1250],
] as const;
const RAIL = ["", "&flight=1"] as const;
/** The ticket's limit for an empty region inside a panel. */
const HOLE_MAX = 200;

describeRendered("Agents mockup in a browser", () => {
  for (const [width, height] of SIZES) {
    for (const rail of RAIL) {
      for (const plan of ["", "&plan=empty"]) {
        const where = `${width}x${height}${rail ? " FLIGHT open" : " FLIGHT folded"}${plan ? ", no plan" : ""}`;
        it(
          `answers the seat on one screen at ${where}`,
          async () => {
            const page = await renderAt({
              page: "test/agentsMockupBrowser.html",
              width,
              height,
              search: `?x=1${rail}${plan}`,
            });
            const r = await page.evaluate(() => {
              const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
              const act = rect("#activity");
              const right = rect(".right");
              const doc = document.documentElement;
              const panels = [...document.querySelectorAll<HTMLElement>(".cols .panel")]
                .filter((el) => el.id !== "activity" && el.offsetParent !== null)
                .map((el) => el.getBoundingClientRect().height);
              const title = rect(".r2 .title");
              const loop = document.querySelector<HTMLElement>(".loop");
              const gaps: { tab: string; gap: number }[] = [];
              for (const b of document.querySelectorAll<HTMLElement>(".tabbar button")) {
                if (b.offsetParent === null) continue;
                b.click();
                const body = document.querySelector<HTMLElement>(
                  `.tabbody[data-panel="${b.dataset.tab}"]`,
                );
                const last = body?.lastElementChild?.getBoundingClientRect();
                if (!body || !last) continue;
                const room = body.getBoundingClientRect().bottom - last.bottom;
                gaps.push({
                  tab: b.dataset.tab ?? "",
                  gap: body.scrollHeight > body.clientHeight + 1 ? 0 : room,
                });
              }
              const stack = document.querySelector<HTMLElement>("#stack");
              let stackGap: number | null = null;
              if (stack && stack.offsetParent !== null) {
                const lastEl = stack.querySelector<HTMLElement>(".stackqueue")?.lastElementChild;
                const plan = stack.querySelector<HTMLElement>("#stackPlan");
                const bottom = stack.getBoundingClientRect().bottom;
                const queue = stack.querySelector<HTMLElement>(".stackqueue");
                const planRoom =
                  plan && !plan.hidden && plan.lastElementChild
                    ? plan.scrollHeight > plan.clientHeight + 1
                      ? 0
                      : plan.getBoundingClientRect().bottom -
                        plan.lastElementChild.getBoundingClientRect().bottom
                    : 0;
                stackGap = Math.max(
                  planRoom,
                  lastEl && queue ? bottom - lastEl.getBoundingClientRect().bottom - 8 : 0,
                );
              }
              const rows = loop
                ? new Set([...loop.children].map((c) => Math.round(c.getBoundingClientRect().top)))
                    .size
                : 0;
              const cutNotFocusable = [...document.querySelectorAll<HTMLElement>("[data-full]")]
                .filter((el) => el.offsetParent !== null && el.tabIndex < 0)
                .map((el) => el.textContent?.slice(0, 40) ?? "");
              return {
                pageScroll: doc.scrollHeight - doc.clientHeight,
                sideScroll: doc.scrollWidth - doc.clientWidth,
                activity: {
                  top: act?.top ?? 0,
                  bottom: act?.bottom ?? 0,
                  height: act?.height ?? 0,
                },
                rightBottom: right?.bottom ?? 0,
                tallestOther: Math.max(0, ...panels),
                title: title?.width ?? 0,
                titleRight: title?.right ?? 0,
                actsLeft: rect(".acts")?.left ?? 0,
                loopHeight: loop?.getBoundingClientRect().height ?? 0,
                loopRows: rows,
                gaps,
                stackGap,
                cutNotFocusable,
              };
            }, null);
            expect(r.pageScroll, `${where}: page scroll`).toBeLessThanOrEqual(0);
            expect(r.sideScroll, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
            expect(r.activity.height, `${where}: Activity is the tallest panel`).toBeGreaterThan(
              r.tallestOther,
            );
            expect(
              Math.abs(r.activity.bottom - r.rightBottom),
              `${where}: columns end level`,
            ).toBeLessThanOrEqual(1);
            expect(r.title, `${where}: the ticket title keeps its width`).toBeGreaterThanOrEqual(
              320,
            );
            expect(r.titleRight, `${where}: the title ends before the actions`).toBeLessThanOrEqual(
              r.actsLeft,
            );
            expect(r.loopRows, `${where}: the loop is one row`).toBe(1);
            expect(r.loopHeight, `${where}: the loop line is compact`).toBeLessThanOrEqual(48);
            for (const g of r.gaps) {
              expect(g.gap, `${where}: ${g.tab} tab leaves an empty area`).toBeLessThanOrEqual(
                HOLE_MAX,
              );
            }
            if (r.stackGap !== null) {
              expect(r.stackGap, `${where}: Plan panel leaves an empty area`).toBeLessThanOrEqual(
                HOLE_MAX,
              );
            }
            expect(r.cutNotFocusable, `${where}: cut text must take focus`).toEqual([]);
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }

  it(
    "shows the full text of cut text on keyboard focus",
    async () => {
      const page = await renderAt({
        page: "test/agentsMockupBrowser.html",
        width: 1920,
        height: 940,
        search: "?flight=1",
      });
      const shown = await page.evaluate(() => {
        const out: { want: string; got: string }[] = [];
        for (const sel of [".r2 .title", ".tg", ".next .cut", ".loop .step"]) {
          const el = document.querySelector<HTMLElement>(sel);
          if (!el) {
            out.push({ want: sel, got: "missing" });
            continue;
          }
          el.focus();
          out.push({
            want: el.dataset.full ?? "",
            got: document.querySelector<HTMLElement>("#tip")?.textContent ?? "",
          });
        }
        return out;
      }, null);
      for (const s of shown) expect(s.got).toBe(s.want);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
