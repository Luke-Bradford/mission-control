// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "map-shots");
const WIDTHS = [1366, 1600, 1920] as const;
/** The HUD's smallest type token, `--fs-micro`. */
const SMALLEST_PX = 11;

describeRendered("Map in a browser", () => {
  it.each(WIDTHS)(
    "keeps every Map text at the smallest type token or above, marks a conflict, and shows tile focus, at %i in light and dark",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/mapBrowser.html",
          width,
          height: 900,
          colorScheme,
        });
        await page.boxes(".map-treemap-tile");
        const small = await page.evaluate((min) => {
          const out: string[] = [];
          for (const el of document.querySelectorAll(
            ".map-timeline *, .map-treemap *, .map-changes-key *, .map-seats *",
          )) {
            if (!el.textContent?.trim()) continue;
            if (parseFloat(getComputedStyle(el).fontSize) < min) out.push(el.className.toString());
          }
          return out;
        }, SMALLEST_PX);
        expect(small, `${colorScheme} ${width}`).toEqual([]);
        // the conflicting tile is outlined flat, says "conflict" inside its own box, and its seat
        // row carries the count; the key names the pair
        const conflict = await page.evaluate(() => {
          const tile = document.querySelector<HTMLElement>(".map-treemap-tile[data-conflict]");
          const badge = tile?.querySelector<HTMLElement>(".map-treemap-badge");
          if (!tile || !badge) return null;
          const t = tile.getBoundingClientRect();
          const b = badge.getBoundingClientRect();
          return {
            inside:
              b.left >= t.left && b.right <= t.right && b.top >= t.top && b.bottom <= t.bottom,
            outline: getComputedStyle(tile).outlineStyle,
            shadow: getComputedStyle(tile).boxShadow,
            opacity: getComputedStyle(tile).opacity,
            seat: document.querySelector(".map-seat-conflict")?.textContent ?? "",
            key: document.querySelector(".map-changes-key")?.textContent ?? "",
          };
        }, null);
        expect(conflict, `${colorScheme} ${width}`).not.toBeNull();
        expect(conflict?.inside).toBe(true);
        expect(conflict?.outline).toBe("solid");
        expect(conflict?.shadow).toBe("none");
        expect(conflict?.opacity).toBe("1");
        expect(conflict?.seat).toBe("1 conflict");
        expect(conflict?.key).toContain("1 file conflicts between open branches");
        await page.screenshot(join(SHOTS, `map-changes-${colorScheme}-${width}.png`));
        const outline = await page.evaluate((selector) => {
          const tile = document.querySelector(selector) as HTMLElement;
          tile.focus();
          return getComputedStyle(tile).outlineStyle;
        }, ".map-treemap-tile");
        expect(outline).not.toBe("none");
      }
    },
    60_000,
  );

  it("selects a window when a timeline tick is clicked with the mouse", async () => {
    const page = await renderAt({ page: "test/mapBrowser.html", width: 1600, height: 900 });
    await page.boxes(".map-timeline-tick");
    await page.click(".map-timeline-tick");
    expect(await page.evaluate(() => window.location.hash, null)).toMatch(/^#win=/);
  });
});
