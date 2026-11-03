// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { type OverviewScenario, overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
async function settled(page: RenderedPage, scenario: OverviewScenario) {
  try {
    await page.evaluate(async (scenario) => {
      const deadline = performance.now() + 5000;
      const ready = () => {
        const view = document.querySelector("#page-overview");
        if (!view) return false;
        const text = view.textContent ?? "";
        if (scenario === "loading") return text.includes("Loading current work");
        if (scenario === "error")
          return text.includes("Refresh failed") && text.includes("could not load");
        if (scenario === "empty")
          return (
            text.includes("No crew seats are configured") &&
            text.includes("Nothing is waiting for your decision")
          );
        return (
          text.includes("41.2k") &&
          ((view.querySelector("#quotaSummaryP")?.textContent?.includes("37% left") &&
            view.querySelector("#quotaSummaryP")?.textContent?.includes("88% left")) ||
            ["41%", "63%", "12%"].every((value) =>
              view.querySelector("#quotaP")?.textContent?.includes(value),
            )) &&
          (scenario === "one" || !!view.querySelector(".overview-instant"))
        );
      };
      while (!ready() && performance.now() < deadline)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!ready()) throw Error(`Overview ${scenario} fixture did not settle`);
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, scenario);
  } catch (error) {
    await capture(page, `unsettled-${scenario}`);
    const facts = await page.evaluate(
      () => ({
        text: document.querySelector("#page-overview")?.textContent,
        ticks: document.querySelectorAll(".overview-instant").length,
        now: Date.now(),
        requests: performance
          .getEntriesByType("resource")
          .filter((e) => e.name.includes("/api/"))
          .map((e) => e.name),
        console: Reflect.get(window, "__overviewDiagnosticErrors"),
        panels: [...document.querySelectorAll("#page-overview .panel")].map((p) => p.id),
      }),
      undefined,
    );
    throw new Error(
      `${String(error)} · resource facts ${JSON.stringify(facts)} · browser errors ${JSON.stringify(page.errors())}`,
    );
  }
}
async function keyboardOpen(page: RenderedPage, selector: string) {
  await page.evaluate((selector) => {
    const control = document.querySelector<HTMLElement>(selector);
    if (!control) throw Error(`Keyboard route missing: ${selector}`);
    control.scrollIntoView({ block: "center" });
    control.focus();
  }, selector);
  await page.press("Enter");
}
async function fullText(page: RenderedPage, selector: string, expected: string) {
  return page.evaluate(
    async ({ selector, expected }) => {
      const until = performance.now() + 5000;
      const ready = () => {
        const el = document.querySelector<HTMLElement>(selector);
        return !!el && el.textContent?.trim() === expected.trim() && el.clientHeight > 0;
      };
      while (!ready() && performance.now() < until)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const el = document.querySelector<HTMLElement>(selector);
      return {
        found: ready(),
        clipped:
          !!el && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1),
      };
    },
    { selector, expected },
  );
}
async function capture(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}
async function geometry(page: RenderedPage) {
  return page.evaluate(() => {
    const roster = document.querySelector<HTMLElement>("#agentsList");
    const visible = (element: Element) => {
      const r = element.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      primary: (() => {
        const box = (selector: string) => {
          const b = document.querySelector(selector)?.getBoundingClientRect();
          return b ? { top: b.top, bottom: b.bottom, height: b.height } : null;
        };
        return {
          crew: box("#agentsP"),
          firstSeat: box("#agentsList .trow:not(.head)"),
          activity: box("#actP"),
          firstEvent: box("#actList .arow"),
          pipeline: box("#pipelineP"),
          machine: box("#machineSummaryP"),
          kpiTops: [...document.querySelectorAll(".overview-kpi")].map(
            (el) => el.getBoundingClientRect().top,
          ),
        };
      })(),
      width: innerWidth,
      docWidth: document.documentElement.scrollWidth,
      kpis: [...document.querySelectorAll(".overview-kpi")].map(
        (el) => el.getBoundingClientRect().height,
      ),
      rows: [...document.querySelectorAll("#agentsList .trow:not(.head)")].map(
        (el) => el.getBoundingClientRect().height,
      ),
      rosterRows: document.querySelectorAll("#agentsList .trow:not(.head)").length,
      rosterScroll: roster
        ? {
            client: roster.clientHeight,
            scroll: roster.scrollHeight,
            overflow: getComputedStyle(roster).overflowY,
          }
        : null,
      small: [
        ...document.querySelectorAll(
          "#page-overview button,#page-overview a[href],#page-overview select",
        ),
      ]
        .filter(visible)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width < 24 || r.height < 24;
        })
        .map((el) => el.textContent),
      clippedKpiFooters: [
        ...document.querySelectorAll<HTMLElement>(".overview-kpi .d,.overview-kpi .kpi-secondary"),
      ]
        .filter(
          (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
        )
        .map((el) => el.textContent),
      crewColumns: [...document.querySelectorAll<HTMLElement>("#agentsList .head > *")].map(
        (el) => ({
          label: el.textContent,
          width: el.getBoundingClientRect().width,
          align: getComputedStyle(el).textAlign,
        }),
      ),
      pipeline: {
        height: document.querySelector("#pipelineP")?.getBoundingClientRect().height,
        headingTops: [...document.querySelectorAll(".pipeline-stage h3 a")].map(
          (el) => el.getBoundingClientRect().top,
        ),
        countTops: [...document.querySelectorAll(".pipeline-counts")].map(
          (el) => el.getBoundingClientRect().top,
        ),
        counts: [...document.querySelectorAll(".pipeline-counts")].map((el) => el.textContent),
        chipTops: [...document.querySelectorAll(".pipeline-chip")].map(
          (el) => el.getBoundingClientRect().top,
        ),
      },
      spans: document.querySelectorAll(".overview-span").length,
      instants: document.querySelectorAll(".overview-instant").length,
    };
  }, undefined);
}

describeRendered("Approved Overview hierarchy", () => {
  it(
    "settles known context, full allowance and recorded timeline sources in the delivered App",
    async () => {
      const page = await renderAt({
        page: "test/overviewDensityBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "light",
        api: overviewDensityFixture().api,
      });
      try {
        await settled(page, "default");
        await keyboardOpen(page, "#quotaSummaryP .quota-details");
        expect(
          await page.evaluate(
            () =>
              ["41%", "63%", "12%"].every((value) =>
                document.querySelector("#quotaP")?.textContent?.includes(value),
              ),
            undefined,
          ),
        ).toBe(true);
        await capture(page, "redesign-source-smoke-1600-full-allowance");
        await page.press("Escape");
        await capture(page, "redesign-source-smoke-1600-folded");
        expect(
          await page.evaluate(
            () => document.querySelector("#agentsList .context-capacity")?.textContent,
            undefined,
          ),
        ).toContain("84.0k / 200k");
        await page.click(".dockrail button");
        await capture(page, "redesign-source-smoke-1600-open");
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps sub-cent rates, missing observations and full allowance evidence keyboard accessible without new reads on resize",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const fixture = overviewDensityFixture();
        fixture.summary.kpis.spendToday.series = Array.from({ length: 30 }, (_, i) =>
          i === 5 ? 0 : i % 2 ? 0.002 : 0.001,
        );
        const page = await renderAt({
          page: "test/overviewDensityBrowser.html",
          width: 1600,
          height: 1000,
          colorScheme: scheme,
          api: fixture.api,
        });
        try {
          await settled(page, "default");
          await page.evaluate(() => {
            const select = document.querySelector<HTMLSelectElement>(
              '[aria-label="Measured Overview history"]',
            );
            if (!select) throw Error("History selector missing");
            select.value = "spend";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }, undefined);
          expect(
            await fullText(page, ".measured-reading > span:first-child", "Latest ~$0.002 USD/min"),
          ).toEqual({ found: true, clipped: false });
          await keyboardOpen(page, "#overviewHistoryP .history-data summary");
          expect(
            await page.evaluate(() => {
              const table = document.querySelector("#overviewHistoryP .history-data");
              return {
                open: table?.hasAttribute("open"),
                count: table?.querySelectorAll("tbody tr").length,
                raw: [...(table?.querySelectorAll("tbody td:last-child") ?? [])].map(
                  (el) => el.textContent,
                ),
              };
            }, undefined),
          ).toMatchObject({
            open: true,
            count: 30,
            raw: expect.arrayContaining(["0", "0.001", "0.002"]),
          });
          await page.evaluate(
            () =>
              document
                .querySelector<HTMLElement>("#overviewHistoryP .history-data-scroll")
                ?.focus(),
            undefined,
          );
          await capture(page, `history-subcent-before-end-${scheme}`);
          await page.press("End");
          const historyScroll = await page.evaluate(async () => {
            const region = document.querySelector<HTMLElement>(
              "#overviewHistoryP .history-data-scroll",
            );
            if (!region) throw Error("Recorded-values region missing");
            const initial = {
              top: region.scrollTop,
              client: region.clientHeight,
              height: region.scrollHeight,
              at: performance.now(),
            };
            const until = performance.now() + 1000;
            while (
              region.scrollTop + region.clientHeight < region.scrollHeight - 1 &&
              performance.now() < until
            )
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const last = region.querySelector("tbody tr:last-child")?.getBoundingClientRect();
            return {
              initial,
              final: { top: region.scrollTop, at: performance.now() },
              focus: document.activeElement === region,
              scrolled: region.scrollTop > 0,
              bottomReached: region.scrollTop + region.clientHeight >= region.scrollHeight - 1,
              lastRowVisible: !!last && last.bottom <= region.getBoundingClientRect().bottom + 1,
            };
          }, undefined);
          if (evidence)
            writeFileSync(
              join(evidence, `history-end-trace-${scheme}.json`),
              JSON.stringify(historyScroll, null, 2),
            );
          expect(historyScroll).toMatchObject({
            focus: true,
            scrolled: true,
            bottomReached: true,
            lastRowVisible: true,
          });
          await capture(page, `history-subcent-${scheme}`);
          await page.evaluate(() => {
            const select = document.querySelector<HTMLSelectElement>(
              '[aria-label="Measured Overview history"]',
            );
            if (!select) throw Error("History selector missing");
            select.value = "ci";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }, undefined);
          expect(
            await page.evaluate(async () => {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              return document
                .querySelector("#overviewHistoryP .history-data")
                ?.textContent?.includes("Not collected");
            }, undefined),
          ).toBe(true);
          await keyboardOpen(page, "#quotaSummaryP .quota-details");
          expect(
            await page.evaluate(() => {
              const reader = document.querySelector(".overview-allowance-reader");
              return (
                !!reader && reader.matches(":modal") && reader.contains(document.activeElement)
              );
            }, undefined),
          ).toBe(true);
          await capture(page, `allowance-wide-reader-${scheme}`);
          const allowance = await page.evaluate(
            () => ({
              columns: [...document.querySelectorAll("#quotaP thead th")].map(
                (el) => el.textContent,
              ),
              text: document.querySelector("#quotaP")?.textContent,
            }),
            undefined,
          );
          expect(allowance.columns).toEqual([
            "Account / window",
            "Used",
            "Remaining",
            "Resets",
            "Forecast / freshness",
          ]);
          for (const value of [
            "41%",
            "59% left",
            "63%",
            "37% left",
            "12%",
            "88% left",
            "source",
            "read",
          ])
            expect(allowance.text).toContain(value);
          // The complete1120px reader correctly fits the table at1600. Exercise
          // overflow only when a genuinely narrower native reader needs it.
          await page.resize(800, 1000);
          const allowanceOverflow = await page.evaluate(async () => {
            const until = performance.now() + 1000;
            const note = document.querySelector<HTMLElement>("#quotaP .allowance-scroll-note");
            while (note?.hidden && performance.now() < until)
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const region = document.querySelector<HTMLElement>("#quotaP .allowance-scroll");
            return {
              named: region?.getAttribute("aria-label"),
              focusable: region?.tabIndex,
              overflows: !!region && region.scrollWidth > region.clientWidth,
              client: region?.clientWidth,
              scroll: region?.scrollWidth,
              cueVisible: !!note && !note.hidden && note.getBoundingClientRect().height > 0,
              cue: note?.textContent,
            };
          }, undefined);
          await capture(page, `allowance-narrow-reader-${scheme}`);
          expect(allowanceOverflow).toMatchObject({
            named: "Complete provider allowance",
            focusable: 0,
            overflows: true,
            cueVisible: true,
            cue: "Scroll ↔ for every allowance column",
          });
          await capture(page, `allowance-evidence-${scheme}`);
          await page.press("Escape");
          await page.evaluate(async () => {
            const ready = () =>
              !document.querySelector("dialog:modal") &&
              document.querySelector("main")?.inert === false &&
              document.activeElement === document.querySelector("#quotaSummaryP .quota-details");
            const end = performance.now() + 1000;
            while (!ready() && performance.now() < end)
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!ready())
              throw Error(`Reader close/focus not settled: ${document.activeElement?.outerHTML}`);
            // Native close returns focus immediately; finish the reader's scheduled
            // return-focus paint before beginning a separate keyboard journey.
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          }, undefined);
          const before = await page.evaluate(() => {
            Reflect.set(
              window,
              "__retainedCrewFirst",
              document.querySelector("#agentsList .trow:not(.head)"),
            );
            return performance
              .getEntriesByType("resource")
              .filter((entry) => entry.name.includes("/api/")).length;
          }, undefined);
          // The normal1280 roster no longer needs horizontal panning. Exercise its
          // existing narrow/sticky path at960 without changing accepted column widths.
          await page.resize(960, 1000);
          await page.evaluate(async () => {
            const roster = document.querySelector<HTMLElement>("#agentsList");
            roster?.scrollIntoView({ block: "center" });
            roster?.focus();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }, undefined);
          const horizontalBefore = await page.evaluate(() => {
            const region = document.querySelector<HTMLElement>("#agentsList");
            return {
              focus: document.activeElement === region,
              active: document.activeElement?.outerHTML,
              mainInert: document.querySelector("main")?.inert,
              nativeModals: [...document.querySelectorAll("dialog:modal")].map((dialog) =>
                dialog.getAttribute("aria-labelledby"),
              ),
              left: region?.scrollLeft,
              width: region?.clientWidth,
              scrollWidth: region?.scrollWidth,
            };
          }, undefined);
          if (evidence)
            writeFileSync(
              join(evidence, `horizontal-focus-before-${scheme}.json`),
              JSON.stringify(horizontalBefore, null, 2),
            );
          await capture(page, `horizontal-focus-before-${scheme}`);
          expect(horizontalBefore.focus, JSON.stringify(horizontalBefore)).toBe(true);
          expect(
            (horizontalBefore.scrollWidth ?? 0) - (horizontalBefore.width ?? 0),
          ).toBeGreaterThan(64);
          for (let step = 0; step < 16; step++) await page.press("ArrowRight");
          const horizontalAfterRight = await page.evaluate(async () => {
            const region = document.querySelector<HTMLElement>("#agentsList");
            const until = performance.now() + 1000;
            while (
              region &&
              (region.querySelector(".trow:not(.head) > :last-child")?.getBoundingClientRect()
                .right ?? Infinity) >
                region.getBoundingClientRect().right - 1 &&
              performance.now() < until
            )
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            return {
              focus: document.activeElement === region,
              left: region?.scrollLeft,
              width: region?.clientWidth,
              scrollWidth: region?.scrollWidth,
            };
          }, undefined);
          const retained = await page.evaluate(async () => {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const roster = document.querySelector<HTMLElement>("#agentsList");
            const first = roster?.querySelector<HTMLElement>(".trow:not(.head) > :first-child");
            return {
              reads: performance
                .getEntriesByType("resource")
                .filter((entry) => entry.name.includes("/api/")).length,
              sameRow:
                Reflect.get(window, "__retainedCrewFirst") ===
                roster?.querySelector(".trow:not(.head)"),
              history: document.querySelector<HTMLSelectElement>(
                '[aria-label="Measured Overview history"]',
              )?.value,
              scroll: roster?.scrollLeft,
              finalColumnVisible:
                !!roster &&
                (roster.querySelector(".trow:not(.head) > :last-child")?.getBoundingClientRect()
                  .right ?? Infinity) <=
                  roster.getBoundingClientRect().right - 1,
              sticky: first ? getComputedStyle(first).position : null,
            };
          }, undefined);
          if (evidence)
            writeFileSync(
              join(evidence, `context-scroll-trace-${scheme}.json`),
              JSON.stringify(
                { horizontalBefore, horizontalAfterRight, afterPan: retained },
                null,
                2,
              ),
            );
          expect(retained.reads).toBe(before);
          expect(retained.sameRow).toBe(true);
          expect(retained.history).toBe("ci");
          expect(retained.scroll).toBeGreaterThan(0);
          expect(retained.finalColumnVisible).toBe(true);
          expect(retained.sticky).toBe("sticky");
          expect(
            await page.reachable("#agentsList .context-capacity", "#agentsList"),
          ).not.toContain(false);
          await capture(page, `context-keyboard-narrow-${scheme}`);
          // Native Tab after a real maximum pan must reveal a Work control that is
          // initially covered by the sticky identity, rather than forcing scroll for visible text.
          const coveredBeforeFocus = await page.evaluate(() => {
            const roster = document.querySelector<HTMLElement>("#agentsList")!;
            roster.scrollLeft = roster.scrollWidth;
            const row = roster.querySelector('[href="/agent/dev-1"]')?.closest(".trow");
            const ticket = row?.querySelector<HTMLElement>(".work-cell a");
            const r = ticket?.getBoundingClientRect();
            const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return {
              scroll: roster.scrollLeft,
              text: ticket?.textContent,
              rect: r?.toJSON(),
              covered: !!hit?.closest(".agent-identity"),
            };
          }, undefined);
          if (evidence)
            writeFileSync(
              join(evidence, `sticky-precondition-${scheme}.json`),
              JSON.stringify(coveredBeforeFocus, null, 2),
            );
          expect(coveredBeforeFocus.covered, JSON.stringify(coveredBeforeFocus)).toBe(true);
          await page.evaluate(
            () =>
              document
                .querySelector<HTMLElement>('#agentsList .rowlink[href="/agent/dev-1"]')
                ?.focus(),
            undefined,
          );
          const workFocus = [];
          for (let step = 0; step < 8; step++) {
            await page.press("Tab");
            const focus = await page.evaluate(async () => {
              const control = document.activeElement as HTMLElement;
              const visible = () => {
                const box = control.getBoundingClientRect(),
                  hit = document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                  );
                return hit === control || (!!hit && control.contains(hit));
              };
              const until = performance.now() + 1000;
              while (!visible() && performance.now() < until)
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const target = control.getBoundingClientRect(),
                identity = control.closest(".trow")?.querySelector(".agent-identity"),
                hit = document.elementFromPoint(
                  target.left + target.width / 2,
                  target.top + target.height / 2,
                );
              return {
                rect: target.toJSON(),
                identity: identity?.getBoundingClientRect().toJSON(),
                identityPosition: identity ? getComputedStyle(identity).position : null,
                hit: hit?.outerHTML,
                scroll: document.querySelector("#agentsList")?.scrollLeft,
                text: control.textContent?.trim(),
                row: control.closest(".trow")?.querySelector(".rowlink")?.getAttribute("href"),
                paintVisible: visible(),
              };
            }, undefined);
            workFocus.push(focus);
            if (evidence)
              writeFileSync(
                join(evidence, `work-focus-after-pan-${scheme}.json`),
                JSON.stringify(workFocus, null, 2),
              );
            if (!focus.paintVisible) await capture(page, `work-focus-obscured-${scheme}`);
            expect(focus.row).toBe("/agent/dev-1");
            expect(focus.paintVisible).toBe(true);
            if (focus.text === "End") break;
          }
          expect(workFocus[0]?.text).toBe("#101");
          expect(workFocus.map((focus) => focus.text)).toEqual(
            expect.arrayContaining(["Answer", "Interrupt", "End"]),
          );
          if (evidence)
            writeFileSync(
              join(evidence, `work-focus-after-pan-${scheme}.json`),
              JSON.stringify(workFocus, null, 2),
            );
          await capture(page, `work-focus-after-pan-${scheme}`);
          expect(
            await page.evaluate(
              () =>
                performance
                  .getEntriesByType("resource")
                  .filter((entry) => entry.name.includes("/api/")).length,
              undefined,
            ),
          ).toBe(before);

          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "preserves nine configured seats and two observed loops through the real session filter",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/overviewDensityBrowser.html",
          width: 1600,
          height: 1000,
          colorScheme: scheme,
          api: overviewDensityFixture("mixed").api,
        });
        try {
          await settled(page, "mixed");
          await page.click(".dockrail button");
          await capture(page, `overview-mixed-1600-${scheme}-open`);
          await page.press("Escape"); // Restore the intentionally inert session control before filtering.
          expect(await page.boxes("#agentsList .trow:not(.head)")).toHaveLength(9);
          expect(await page.boxes(".loops-strip .loop-chip")).toHaveLength(2);
          expect(
            await page.evaluate(
              () => document.querySelector("#agentsList .context-capacity")?.textContent,
              undefined,
            ),
          ).toContain("84.0k / 200k");
          await page.evaluate(() => {
            const select = document.querySelector<HTMLSelectElement>("#sess");
            if (!select) throw Error("Session control missing");
            select.value = "demo";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }, undefined);
          expect(await page.boxes("#agentsList .trow:not(.head)")).toHaveLength(9);
          expect(
            await page.evaluate(
              () => document.querySelectorAll(".loops-strip .loop-chip").length,
              undefined,
            ),
          ).toBe(0);
          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps realistic long rows usable at narrow, medium and wide widths with FLIGHT folded or open",
    async () => {
      for (const width of [1280, 1600, 1920]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width,
            height: 1000,
            colorScheme: scheme,
            search: "?state=long",
            api: overviewDensityFixture("long").api,
          });
          try {
            await settled(page, "long");
            for (const dock of ["folded", "open"] as const) {
              if (dock === "open") await page.click(".dockrail button");
              await capture(page, `overview-long-${width}x1000-${scheme}-${dock}-initial`);
              expect(await page.reachable("#agentsList .need button", "#agentsList")).not.toContain(
                false,
              );
              expect(await page.unclipped("#agentsList .need button")).not.toContain(false);
              const textRoutes = await page.evaluate(
                () =>
                  [...document.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head)")]
                    .filter((row) => !row.classList.contains("flight"))
                    .map((row) => ({
                      route: row.querySelector<HTMLAnchorElement>(".rowlink")?.getAttribute("href"),
                      current: !!row.querySelector(".work-summary"),
                      full:
                        row.querySelector<HTMLElement>(".work-cell")?.getAttribute("title") ?? "",
                      accessible: row.textContent?.length ?? 0,
                    })),
                undefined,
              );
              expect(
                textRoutes.every(
                  (row) =>
                    row.route?.startsWith("/agent/") &&
                    (!row.current || row.full.length > 20) &&
                    row.accessible > 20,
                ),
              ).toBe(true);
              expect((await geometry(page)).docWidth).toBeLessThanOrEqual(width);
              await capture(page, `overview-long-${width}x1000-${scheme}-${dock}-after`);
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens complete shortened content with the keyboard using actual read-only detail routes",
    async () => {
      const fixture = overviewDensityFixture("long");
      const work = fixture.rows.find((row) => row.id === "dev-1")!;
      const held = fixture.rows.find((row) => row.id === "dev-4")!;
      const card = fixture.summary.pipeline[0]?.cards[0];
      if (!card) throw Error("Pipeline fixture missing");
      for (const width of [1280, 1600, 1920]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width,
            height: 1000,
            colorScheme: scheme,
            search: "?state=long",
            api: fixture.api,
          });
          try {
            await settled(page, "long");
            // Inspect from the monitoring page; opening FLIGHT intentionally makes it inert.
            await keyboardOpen(page, ".overview-timeline-evidence summary");
            expect(
              await page.evaluate(() => {
                const records = document.querySelector<HTMLElement>(
                  ".overview-timeline-evidence > section",
                );
                return (
                  !!records &&
                  records.clientHeight > 0 &&
                  records.textContent?.includes("instant, no duration recorded") &&
                  records.textContent?.includes("in this window")
                );
              }, undefined),
            ).toBe(true);
            await capture(page, `overview-timeline-details-${width}x1000-${scheme}-after`);
            await keyboardOpen(page, ".overview-next-first button");
            expect(
              await fullText(page, "#dsBrief .brief-section .md", fixture.attention[0]!.text),
            ).toEqual({ found: true, clipped: false });
            await capture(page, `overview-attention-details-${width}x1000-${scheme}-after`);
            await page.press("Escape");
            await keyboardOpen(page, "#pipelineP .pipeline-chip");
            expect(await fullText(page, "#page-ticket .tk-head h1", card.title)).toEqual({
              found: true,
              clipped: false,
            });
            await capture(page, `overview-pipeline-details-${width}x1000-${scheme}-after`);
            await page.reload();
            await settled(page, "long");
            await keyboardOpen(page, '#agentsList .rowlink[href="/agent/dev-1"]');
            expect(await fullText(page, "#ahead .agent-v2-meta > b", work.ticketTitle!)).toEqual({
              found: true,
              clipped: false,
            });
            await capture(page, `overview-work-details-${width}x1000-${scheme}-after`);
            await page.reload();
            await settled(page, "long");
            await keyboardOpen(page, '#agentsList .rowlink[href="/agent/dev-4"]');
            await fullText(page, "#ahead .agent-v2-meta > b", held.ticketTitle!);
            await keyboardOpen(page, "#ahead .vnow button");
            expect(await fullText(page, "#ahead .vdetail", held.note!)).toEqual({
              found: true,
              clipped: false,
            });
            await capture(page, `overview-held-details-${width}x1000-${scheme}-after`);
            expect(page.errors()).toEqual([]);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the settled full-App hierarchy and all row controls reachable at every required viewport",
    async () => {
      const receipts = [];
      for (const [width, height] of [
        [1280, 900],
        [1440, 900],
        [1600, 1000],
        [1920, 1080],
        [2560, 1440],
        [1600, 700],
      ]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: overviewDensityFixture().api,
          });
          try {
            await settled(page, "default");
            for (const dock of ["default", "expanded"] as const) {
              if (dock === "expanded" && width < 2200) await page.click(".dockrail button");
              await capture(page, `overview-${width}x${height}-${scheme}-${dock}-after`);
              const facts = await geometry(page);
              expect(facts.docWidth).toBeLessThanOrEqual(width);
              expect(facts.rosterRows).toBe(11);
              expect(facts.primary.crew!.top).toBeLessThan(facts.primary.activity!.top);
              expect(facts.primary.activity!.top).toBeLessThan(facts.primary.pipeline!.top);
              expect(facts.primary.machine!.height).toBeGreaterThan(0);
              if ([1600, 1920].includes(width) && height >= 900) {
                expect(facts.primary.firstSeat!.bottom).toBeLessThan(height - 40);
                expect(facts.primary.firstEvent!.bottom).toBeLessThan(height - 40);
                expect(new Set(facts.primary.kpiTops).size).toBe(1);
              }
              if (evidence)
                writeFileSync(
                  join(evidence, "overview-latest-geometry.json"),
                  JSON.stringify({ width, height, scheme, dock, facts }, null, 2),
                );
              expect(
                facts.rows.every((value) => value === 32),
                JSON.stringify({ width, height, scheme, dock, facts }),
              ).toBe(true);
              expect(facts.small).toEqual([]);
              expect(facts.clippedKpiFooters).toEqual([]);
              expect(
                Math.max(...facts.pipeline.headingTops) - Math.min(...facts.pipeline.headingTops),
              ).toBeLessThanOrEqual(1);
              expect(
                Math.max(...facts.pipeline.countTops) - Math.min(...facts.pipeline.countTops),
              ).toBeLessThanOrEqual(1);
              expect(facts.pipeline.counts).toContain("2 total · 1 not shown");
              expect(
                Math.max(...facts.pipeline.chipTops) - Math.min(...facts.pipeline.chipTops),
              ).toBeLessThanOrEqual(1);
              expect(facts.spans).toBeGreaterThan(0);
              expect(facts.instants).toBeGreaterThan(0);
              if (width === 1920) {
                expect(facts.kpis.every((value) => value === 96)).toBe(true);
                expect(facts.rosterScroll?.scroll).toBeLessThanOrEqual(
                  (facts.rosterScroll?.client ?? 0) + 1,
                );
              }
              expect(
                await page.reachable("#agentsList button,#agentsList a[href]", "#agentsList"),
              ).not.toContain(false);
              expect(await page.unclipped("#agentsList .need button")).not.toContain(false);
              expect(page.errors()).toEqual([]);
              await capture(page, `overview-${width}x${height}-${scheme}-${dock}-after`);
              receipts.push({ width, height, scheme, dock, facts, errors: page.errors() });
            }
          } finally {
            await page.close();
          }
        }
      }
      if (evidence)
        writeFileSync(join(evidence, "overview-geometry.json"), JSON.stringify(receipts, null, 2));
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps empty, one, fifty, long and collection states honest without losing keyboard routes",
    async () => {
      for (const scenario of [
        "empty",
        "one",
        "many",
        "long",
        "loading",
        "error",
        "stale",
        "disconnected",
      ] as OverviewScenario[]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width: 1600,
            height: 700,
            colorScheme: scheme,
            search: `?state=${scenario}`,
            api: overviewDensityFixture(scenario).api,
          });
          try {
            await settled(page, scenario);
            await capture(page, `overview-${scenario}-1600x700-${scheme}-initial`);
            const facts = await geometry(page);
            expect(facts.docWidth).toBeLessThanOrEqual(1600);
            if (scenario === "empty") {
              expect(
                Math.max(...facts.pipeline.countTops) - Math.min(...facts.pipeline.countTops),
              ).toBeLessThanOrEqual(1);
            }
            if (scenario === "many") {
              expect(facts.rosterRows).toBe(50);
              expect(
                await page.evaluate(
                  () =>
                    document.querySelector(".crew-scroll-note")?.textContent?.includes("50 seats"),
                  undefined,
                ),
              ).toBe(true);
              expect(facts.rosterScroll?.scroll).toBeGreaterThan(
                facts.rosterScroll?.client ?? Infinity,
              );
              expect(await page.reachable("#agentsList .rowlink", "#agentsList")).not.toContain(
                false,
              );
              await page.evaluate(() => {
                const roster = document.querySelector<HTMLElement>("#agentsList");
                if (!roster) throw Error("Crew scroll region missing");
                roster.scrollTop = 0;
                roster.focus();
              }, undefined);
              await page.press("End");
              const bottom = await page.evaluate(async () => {
                const roster = document.querySelector<HTMLElement>("#agentsList")!;
                const until = performance.now() + 1000;
                while (
                  roster.scrollTop + roster.clientHeight < roster.scrollHeight - 1 &&
                  performance.now() < until
                )
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                const rows = roster.querySelectorAll<HTMLElement>(".trow:not(.head)");
                const link = rows[rows.length - 1]?.querySelector<HTMLAnchorElement>(".rowlink");
                link?.focus();
                const bounds = link?.getBoundingClientRect();
                const region = roster.getBoundingClientRect();
                return {
                  atBottom: roster.scrollTop + roster.clientHeight >= roster.scrollHeight - 1,
                  focused:
                    !!link && document.activeElement === link && link.matches(":focus-visible"),
                  focusInset: !!link && getComputedStyle(link).outlineOffset === "-2px",
                  route: link?.getAttribute("href"),
                  visible: !!bounds && bounds.top >= region.top && bounds.bottom <= region.bottom,
                };
              }, undefined);
              expect(bottom.atBottom).toBe(true);
              expect(bottom.focused).toBe(true);
              expect(bottom.focusInset).toBe(true);
              expect(bottom.visible).toBe(true);
              expect(bottom.route).toMatch(/^\/agent\//);
              await capture(page, `overview-many-bottom-1600x700-${scheme}-after`);
            }
            if (scenario === "long")
              expect(await page.unclipped("#agentsList .need button")).not.toContain(false);
            expect(page.errors()).toEqual([]);
            await capture(page, `overview-${scenario}-1600x700-${scheme}-after`);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
