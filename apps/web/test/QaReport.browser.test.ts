// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { qaReportApi, qaReportAssets, qaReportFixture } from "./qaReportFixture.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "qa-report-shots");

describeRendered("Accountable QA report", () => {
  it.each(["light", "dark"] as const)(
    "keeps image-error and retry controls focused in the real shell, %s",
    async (colorScheme) => {
      const report = qaReportFixture();
      const shots = process.env.MC_QA_IMAGE_FOCUS_SHOTS ?? SHOTS;
      mkdirSync(shots, { recursive: true });
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 700,
        colorScheme,
        search: `?path=${encodeURIComponent(report.permalink)}`,
        api: { ...desktopFixture().api, ...qaReportApi(0) },
        assets: {
          ...qaReportAssets(),
          "https://evidence.example/forced-error.png": {
            status: 404,
            contentType: "text/plain",
            body: "Controlled image failure",
          },
        },
      });
      try {
        await page.boxes("article.qa-report");
        expect(
          await page.evaluate(async () => {
            await document.fonts.ready;
            const images = [...document.querySelectorAll<HTMLImageElement>(".uat-shots img")];
            for (const image of images) image.loading = "eager";
            const start = performance.now();
            while (
              images.some((image) => !image.complete || image.naturalWidth === 0) &&
              performance.now() - start < 1000
            )
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            return (
              images.length === 2 &&
              images.every((image) => image.complete && image.naturalWidth > 0)
            );
          }, null),
        ).toBe(true);
        await page.evaluate(() => {
          document.querySelector<HTMLAnchorElement>(".uat-shots figure a")?.focus();
        }, null);
        await page.screenshot(join(shots, `qa-image-${colorScheme}-preview-focus.png`));
        await page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>(".uat-shots figure img");
          if (!image) throw new Error("Preview is missing");
          image.src = "https://evidence.example/forced-error.png";
        }, null);
        const failed = await page.evaluate(async () => {
          const figure = document.querySelector(".uat-shots figure");
          const start = performance.now();
          while (
            !figure?.textContent?.includes("The linked image could not be loaded.") &&
            performance.now() - start < 1000
          )
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const source = figure?.querySelector<HTMLAnchorElement>("a");
          return {
            failed: figure?.textContent?.includes("The linked image could not be loaded."),
            focused: document.activeElement === source,
            href: source?.href,
          };
        }, null);
        await page.screenshot(join(shots, `qa-image-${colorScheme}-error-source-focus.png`));
        expect(failed).toEqual({
          failed: true,
          focused: true,
          href: "https://evidence.example/before.png",
        });
        await page.press("Tab");
        expect(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label"), null),
        ).toContain("Retry linked image");
        await page.press("Enter");
        expect(
          await page.evaluate(async () => {
            const start = performance.now();
            let image: HTMLImageElement | null;
            do {
              image = document.querySelector<HTMLImageElement>(".uat-shots figure img");
              if (image?.complete && image.naturalWidth > 0) break;
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            } while (performance.now() - start < 1000);
            return (
              !!image && image.naturalWidth > 0 && document.activeElement === image.closest("a")
            );
          }, null),
        ).toBe(true);
        await page.screenshot(join(shots, `qa-image-${colorScheme}-retry-preview-focus.png`));
        expect(page.errors()).toEqual([]);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
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
            assets: qaReportAssets(),
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
        assets: qaReportAssets(),
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
        assets: qaReportAssets(),
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
