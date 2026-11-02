// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { testHealthFixture } from "./testHealthFixtures.ts";

const { renderAt } = browserSession();
describeRendered("Test health measured layout", () => {
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
            fixture.data.durations[0].environment = "isolated runner / ".repeat(15);
            fixture.data.qaProposals[0].reviewer = "reviewer-with-long-identity-".repeat(12);
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
