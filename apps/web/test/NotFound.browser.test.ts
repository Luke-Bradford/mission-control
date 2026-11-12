// @vitest-environment node
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";

const { renderAt } = browserSession();

describeRendered("Not-found page", () => {
  it(
    "gives every link a 24×24 px target, separate from its neighbours, with a visible keyboard focus",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1920,
          height: 940,
          colorScheme: scheme,
          search: "?path=/nope",
          api: desktopFixture().api,
        });
        try {
          await page.boxes("#page-not-found");
          const links = await page.boxes(".not-found-links a");
          expect(links.length).toBeGreaterThanOrEqual(3);
          for (const box of links) {
            expect(box.width).toBeGreaterThanOrEqual(24);
            expect(box.height).toBeGreaterThanOrEqual(24);
          }
          // 8 px or more of free space between neighbours (token spacing)
          for (let i = 1; i < links.length; i++) {
            const prev = links[i - 1] as { x: number; width: number };
            const gap = (links[i] as { x: number }).x - (prev.x + prev.width);
            expect(gap).toBeGreaterThanOrEqual(8);
          }
          // Reach the first link with Shift+Tab from the second, then Tab through the rest: each
          // takes focus in turn and shows an outline.
          await page.evaluate(() => {
            (document.querySelectorAll(".not-found-links a")[1] as HTMLElement).focus();
          }, undefined);
          await page.press("Shift+Tab");
          const seen: string[] = [];
          for (let i = 0; i < links.length; i++) {
            const state = await page.evaluate(() => {
              const el = document.activeElement as HTMLElement;
              const cs = getComputedStyle(el);
              return {
                text: el.textContent ?? "",
                inNav: !!el.closest(".not-found-links"),
                outline: cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) >= 2,
              };
            }, undefined);
            expect(state.inNav).toBe(true);
            expect(state.outline).toBe(true);
            seen.push(state.text);
            await page.press("Tab");
          }
          expect(new Set(seen).size).toBe(links.length);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
