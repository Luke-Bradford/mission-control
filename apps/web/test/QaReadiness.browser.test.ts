// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { qaAcceptanceFixture } from "./qaAcceptanceFixture.ts";

const SHOTS = join(process.env.TMPDIR ?? "/tmp", "qa-acceptance-shots");
const { renderAt } = browserSession();
const fixture = qaAcceptanceFixture;
describeRendered("QA acceptance queue in a browser", () => {
  it(
    "keeps a long queue scrollable without clipping its titles",
    async () => {
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1366,
        height: 1000,
        colorScheme: "dark",
        api: fixture(50),
      });
      const rows = await page.boxes(".uat-queue-row");
      expect(rows).toHaveLength(54);
      expect(await page.unclipped(".uat-queue-row")).not.toContain(false);
      expect(
        await page.evaluate(() => {
          const list = document.querySelector(".uat-queue-group ul");
          return !!list && list.scrollHeight > list.clientHeight;
        }, null),
      ).toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it.each(
    [1366, 1600, 1920].flatMap((width) =>
      ["light", "dark"].map((theme) => ({ width, theme: theme as "light" | "dark" })),
    ),
  )(
    "fits the approved layout at $width in $theme",
    async ({ width, theme }) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width,
        height: 1000,
        colorScheme: theme,
        api: fixture(),
      });
      await page.boxes(".uat-pair");
      // Fixture artwork stands in for the captured page. Production images come from the PNG route.
      await page.evaluate(() => {
        for (const image of document.querySelectorAll<HTMLImageElement>(".uat-shots img")) {
          const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#131a23"/><rect x="40" y="40" width="900" height="40" fill="#2a3646"/><rect x="40" y="130" width="460" height="800" fill="#0c1117"/><rect x="540" y="130" width="460" height="800" fill="#0c1117"/><rect x="1040" y="130" width="460" height="800" fill="#174f48"/></svg>';
          image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        }
      }, null);
      expect(await page.unclipped("#page-qa-readiness")).toEqual([true]);
      expect(await page.unclipped(".uat-detail .panel")).not.toContain(false);
      expect(await page.reachable(".uat-ask")).toEqual([true]);
      const columns = await page.evaluate(() => {
        const queue = document.querySelector(".uat-queue")?.getBoundingClientRect();
        const detail = document.querySelector(".uat-detail")?.getBoundingClientRect();
        return queue && detail ? queue.right < detail.left : false;
      }, null);
      expect(columns).toBe(true);
      await page.screenshot(join(SHOTS, `qa-uat-${width}-${theme}.png`));
      await page.click(".uat-actions .uat-send");
      expect(await page.unclipped(".uat-send-form")).toEqual([true]);
      await page.screenshot(join(SHOTS, `qa-uat-send-back-${width}-${theme}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it.each(["light", "dark"] as const)(
    "shows what a merge frees at 1920x1080 in %s",
    async (theme) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1920,
        height: 1080,
        colorScheme: theme,
        api: fixture(),
      });
      await page.boxes(".uat-frees h3");
      const text = await page.evaluate(
        () => ({
          line: document.querySelector(".uat-frees h3")?.textContent,
          more: document.querySelector(".uat-frees-more")?.textContent,
          refs: [...document.querySelectorAll(".uat-frees li")].length,
          mark: document.querySelector(".uat-queue-row .uat-age")?.textContent,
        }),
        null,
      );
      expect(text.line).toBe("Merging this frees 7");
      expect(text.more).toBe("2 more also wait on other work");
      expect(text.refs).toBe(6);
      expect(text.mark).toMatch(/^unblocks 7 · /);
      expect(await page.unclipped(".uat-frees")).not.toContain(false);
      await page.screenshot(join(SHOTS, `qa-frees-${theme}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "shows an honest empty queue",
    async () => {
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: "light",
        api: fixture(0),
      });
      await page.boxes(".uat-empty");
      const rows = await page.evaluate(() => {
        const title = document.querySelector(".uat-title")?.getBoundingClientRect();
        const layout = document.querySelector(".uat-layout")?.getBoundingClientRect();
        return title && layout ? { title: title.height, gap: layout.top - title.bottom } : null;
      }, null);
      expect(rows?.gap).toBeLessThan(24);
      expect(
        await page.evaluate(
          () => document.body.textContent?.includes("Nothing is waiting for you"),
          null,
        ),
      ).toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
