// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { codeRiskFixture } from "./codeRiskFixtures.ts";

const { renderAt } = browserSession();
describeRendered("Code risk measured layout", () => {
  it(
    "renders measured and unknown sources at the required widths and themes",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ])
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/codeHealthBrowser.html",
            width,
            height,
            colorScheme,
            search: "?dock=1",
            api: codeRiskFixture().api,
          });
          try {
            await page.boxes(".ch-recommendation");
            await page.click("#ch-tab-risk");
            await page.boxes(".ch-risk-table");
            const metrics = await page.evaluate(
              () => ({
                docWidth: document.documentElement.scrollWidth,
                width: innerWidth,
                bottom: document.querySelector(".code-health")?.getBoundingClientRect().bottom,
                small: [
                  ...document.querySelectorAll(
                    ".code-health button,.code-health input,.code-health a[href]",
                  ),
                ].filter((element) => {
                  const r = element.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                }).length,
                chartCount: document.querySelectorAll(".ch-risk-histories svg").length,
              }),
              undefined,
            );
            if (process.env.MC_QA_EVIDENCE_DIR) {
              mkdirSync(process.env.MC_QA_EVIDENCE_DIR, { recursive: true });
              await page.screenshot(
                join(
                  process.env.MC_QA_EVIDENCE_DIR,
                  `risk-${width}x${height}-${colorScheme}-after.png`,
                ),
              );
            }
            expect(metrics.docWidth).toBeLessThanOrEqual(metrics.width);
            expect(metrics.small).toBe(0);
            expect(metrics.chartCount).toBe(4);
            if (width === 1600 && height === 1000) expect(metrics.bottom).toBeLessThanOrEqual(1000);
            expect(
              (await page.reachable(".ch-risk button,.ch-risk a[href],.ch-risk input")).every(
                Boolean,
              ),
            ).toBe(true);
            expect((await page.unclipped(".ch-risk-path")).every(Boolean)).toBe(true);
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps long and empty file sources inspectable without clipped controls",
    async () => {
      for (const count of [0, 50]) {
        const fixture = codeRiskFixture(Date.now(), count);
        if (count) fixture.data.files[0].path = `src/${"long-module/".repeat(20)}example.ts`;
        const page = await renderAt({
          page: "test/codeHealthBrowser.html",
          width: 1280,
          height: 900,
          colorScheme: "dark",
          search: "?dock=1",
          api: fixture.api,
        });
        try {
          await page.boxes(".ch-recommendation");
          await page.click("#ch-tab-risk");
          await page.boxes(".ch-risk");
          expect((await page.unclipped(".ch-risk")).every(Boolean)).toBe(true);
          expect((await page.reachable(".ch-risk button,.ch-risk a[href]")).every(Boolean)).toBe(
            true,
          );
          if (count) {
            await page.click(".ch-risk-path");
            await page.boxes(".ch-dialog");
            expect((await page.reachable(".ch-dialog button")).every(Boolean)).toBe(true);
          }
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
