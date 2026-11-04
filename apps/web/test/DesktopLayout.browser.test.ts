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
import { type DesktopScenario, desktopFixture, desktopQaFixture } from "./desktopFixtures.ts";
import { qaReportFixture } from "./qaReportFixture.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
async function ready(page: RenderedPage, selector = "main > section") {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.boxes(selector);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
}
async function capture(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}
async function shellMetrics(page: RenderedPage) {
  return page.evaluate(() => {
    const shell = document.querySelector(".shell") as HTMLElement;
    const dock = document.querySelector("#dock") as HTMLElement | null;
    const visible = (element: Element) =>
      element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const smallControls = [
      ...document.querySelectorAll("#dock button,#dock input,#dock a[href],#dock summary"),
    ]
      .filter(visible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width < 24 || rect.height < 24;
      })
      .map((element) => element.textContent?.trim() ?? element.tagName);
    return {
      width: innerWidth,
      docWidth: document.documentElement.scrollWidth,
      dockWidth: dock?.getBoundingClientRect().width,
      gutter: parseFloat(getComputedStyle(shell).paddingLeft),
      gap: parseFloat(getComputedStyle(shell).columnGap),
      rows: [...document.querySelectorAll(".trow:not(.head)")]
        .filter(visible)
        .map((element) => element.getBoundingClientRect().height),
      smallControls,
      selected: document.activeElement?.id,
      collapsed: dock?.classList.contains("collapsed"),
      summaryItems: document.querySelectorAll(".dock-summary-item").length,
      panelHead: document.querySelector(".ph h2")
        ? getComputedStyle(document.querySelector(".ph h2") as Element).fontSize
        : null,
      panelPadding: document.querySelector(".ph")
        ? [
            getComputedStyle(document.querySelector(".ph") as Element).paddingTop,
            getComputedStyle(document.querySelector(".ph") as Element).paddingRight,
          ]
        : null,
      errors: [] as string[],
    };
  }, undefined);
}

describeRendered("Approved compact desktop shell", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(
      "uses measured compact/wide geometry and a useful expandable rail at all approved viewports: " +
        scheme,
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
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: desktopFixture().api,
          });
          try {
            await ready(page, "#page-overview");
            const initial = await shellMetrics(page);
            expect(initial.docWidth).toBeLessThanOrEqual(width);
            expect(initial.gutter).toBe(12);
            expect(initial.gap).toBe(initial.gutter);
            expect(initial.collapsed).toBe(width < 2200);
            expect(initial.dockWidth).toBe(width < 2200 ? 48 : 380);
            expect(initial.panelHead).toBe("14px");
            expect(initial.panelPadding).toEqual([width < 2200 ? "8px" : "12px", "16px"]);
            expect(initial.rows.every((height) => height >= 40)).toBe(true);
            await capture(page, `desktop-${width}x${height}-${scheme}-default-after`);
            if (width < 2200) await page.click(".dockrail button");
            await page.boxes(".dock-summary-item");
            const expanded = await shellMetrics(page);
            expect(expanded.dockWidth).toBe(380);
            expect(expanded.summaryItems).toBe(3);
            expect(expanded.smallControls).toEqual([]);
            if (width < 2200) expect(expanded.selected).toBe("dockHeading");
            expect(
              (
                await page.reachable(
                  "#dock .dh button,#dock input,#dock .dock-summary a[href],#dock summary",
                )
              ).every(Boolean),
            ).toBe(true);
            expect(page.errors()).toEqual([]);
            await capture(page, `desktop-${width}x${height}-${scheme}-expanded-after`);
            if (height === 700) {
              const scroll = await page.evaluate(() => {
                const summary = document.querySelector<HTMLElement>(".dock-summary");
                const next = document.querySelector<HTMLButtonElement>(".dock-next button");
                next?.focus();
                return {
                  overflow: summary ? getComputedStyle(summary).overflowY : null,
                  scrollable: summary ? summary.scrollHeight > summary.clientHeight : false,
                  moved: (summary?.scrollTop ?? 0) > 0,
                };
              }, undefined);
              expect(scroll).toEqual({ overflow: "auto", scrollable: true, moved: true });
              await capture(page, `desktop-${width}x${height}-${scheme}-focused-scroll-after`);
            }
            receipts.push({
              viewport: [width, height],
              scheme,
              initial,
              expanded,
              pageErrors: page.errors(),
              source: "controlled fictional API fixture; production App, shared styles and Dock",
            });
          } finally {
            await page.close();
          }
        }
        if (evidence)
          writeFileSync(
            join(evidence, `desktop-${scheme}-checks.json`),
            JSON.stringify(receipts, null, 2),
          );
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "retains actual mounted draft, focus and session choice through collapse, viewport changes and reload",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 700,
        api: desktopFixture().api,
      });
      try {
        await ready(page);
        await page.evaluate(
          () => document.querySelector<HTMLButtonElement>(".dockrail button")?.focus(),
          undefined,
        );
        await page.press("Enter");
        expect(
          await page.evaluate(() => {
            const heading = document.querySelector("#dockHeading");
            return heading ? getComputedStyle(heading).outlineStyle : null;
          }, undefined),
        ).toBe("solid");
        await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>("#dockInput");
          if (!input) throw Error("Missing composer");
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          set?.call(input, "Keep the selected decision draft");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }, undefined);
        await page.press("Tab");
        expect(
          await page.evaluate(() => document.activeElement?.textContent?.trim(), undefined),
        ).toBe("Collapse");
        await page.press("Enter");
        expect(
          await page.evaluate(() => document.activeElement?.matches(".dockrail button"), undefined),
        ).toBe(true);
        await page.resize(2560, 1440);
        expect((await shellMetrics(page)).collapsed).toBe(true);
        await page.click(".dockrail button");
        expect(
          await page.evaluate(
            () => (document.querySelector("#dockInput") as HTMLInputElement).value,
            undefined,
          ),
        ).toBe("Keep the selected decision draft");
        await page.resize(1280, 900);
        expect((await shellMetrics(page)).collapsed).toBe(false);
        await page.reload();
        await ready(page);
        expect((await shellMetrics(page)).collapsed).toBe(false);
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "names empty, one, fifty, long, loading, error, stale and disconnected summary states",
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
      ] as DesktopScenario[]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width: 1600,
            height: 700,
            colorScheme: scheme,
            search: `?state=${scenario}`,
            api: desktopFixture(scenario).api,
          });
          try {
            await ready(page);
            await page.click(".dockrail button");
            await page.boxes(".dock-summary");
            const summary = await page.evaluate(
              () => document.querySelector(".dock-summary")?.textContent ?? "",
              undefined,
            );
            if (scenario === "empty") expect(summary).toContain("Nothing is waiting");
            if (scenario === "many") {
              expect(summary).toContain("View all 50 waiting items");
              const log = await page.evaluate(() => {
                const element = document.querySelector<HTMLElement>(".dmsgs");
                return {
                  count: element?.children.length,
                  distance: element
                    ? element.scrollHeight - element.clientHeight - element.scrollTop
                    : null,
                };
              }, undefined);
              expect(log.count).toBe(20);
              expect(log.distance).toBeLessThanOrEqual(1);
              await page.evaluate(() => {
                const messages = document.querySelector<HTMLElement>(".dmsgs");
                if (!messages) throw new Error("Missing conversation");
                messages.scrollTop = 100;
                messages.dispatchEvent(new Event("scroll", { bubbles: true }));
              }, undefined);
              await page.click("#dockHead button[aria-controls=dockBody]");
              await page.click(".dockrail button");
              expect(
                await page.evaluate(
                  () => document.querySelector<HTMLElement>(".dmsgs")?.scrollTop,
                  undefined,
                ),
              ).toBe(100);
            }
            if (scenario === "loading") expect(summary).toContain("Loading waiting items");
            if (scenario === "error") expect(summary).toContain("could not refresh");
            if (scenario === "stale") expect(summary).toContain("Stale headline");
            if (scenario === "disconnected") expect(summary).toContain("Disconnected");
            if (scenario === "long") {
              await page.click(".dock-headline summary");
              expect(
                await page.evaluate(
                  () => document.querySelector(".dock-headline[open] p")?.textContent?.length ?? 0,
                  undefined,
                ),
              ).toBeGreaterThan(140);
            }
            expect((await shellMetrics(page)).summaryItems).toBeLessThanOrEqual(3);
            expect((await shellMetrics(page)).smallControls).toEqual([]);
            expect(page.errors()).toEqual([]);
            await capture(page, `desktop-state-${scenario}-1600x700-${scheme}-after`);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps filled current and archived QA evidence reachable beside folded and open FLIGHT",
    async () => {
      for (const path of ["/qa", qaReportFixture().permalink])
        for (const [width, height] of [
          [1280, 900],
          [1600, 1000],
          [1600, 700],
        ])
          for (const scheme of ["light", "dark"] as const) {
            const page = await renderAt({
              page: "test/desktopBrowser.html",
              width,
              height,
              colorScheme: scheme,
              search: `?path=${encodeURIComponent(path)}`,
              api: desktopQaFixture(),
            });
            try {
              await ready(page, "article.qa-report");
              for (const state of ["folded", "open"] as const) {
                if (state === "open") await page.click(".dockrail button");
                await page.evaluate(
                  () =>
                    document.querySelector("article.qa-report")?.scrollIntoView({ block: "start" }),
                  undefined,
                );
                const facts = await page.evaluate(
                  () => ({
                    width: document.documentElement.scrollWidth,
                    report: document.querySelector("article.qa-report")?.textContent,
                    scroll: document
                      .querySelector('[aria-label="Recorded test and command evidence"]')
                      ?.getAttribute("tabindex"),
                  }),
                  undefined,
                );
                expect(facts.width).toBeLessThanOrEqual(width);
                expect(facts.report).toContain("reviewer reported");
                expect(facts.report).toContain("hub receipt");
                expect(facts.scroll).toBe("0");
                expect(await page.unclipped("article.qa-report .panel")).not.toContain(false);
                expect(
                  await page.reachable(
                    'article.qa-report a,article.qa-report button,article.qa-report [tabindex="0"]',
                  ),
                ).not.toContain(false);
                await capture(
                  page,
                  `desktop-qa-${path.includes("report=") ? "archive" : "queue"}-${width}x${height}-${scheme}-${state}-after`,
                );
                await page.evaluate(
                  () =>
                    document
                      .querySelector("article.qa-report figure")
                      ?.scrollIntoView({ block: "center" }),
                  undefined,
                );
                const loaded = await page.evaluate(async () => {
                  for (let i = 0; i < 100; i++) {
                    const img = document.querySelector<HTMLImageElement>(
                      "article.qa-report figure img",
                    );
                    if (img?.complete && img.naturalWidth > 0) return true;
                    await new Promise((resolve) => setTimeout(resolve, 10));
                  }
                  return false;
                }, undefined);
                expect(
                  loaded,
                  "Synthetic fixture PNG should decode; this does not test server image authority",
                ).toBe(true);
                expect(page.errors()).toEqual([]);
              }
            } finally {
              await page.close();
            }
          }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "preserves the shared shell on QA, Audit, Map, Comms, Telemetry, Board, Agent, Overview and Setup",
    async () => {
      for (const [name, path] of [
        ["QA", "/qa"],
        ["Audit", "/audit"],
        ["Map", "/map/shop-app"],
        ["Comms", "/comms"],
        ["Telemetry", "/telemetry"],
        ["Board", "/board"],
        ["Agent", "/agent/guido-1"],
        ["Overview", "/"],
        ["Setup", "/setup/sessions"],
      ]) {
        for (const scheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width: 1600,
            height: 1000,
            colorScheme: scheme,
            search: `?path=${encodeURIComponent(path)}`,
            api: desktopFixture().api,
          });
          try {
            await ready(page, "main h1");
            expect((await shellMetrics(page)).docWidth, name).toBeLessThanOrEqual(1600);
            expect((await shellMetrics(page)).gutter).toBe(12);
            expect(page.errors(), name).toEqual([]);
            if (name === "Comms") {
              expect(
                await page.evaluate(
                  () =>
                    [...document.querySelectorAll("small")].filter((element) => {
                      const rect = element.getBoundingClientRect(),
                        style = getComputedStyle(element);
                      return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        !style.fontFamily.toLowerCase().includes("mono") &&
                        parseFloat(style.fontSize) < 12
                      );
                    }).length,
                  undefined,
                ),
              ).toBe(0);
            }
            await capture(page, `desktop-page-${name.toLowerCase()}-1600x1000-${scheme}-after`);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
