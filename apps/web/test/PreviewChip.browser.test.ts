// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const WIDTHS = [1280, 1600, 1920] as const;

describeRendered("Preview chips on Board and Agent", () => {
  it.each(WIDTHS)(
    "do not wrap or clip at %i in light and dark",
    async (width) => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/previewChipBrowser.html",
          width,
          height: 700,
          colorScheme,
          search: "?state=preview",
          api: { "/api/config": { repos: [] } },
        });
        const chips = await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>("[data-surface] .rpr")].map((chip) => ({
              lines: Math.round(
                chip.getBoundingClientRect().height / parseFloat(getComputedStyle(chip).lineHeight),
              ),
              clipped: chip.scrollWidth > chip.clientWidth + 1,
            })),
          null,
        );
        expect(chips).toHaveLength(2);
        expect(chips.every((chip) => chip.lines === 1 && !chip.clipped)).toBe(true);
        expect((await page.unclipped("[data-surface] .rpr")).every(Boolean)).toBe(true);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );

  it(
    "starts a real Board card preview without leaving the screen",
    async () => {
      const page = await renderAt({
        page: "test/previewChipBrowser.html",
        width: 1280,
        height: 700,
        api: {
          "/api/config": { repos: [] },
          "/api/previews": {
            pr: 1174,
            branch: "feature/1174-web-the-pr-chip",
            port: 5175,
            url: "http://127.0.0.1:5175",
            startedAt: 1,
          },
        },
      });
      await page.click("[data-surface=board] .preview-start");
      await page.box("[data-surface=board] .preview-link");
      const state = await page.evaluate(
        () => ({
          path: window.location.pathname,
          href: document.querySelector<HTMLAnchorElement>("[data-surface=board] .preview-link")
            ?.href,
        }),
        null,
      );
      expect(state.path).toBe("/test/previewChipBrowser.html");
      expect(state.href).toBe("http://127.0.0.1:5175/");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
