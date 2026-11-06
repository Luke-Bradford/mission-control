// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PAGE_PATHS } from "../src/router.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";

const { renderAt } = browserSession();
const HARNESS = "test/demoBrowser.html";
const SHOTS = process.env.MC_SHOT_DIR;

const open = (at: string, width = 1600, height = 900, colorScheme: "light" | "dark" = "light") =>
  renderAt({
    page: HARNESS,
    width,
    height,
    colorScheme,
    search: `?demo=1&at=${encodeURIComponent(at)}`,
  });

async function eventually(page: RenderedPage, read: () => Promise<boolean>, what: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (page.errors().length) throw new Error(page.errors().join("; "));
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The fly-out is on screen: not hidden, not folded to its rail, with a box that takes text. */
const flyOutOpen = (page: RenderedPage) =>
  page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>("#dock");
    const box = document.querySelector<HTMLTextAreaElement>("#dockInput");
    const rect = box?.getBoundingClientRect();
    return Boolean(
      dock &&
        !dock.hidden &&
        !dock.classList.contains("collapsed") &&
        box &&
        !box.disabled &&
        rect &&
        rect.width > 0 &&
        rect.height > 0,
    );
  }, null);

describeRendered("The FLIGHT fly-out in the production App", () => {
  const PATHS = Object.entries(PAGE_PATHS);
  it.each(PATHS)(
    "opens with f on %s",
    async (_name, path) => {
      const page = await open(path);
      await page.box("header");
      // Start folded, so the press has something to open (the choice is remembered per browser).
      if (await flyOutOpen(page)) await page.press("f");
      await eventually(page, async () => !(await flyOutOpen(page)), "the fly-out to close");
      await page.press("f");
      await eventually(page, () => flyOutOpen(page), `the fly-out to open on ${path}`);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  if (SHOTS) {
    it.each([
      [1280, 1000],
      [1600, 1000],
      [1920, 1000],
      [1600, 700],
      [2560, 1440],
    ])(
      "screenshots the fly-out at %i x %i",
      async (width, height) => {
        mkdirSync(SHOTS, { recursive: true });
        for (const theme of ["light", "dark"] as const)
          for (const [name, path] of [
            ["board", PAGE_PATHS.board],
            ["comms", PAGE_PATHS.comms],
            ["needs", PAGE_PATHS.needs],
            ["flight", PAGE_PATHS.flight],
          ] as const) {
            const page = await open(path, width, height, theme);
            await page.box("header");
            if (!(await flyOutOpen(page))) await page.press("f");
            await eventually(page, () => flyOutOpen(page), "the fly-out");
            await page.screenshot(join(SHOTS, `flyout-${name}-${width}x${height}-${theme}.png`));
          }
      },
      BROWSER_TEST_TIMEOUT_MS * 3,
    );
  }
});
