// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, seatRow } from "./fixtures.ts";
import { REVIEWER } from "./reviewDisplayFixture.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_REVIEW_DISPLAY_SHOTS;
const api = {
  "/api/config": CONFIG,
  "/api/crew/changes": { sessions: [{ id: "s1", seats: [{ id: "guido-1" }] }] },
  "/api/crew?shape=summary": {
    rows: [
      REVIEWER,
      seatRow({ id: "retro-1", role: "RETRO", mode: "scratch", run: null, hudState: "idle" }),
    ],
    firstRunToday: null,
  },
  "/api/crew/status": { enabled: true, note: null },
  "/api/attention": [],
  "/api/limits": [],
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/repos/shop-app/prs?linked=1&shape=summary": [],
};
describeRendered("Review state across the HUD", () => {
  it.each([
    ...[1280, 1600, 1920].flatMap((width) =>
      ["light", "dark"].map((theme) => ({ width, height: 1000, theme: theme as "light" | "dark" })),
    ),
    ...["light", "dark"].map((theme) => ({
      width: 1600,
      height: 700,
      theme: theme as "light" | "dark",
    })),
  ])(
    "fits $width in $theme",
    async ({ width, height, theme }) => {
      const page = await renderAt({
        page: "test/reviewDisplayBrowser.html",
        width,
        height,
        colorScheme: theme,
        api,
      });
      await page.boxes(".review-display-cases [data-kind]");
      expect(await page.reachable("#ahead, .review-display-cases")).not.toContain(false);
      for (const box of await page.boxes("#ahead, .review-display-cases")) {
        expect(box.height).toBeGreaterThan(0);
      }
      expect(
        await page.unclipped(".idrow, .review-display-cases, .kcard, .header-review-state"),
      ).not.toContain(false);
      expect(
        await page.evaluate(() => {
          const row = [...document.querySelectorAll<HTMLElement>(".trow")].find((r) =>
            r.textContent?.includes("retro-cx"),
          );
          return (
            !!row &&
            row.textContent?.includes("Checking PR #1039") &&
            !row.querySelector(".ticket-cell")?.textContent?.includes("last ") &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }, null),
      ).toBe(true);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot(
          join(shots, `review-${width}${height === 700 ? "x700" : ""}-${theme}.png`),
        );
        await page.evaluate(
          () => document.querySelector(".review-display-cases")?.scrollIntoView({ block: "end" }),
          null,
        );
        await page.screenshot(join(shots, `review-${width}-${height}-${theme}-cards.png`));
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
