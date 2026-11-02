// @vitest-environment node
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";

const { renderAt } = browserSession();
describeRendered("code health in a real browser", () => {
  it(
    "keeps both normal tabs readable beside a dock at 1600 by 1000",
    async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/codeHealthBrowser.html",
          width: 1600,
          height: 1000,
          search: "?dock=1",
          colorScheme,
          api: codeHealthBrowserApi(),
        });
        try {
          await page.boxes(".ch-recommendation");
          for (const tab of ["overview", "review"]) {
            if (tab === "review") await page.click("#ch-tab-review");
            await page.boxes(".ch-bar-row");
            const metrics = await page.evaluate(
              () => ({
                width: innerWidth,
                docWidth: document.documentElement.scrollWidth,
                bottom: document.querySelector(".code-health")?.getBoundingClientRect().bottom,
                small: [...document.querySelectorAll("button,input,select,a[href]")].filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                }).length,
              }),
              undefined,
            );
            expect(metrics.docWidth).toBeLessThanOrEqual(metrics.width);
            expect(metrics.bottom).toBeLessThanOrEqual(1000);
            expect(metrics.small).toBe(0);
            expect((await page.reachable(".code-health button")).every(Boolean)).toBe(true);
          }
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps narrow and short layouts reachable with 50-row evidence",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 700],
      ]) {
        const page = await renderAt({
          page: "test/codeHealthBrowser.html",
          width,
          height,
          search: "?dock=1",
          colorScheme: "dark",
          api: codeHealthBrowserApi(),
        });
        try {
          await page.boxes(".ch-recommendation");
          expect((await page.unclipped(".code-health")).every(Boolean)).toBe(true);
          await page.click(".ch-recommendation button");
          await page.boxes(".ch-evidence-item");
          expect((await page.reachable(".ch-dialog button")).every(Boolean)).toBe(true);
          const rows = await page.boxes(".ch-evidence-rows details");
          expect(rows).toHaveLength(50);
          const horizontal = await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
            undefined,
          );
          expect(horizontal).toBe(true);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
