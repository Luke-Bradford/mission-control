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
      for (const variant of ["", "&plan=empty", "&state=running"]) {
        const where = `${width}x${height}${rail ? " FLIGHT open" : " FLIGHT folded"}${variant ? `, ${variant.slice(1).replace("=", " ")}` : ""}`;
        it(
          `answers the seat on one screen at ${where}`,
          async () => {
            const page = await renderAt({
              page: "test/agentsMockupBrowser.html",
              width,
              height,
              search: `?x=1${rail}${variant}`,
            });
            const r = await page.evaluate(async () => {
              // The current plan step is scrolled into view after the first layout.
              await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
              const inView = (sel: string) => {
                const list = document.querySelector<HTMLElement>(sel);
                const now = list?.querySelector<HTMLElement>(".think");
                if (!list || !now || list.offsetParent === null) return null;
                const a = list.getBoundingClientRect();
                const b = now.getBoundingClientRect();
                return b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5;
              };
              const visible = (el: Element) => el.getClientRects().length > 0;
              const small = () =>
                [...document.querySelectorAll<HTMLElement>("a, button, select, input, summary")]
                  .filter((el) => visible(el) && !el.closest("[hidden]"))
                  .filter((el) => {
                    const b = el.getBoundingClientRect();
                    return b.width < 24 || b.height < 24;
                  })
                  .map(
                    (el) =>
                      `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`,
                  );
              const smallTargets = new Set(small());
              const composerButtons = [...document.querySelectorAll(".composer button")].map(
                (b) => b.textContent ?? "",
              );
              const changeVisible = [...document.querySelectorAll(".focusrow button")].some(
                (b) => visible(b) && b.textContent === "Change",
              );
              const upVisible = [...document.querySelectorAll(".qi button")].some(visible);
              const toolRows = document.querySelectorAll(".ev.tool").length;
              const toolSummaries = document.querySelectorAll(".ev.tool summary").length;
              const toolExtraStops = document.querySelectorAll('.ev.tool [tabindex="0"]').length;
              const toolOpen = document.querySelectorAll(".ev.tool details[open] pre").length;
              const stackNow = inView("#stackPlan");
              const tabNow = inView('.tabbody[data-panel="plan"]');
              const stateText = [
                document.querySelector(".ident")?.textContent ?? "",
                document.querySelector<HTMLSelectElement>("#seat")?.selectedOptions[0]
                  ?.textContent ?? "",
                document.querySelector<HTMLInputElement>(".composer input")?.placeholder ?? "",
              ].join("\n");
              const interrupt = [...document.querySelectorAll(".acts button")].some(
                (b) => b.textContent === "Interrupt",
              );
              const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
              const act = rect("#activity");
              const right = rect(".right > .tabs");
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
                for (const x of small()) smallTargets.add(x);
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
              // One row means every child sits on the same centre line; a shorter caption has a different top.
              const rows = loop
                ? new Set(
                    [...loop.children].map((c) => {
                      const b = c.getBoundingClientRect();
                      return Math.round((b.top + b.bottom) / 2 / 4);
                    }),
                  ).size
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
                stackNow,
                smallTargets: [...smallTargets],
                composerButtons,
                changeVisible,
                upVisible,
                toolRows,
                toolSummaries,
                toolExtraStops,
                toolOpen,
                blocking: /5 blocking/.test(document.querySelector(".ident")?.textContent ?? ""),
                filesDiff: document.querySelector('.tabbody[data-panel="files"] .diff') !== null,
                fileCommit:
                  document.querySelector('.tabbody[data-panel="files"] .tr.f')?.textContent ?? "",
                promptLink: /Open prompt/.test(
                  document.querySelector('.tabbody[data-panel="context"]')?.textContent ?? "",
                ),
                tabNow,
                stateWords: stateText.match(/\b(parked|running)\b/gi) ?? [],
                interrupt,
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
            const running = variant === "&state=running";
            expect(r.stateWords, `${where}: the state shows once on the first screen`).toEqual([
              running ? "Running" : "Parked",
            ]);
            expect(r.interrupt, `${where}: Interrupt shows only while running`).toBe(running);
            if (variant !== "&plan=empty") {
              expect(
                r.stackNow ?? r.tabNow,
                `${where}: the current plan step is in view when the page opens`,
              ).toBe(true);
            }
            expect(r.smallTargets, `${where}: controls are at least 24 px each way`).toEqual([]);
            expect(r.composerButtons, `${where}: composer actions`).toContain(
              running ? "Interrupt and send" : "Send rework message",
            );
            expect(
              r.blocking,
              `${where}: the blocking-findings count is on the identity strip`,
            ).toBe(true);
            if (variant !== "&plan=empty" || width >= 2200) {
              expect(r.changeVisible, `${where}: Focus has a Change control`).toBe(true);
              expect(r.upVisible, `${where}: a queued row can ask FLIGHT to move up`).toBe(true);
            }
            expect(r.toolSummaries, `${where}: each tool row is one disclosure`).toBe(r.toolRows);
            expect(r.toolExtraStops, `${where}: a tool row has one keyboard stop`).toBe(0);
            expect(r.toolOpen, `${where}: one tool row is drawn open`).toBeGreaterThan(0);
            expect(r.filesDiff, `${where}: a file diff is drawn open`).toBe(true);
            expect(r.fileCommit, `${where}: files keep the commit column`).toMatch(
              /117f67b|uncommitted/,
            );
            expect(r.promptLink, `${where}: Context links to the prompt`).toBe(true);
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
          // Page focus is not guaranteed in a headless window, so send the event the tip listens to.
          el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
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
