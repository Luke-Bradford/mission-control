// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

const TABS = ["crew", "cost", "throughput", "quality", "machine"] as const;
const THEMES = ["dark", "light"] as const;
const SIZES = [
  [1280, 900],
  [1600, 1000],
  [1920, 940],
] as const;

describeRendered("Telemetry mockup in a browser", () => {
  it(
    "fits every tab at each width and theme",
    async () => {
      for (const [width, height] of SIZES) {
        for (const theme of THEMES) {
          for (const tab of TABS) {
            const where = `${tab} ${theme} ${width}x${height}`;
            const page = await renderAt({
              page: "test/telemetryMockupBrowser.html",
              search: `?tab=${tab}&theme=${theme}`,
              width,
              height,
              colorScheme: theme,
            });
            await page.box(".panel");
            const result = await page.evaluate(() => {
              const root = document.documentElement;
              const clipped: string[] = [];
              for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
                const box = panel.getBoundingClientRect();
                if (panel.scrollHeight > panel.clientHeight + 1)
                  clipped.push(`${panel.dataset.panel} tall`);
                if (panel.scrollWidth > panel.clientWidth + 1)
                  clipped.push(`${panel.dataset.panel} wide`);
                for (const el of panel.querySelectorAll<HTMLElement>("*")) {
                  if (el.closest("[data-scroll]") && !el.matches("[data-scroll]")) continue;
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 && r.height === 0) continue;
                  if (r.right > box.right + 1 || r.bottom > box.bottom + 1)
                    clipped.push(`${panel.dataset.panel} ${el.className}`);
                }
                for (const s of panel.querySelectorAll<HTMLElement>("[data-scroll]")) {
                  const r = s.getBoundingClientRect();
                  if (r.height < 40 || r.width < 80)
                    clipped.push(`${panel.dataset.panel} scroller tiny`);
                }
              }
              const band = document.querySelector<HTMLElement>(".band");
              const tiles = [...document.querySelectorAll<HTMLElement>(".band .stat")];
              return {
                clipped,
                overflowX: root.scrollWidth - root.clientWidth,
                height: root.scrollHeight,
                bandHeight: band?.getBoundingClientRect().height ?? 0,
                tileMin: Math.min(...tiles.map((t) => t.getBoundingClientRect().width)),
                tilesClipped: tiles.filter((t) => t.scrollHeight > t.clientHeight + 1).length,
                theme: root.getAttribute("data-theme"),
              };
            }, null);
            expect(page.errors(), where).toEqual([]);
            expect(result.clipped, where).toEqual([]);
            expect(result.overflowX, where).toBeLessThanOrEqual(0);
            expect(result.theme, where).toBe(theme);
            expect(result.bandHeight, where).toBeLessThanOrEqual(96);
            expect(result.tilesClipped, where).toBe(0);
            expect(result.tileMin, where).toBeGreaterThanOrEqual(width >= 1600 ? 180 : 140);
            if (width === 1600 && height === 1000)
              expect(result.height, where).toBeLessThanOrEqual(1000);
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "scrolls instead of clipping at 1600x700",
    async () => {
      const page = await renderAt({
        page: "test/telemetryMockupBrowser.html",
        search: "?tab=cost",
        width: 1600,
        height: 700,
      });
      await page.box(".panel");
      const result = await page.evaluate(() => {
        const root = document.documentElement;
        const last = [...document.querySelectorAll<HTMLElement>(".panel")].pop();
        return {
          scrolls: root.scrollHeight > root.clientHeight,
          clipped: last ? last.scrollHeight > last.clientHeight + 1 : true,
        };
      }, null);
      expect(result).toEqual({ scrolls: true, clipped: false });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "draws each state at 1600x1000 without errors",
    async () => {
      for (const state of ["loading", "empty", "error", "stale", "disconnected"]) {
        const page = await renderAt({
          page: "test/telemetryMockupBrowser.html",
          search: `?tab=crew&theme=dark&state=${state}`,
          width: 1600,
          height: 1000,
        });
        await page.box(".grid");
        expect(page.errors(), state).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight, null),
          state,
        ).toBeLessThanOrEqual(1000);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
