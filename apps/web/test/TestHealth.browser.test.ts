// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";
import { testHealthFixture } from "./testHealthFixtures.ts";

const { renderAt } = browserSession();
async function metadataOverflow(page: RenderedPage) {
  return page.evaluate(() => {
    const overflow: {
      text: string;
      left: number;
      right: number;
      cellLeft: number;
      cellRight: number;
    }[] = [];
    for (const element of document.querySelectorAll(".ch-test-scroll tbody th .ch-test-detail")) {
      const cell = element.closest("th");
      if (!cell) continue;
      const bounds = cell.getBoundingClientRect(),
        walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects())
          if (rect.width > 0 && (rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5))
            overflow.push({
              text: (node.textContent ?? "").slice(0, 80),
              left: rect.left,
              right: rect.right,
              cellLeft: bounds.left,
              cellRight: bounds.right,
            });
        node = walker.nextNode();
      }
    }
    return overflow;
  }, undefined);
}
describeRendered("Test health measured layout", () => {
  it(
    "fits the delivered App with FLIGHT folded or open and preserves keyboard evidence access",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ])
        for (const colorScheme of ["light", "dark"] as const)
          for (const rail of ["collapsed", "expanded"] as const) {
            const many =
              width === 1600 && height === 700 && colorScheme === "dark" && rail === "expanded";
            const fixture = testHealthFixture(NOW, many ? 50 : 4),
              shell = desktopFixture();
            const shellConfig = shell.api["/api/config"] as { repos: Record<string, unknown>[] };
            const api = {
              ...shell.api,
              ...fixture.api,
              "/api/config": {
                ...shellConfig,
                repos: [{ ...shellConfig.repos[0], id: "sample", github: "example/sample" }],
              },
            };
            const page = await renderAt({
              page: "test/desktopBrowser.html",
              width,
              height,
              colorScheme,
              search: "?path=/audit",
              api,
            });
            try {
              await page.boxes(".ch-recommendation");
              if (rail === "expanded") await page.click("#dock .dockrail button");
              await page.click("#ch-tab-test");
              await page.boxes(".ch-test");
              const metrics = await page.evaluate(
                () => ({
                  width: innerWidth,
                  documentWidth: document.documentElement.scrollWidth,
                  bottom: document.querySelector(".code-health")?.getBoundingClientRect().bottom,
                  workAreaBottom: document.querySelector("main")?.getBoundingClientRect().bottom,
                  workAreaHeight: document.querySelector("main")?.clientHeight,
                  workAreaContentHeight: document.querySelector("main")?.scrollHeight,
                  footerBottom: document.querySelector(".ch-footer")?.getBoundingClientRect()
                    .bottom,
                  firstDurationBottom: document
                    .querySelector(".ch-test-durations tbody tr")
                    ?.getBoundingClientRect().bottom,
                  durationViewportBottom: document
                    .querySelector(".ch-test-durations")
                    ?.getBoundingClientRect().bottom,
                  clippedNumbers: [
                    ...document.querySelectorAll(".ch-test-scroll td.ch-number"),
                  ].filter((element) => element.scrollWidth > element.clientWidth).length,
                  clippedHeaders: [...document.querySelectorAll(".ch-test-scroll thead th")].filter(
                    (element) => element.scrollWidth > element.clientWidth,
                  ).length,
                  durationUnitTransform: getComputedStyle(
                    document.querySelector(
                      ".ch-test-durations thead th:nth-child(2)",
                    ) as HTMLElement,
                  ).textTransform,
                  header: document.querySelector(".ch-heading")?.getBoundingClientRect().top,
                  dockWidth: document.querySelector("#dock")?.getBoundingClientRect().width,
                  identityTransform: getComputedStyle(
                    document.querySelector(".ch-test-disruption tbody th") as HTMLElement,
                  ).textTransform,
                  small: [
                    ...document.querySelectorAll(
                      ".code-health button,.code-health a[href],.code-health select,.code-health summary",
                    ),
                  ].filter((element) => {
                    const r = element.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                  }).length,
                }),
                undefined,
              );
              expect(metrics.documentWidth).toBeLessThanOrEqual(width);
              expect(metrics.small).toBe(0);
              expect(metrics.dockWidth).toBe(rail === "collapsed" ? 48 : 380);
              expect(metrics.identityTransform).toBe("none");
              expect(metrics.clippedNumbers).toBe(0);
              expect(metrics.clippedHeaders).toBe(0);
              expect(metrics.durationUnitTransform).toBe("none");
              expect(await metadataOverflow(page)).toEqual([]);
              if (width === 1600 && height === 1000) {
                expect(metrics.bottom).toBeLessThanOrEqual(1000);
                expect(
                  metrics.workAreaContentHeight,
                  JSON.stringify({ width, height, rail, colorScheme, metrics }),
                ).toBeLessThanOrEqual(metrics.workAreaHeight ?? 0);
                expect(metrics.footerBottom).toBeLessThanOrEqual(metrics.workAreaBottom ?? 0);
                expect(metrics.firstDurationBottom).toBeLessThanOrEqual(
                  metrics.durationViewportBottom ?? 0,
                );
              }
              expect(
                (await page.reachable(".ch-test button,.ch-test summary")).every(Boolean),
              ).toBe(true);
              if (width === 1600 && height === 1000 && rail === "expanded") {
                await page.evaluate(
                  () =>
                    (
                      document.querySelector(".ch-test-disruption button") as HTMLButtonElement
                    ).focus(),
                  undefined,
                );
                await page.press("Enter");
                await page.boxes(".ch-dialog");
                expect(
                  (await page.reachable(".ch-dialog button,.ch-dialog select")).every(Boolean),
                ).toBe(true);
                await page.press("Escape");
                await page.evaluate(
                  () =>
                    new Promise<void>((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    ),
                  undefined,
                );
                expect(
                  await page.evaluate(
                    () =>
                      document.activeElement ===
                      document.querySelector(".ch-test-disruption button"),
                    undefined,
                  ),
                ).toBe(true);
              }
              if (many) {
                await page.evaluate(
                  () => (document.querySelector(".ch-test-disruption") as HTMLElement).focus(),
                  undefined,
                );
                await page.press("End");
                await page.evaluate(
                  () => new Promise((resolve) => setTimeout(resolve, 150)),
                  undefined,
                );
                expect(
                  await page.evaluate(
                    () => document.querySelector(".ch-test-disruption")?.scrollTop,
                    undefined,
                  ),
                ).toBeGreaterThan(0);
              }
              expect(page.errors()).toEqual([]);
            } finally {
              await page.close();
            }
          }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "fits the normal desktop and keeps real controls reachable at all required sizes and themes",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ]) {
        for (const colorScheme of ["light", "dark"] as const) {
          const fixture = testHealthFixture(Date.now());
          const page = await renderAt({
            page: "test/codeHealthBrowser.html",
            width,
            height,
            colorScheme,
            search: "?dock=1",
            api: fixture.api,
          });
          try {
            await page.boxes(".ch-recommendation");
            await page.click("#ch-tab-test");
            await page.boxes(".ch-test-disruption");
            const metrics = await page.evaluate(
              () => ({
                width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                bottom: document.querySelector(".code-health")?.getBoundingClientRect().bottom,
                small: [
                  ...document.querySelectorAll(
                    ".code-health button,.code-health a[href],.code-health select,.code-health summary",
                  ),
                ].filter((element) => {
                  const rect = element.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24);
                }).length,
                classifications: [...document.querySelectorAll(".ch-test-classification")].map(
                  (element) => element.textContent,
                ),
              }),
              undefined,
            );
            expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
            expect(metrics.small).toBe(0);
            expect(metrics.classifications).toEqual([
              "Candidate",
              "Confirmed flaky",
              "Consistently failing",
              "Infrastructure",
            ]);
            if (width === 1600 && height === 1000) expect(metrics.bottom).toBeLessThanOrEqual(1000);
            expect(
              (await page.unclipped(".ch-test-cohort,.ch-test-layout,.ch-test-identity")).every(
                Boolean,
              ),
            ).toBe(true);
            expect((await page.reachable(".ch-test button,.ch-test summary")).every(Boolean)).toBe(
              true,
            );
            if (process.env.MC_QA_EVIDENCE_DIR) {
              mkdirSync(process.env.MC_QA_EVIDENCE_DIR, { recursive: true });
              await page.screenshot(
                join(
                  process.env.MC_QA_EVIDENCE_DIR,
                  `test-health-${width}x${height}-${colorScheme}.png`,
                ),
              );
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
    "keeps empty, one, many, long and partial results inspectable with visible scroll regions",
    async () => {
      for (const colorScheme of ["light", "dark"] as const)
        for (const count of [0, 1, 50]) {
          const fixture = testHealthFixture(Date.now(), count);
          if (count === 50) {
            fixture.data.disruption[0].label = `tests/${"long-module/".repeat(24)}account.test.ts › preserves state`;
            const fullIdentity = fixture.data.disruption[0].label;
            const records = fixture.api[
              "/api/code-health/evidence/ch_test_ordered?repo=sample&cursor=0"
            ] as { rows: Record<string, unknown>[] };
            for (const row of records.rows) row.name = fullIdentity;
            fixture.data.durations[0].environment = "isolated runner / ".repeat(15);
            fixture.data.qaProposals[0].reviewer = "reviewer-with-long-identity-".repeat(12);
            for (const row of records.rows) row.environment = fixture.data.durations[0].environment;
            const qaRecords = fixture.api[
              "/api/code-health/evidence/ch_test_qa_linked?repo=sample&cursor=0"
            ] as { rows: Record<string, unknown>[] };
            for (const row of qaRecords.rows) row.reviewer = fixture.data.qaProposals[0].reviewer;
            if (fixture.data.namedTestRate) fixture.data.namedTestRate.percent = null;
            for (const row of fixture.data.disruption) if (row.rate) row.rate.percent = null;
            fixture.coverage[1].complete = false;
            fixture.data.omitted = { disruption: 7, durations: 2, qaProposals: 3 };
          }
          const page = await renderAt({
            page: "test/codeHealthBrowser.html",
            width: 1280,
            height: 700,
            colorScheme,
            search: "?dock=1",
            api: fixture.api,
          });
          try {
            await page.boxes(".ch-recommendation");
            await page.click("#ch-tab-test");
            await page.boxes(".ch-test");
            expect(await metadataOverflow(page)).toEqual([]);
            expect(
              (await page.unclipped(".ch-test,.ch-test-cohort,.ch-test-identity")).every(Boolean),
            ).toBe(true);
            expect((await page.reachable(".ch-test button,.ch-test summary")).every(Boolean)).toBe(
              true,
            );
            if (count) {
              await page.click(".ch-test-disruption button");
              await page.boxes(".ch-dialog");
              expect(
                (await page.reachable(".ch-dialog button,.ch-dialog select")).every(Boolean),
              ).toBe(true);
              await page.click(".ch-evidence-item summary");
              const links = await page.evaluate(
                () =>
                  [...document.querySelectorAll<HTMLAnchorElement>(".ch-evidence-rows a")].map(
                    (link) => link.href,
                  ),
                undefined,
              );
              expect(links).toContain(`https://github.com/example/sample/commit/${"a".repeat(40)}`);
              if (count === 50)
                expect(
                  await page.evaluate(
                    () =>
                      [...document.querySelectorAll(".ch-evidence-item dd")]
                        .map((element) => element.textContent)
                        .some((text) => text?.includes("long-module/".repeat(24))),
                    undefined,
                  ),
                ).toBe(true);
              if (count === 50) {
                await page.press("Escape");
                await page.evaluate(
                  () =>
                    new Promise<void>((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                    ),
                  undefined,
                );
                await page.evaluate(
                  () =>
                    (
                      document.querySelector(".ch-test-durations button") as HTMLButtonElement
                    ).focus(),
                  undefined,
                );
                await page.press("Enter");
                await page.boxes(".ch-evidence-rows summary");
                await page.evaluate(
                  () =>
                    (document.querySelector(".ch-evidence-rows summary") as HTMLElement).focus(),
                  undefined,
                );
                await page.press("Enter");
                await page.press("End");
                await page.evaluate(
                  () => new Promise((resolve) => setTimeout(resolve, 100)),
                  undefined,
                );
                const fullEnvironment = await page.evaluate((expected) => {
                  const value = [
                    ...document.querySelectorAll(".ch-evidence-rows details[open] dd"),
                  ].find((node) => node.textContent === expected);
                  const bounds = value?.getBoundingClientRect(),
                    body = document.querySelector(".ch-dialog-body")?.getBoundingClientRect();
                  return {
                    text: value?.textContent,
                    contained:
                      !!bounds && !!body && bounds.left >= body.left && bounds.right <= body.right,
                    visible:
                      !!bounds && !!body && bounds.top >= body.top && bounds.bottom <= body.bottom,
                  };
                }, fixture.data.durations[0].environment);
                expect(fullEnvironment).toEqual({
                  text: fixture.data.durations[0].environment,
                  contained: true,
                  visible: true,
                });
              }
            }
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "labels collection failure, stale, disconnected and unsupported windows without inventing a rate",
    async () => {
      for (const colorScheme of ["light", "dark"] as const)
        for (const state of ["loading", "error", "stale", "disconnected", "unsupported"] as const) {
          const fixture = testHealthFixture(Date.now(), 0),
            path = "/api/code-health?repo=sample&window=30d&tab=test";
          if (state === "error") delete fixture.api[path];
          if (state === "stale") fixture.view.generatedAt = Date.now() - 180000;
          if (state === "unsupported") {
            fixture.coverage[1].note =
              "The selected window is unsupported by this source. Earlier history has not been imported.";
            fixture.coverage[1].state = "not-collected";
          }
          // The map holds the source view's generatedAt by value, so select the explicit variant.
          if (state !== "error") fixture.api[path] = fixture.view;
          const page = await renderAt({
            page: "test/codeHealthBrowser.html",
            width: 1600,
            height: 700,
            colorScheme,
            search:
              state === "disconnected"
                ? "?disconnected=1"
                : state === "loading"
                  ? "?test-loading=1"
                  : "",
            api: fixture.api,
          });
          try {
            await page.boxes(".ch-recommendation");
            await page.click("#ch-tab-test");
            if (state === "error") await page.boxes('[role="alert"]');
            else if (state === "loading") await page.boxes('.ch-notice[role="status"]');
            else await page.boxes(".ch-test");
            if (state === "unsupported") await page.click(".ch-test-cohort:nth-child(2) summary");
            const text = await page.evaluate(() => document.body.textContent ?? "", undefined);
            expect(text).toContain(
              state === "loading"
                ? "Loading code-health observations"
                : state === "error"
                  ? "Collection failed"
                  : state === "stale"
                    ? "Stale snapshot"
                    : state === "disconnected"
                      ? "Disconnected"
                      : "window is unsupported",
            );
            expect(text).not.toContain("0% failed");
            expect((await page.reachable(".code-health button")).every(Boolean)).toBe(true);
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
