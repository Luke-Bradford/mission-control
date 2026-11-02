// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { qaReportApi, qaReportFixture } from "./qaReportFixture.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "qa-report-shots");

describeRendered("Accountable QA report", () => {
  it(
    "keeps paired evidence and command receipts inspectable at desktop widths and both themes",
    async () => {
      mkdirSync(SHOTS, { recursive: true });
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ])
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/qaReadinessBrowser.html",
            width,
            height,
            colorScheme,
            api: qaReportApi(),
          });
          await page.boxes("article.qa-report");
          const facts = await page.evaluate(
            () => ({
              report: document.querySelector("article.qa-report")?.textContent ?? "",
              receipt: document
                .querySelector('[aria-label="Recorded test and command evidence"]')
                ?.getAttribute("tabindex"),
              scroll: document.documentElement.scrollWidth,
              permanent: document.querySelector('a[href*="&report="]')?.getAttribute("href"),
            }),
            null,
          );
          expect(facts.report).toContain("hub receipt");
          expect(facts.report).toContain("reviewer reported");
          expect(facts.report).toContain("Follow-up disposition");
          expect(facts.receipt).toBe("0");
          expect(facts.scroll).toBeLessThanOrEqual(width);
          expect(facts.permanent).toBe(qaReportFixture().permalink);
          expect(await page.unclipped("article.qa-report .panel")).not.toContain(false);
          expect(await page.reachable("article.qa-report a")).not.toContain(false);
          await page.screenshot(join(SHOTS, `qa-report-${width}x${height}-${colorScheme}.png`));
          await page.close();
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens a saved report after merge without a queue item or acceptance controls",
    async () => {
      const r = qaReportFixture();
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1280,
        api: qaReportApi(0),
        search: `?repo=mission-control&pr=1011&report=${r.id}`,
      });
      await page.boxes("article.qa-report");
      const text = await page.evaluate(
        () => ({
          text: document.body.textContent,
          actions: document.querySelectorAll(".uat-accept").length,
        }),
        null,
      );
      expect(text.text).toContain("Saved historical report");
      expect(text.actions).toBe(0);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps fifty long commands keyboard-scrollable and never substitutes evidence for a different head",
    async () => {
      const r = qaReportFixture(),
        api = qaReportApi();
      r.tests = Array.from({ length: 50 }, (_, i) => ({
        command: `test-${i}-${"long-path/".repeat(40)}`,
        origin: "reviewer-reported",
        outcome: "unknown",
      }));
      r.visual.pairs[0].label = "Long affected page name with retained evidence "
        .repeat(7)
        .slice(0, 300);
      api[`/api/qa-reports?repoId=mission-control&prNumber=1011&headSha=${r.headSha}`] = {
        reports: [r],
      };
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1280,
        height: 700,
        api,
      });
      await page.boxes("article.qa-report");
      expect(
        await page.evaluate(() => {
          const el = document.querySelector('[aria-label="Recorded test and command evidence"]');
          return (
            el?.getAttribute("tabindex") === "0" &&
            el.scrollHeight > el.clientHeight &&
            el.querySelectorAll("section").length === 50
          );
        }, null),
      ).toBe(true);
      expect(await page.unclipped("article.qa-report .panel")).not.toContain(false);
      await page.evaluate(() => {
        document.querySelector("article.qa-report .uat-pair")?.scrollIntoView();
        document
          .querySelector("article.qa-report .uat-pair img")
          ?.dispatchEvent(new Event("error"));
      }, null);
      const retries = await page.boxes("article.qa-report .uat-pair button");
      expect(retries.every((box) => box.height >= 24 && box.width >= 24)).toBe(true);
      expect(await page.unclipped("article.qa-report .uat-pair button")).not.toContain(false);
      expect(await page.reachable("article.qa-report .uat-pair button")).not.toContain(false);
      await page.close();

      r.headSha = "d".repeat(40);
      const stale = await renderAt({ page: "test/qaReadinessBrowser.html", width: 1280, api });
      await stale.boxes(".qa-report-current");
      expect(
        await stale.evaluate(() => document.querySelector(".qa-report-current")?.textContent, null),
      ).toContain("No accountable QA report is saved for this head");
      expect(
        await stale.evaluate(() => document.querySelectorAll("article.qa-report").length, null),
      ).toBe(0);
      await stale.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
