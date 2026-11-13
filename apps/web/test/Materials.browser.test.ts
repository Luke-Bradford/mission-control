// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import {
  assetUrl,
  MAT_KEY,
  mockPng,
  planBody,
  storyItem,
  storyPacket,
} from "./materialsFixture.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;

function api(extra: number) {
  const base = desktopFixture().api;
  const discussion = { id: "d1", itemKey: MAT_KEY, version: "v1", messages: [] };
  const path = `/api/attention/${encodeURIComponent(MAT_KEY)}`;
  return {
    ...base,
    "/api/attention": [storyItem()],
    "/api/attention/answered": [],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    [`${path}/discussion`]: discussion,
    [`${path}/discussion?id=d1`]: discussion,
    [`${path}/materials`]: { packets: [storyPacket(extra)] },
    "/api/tickets/shop-app/1513": {
      repoId: "shop-app",
      number: 1513,
      url: "https://github.com/octo-org/shop-app/issues/1513",
      title: "Needs you layout",
      state: "open",
      status: null,
      priority: null,
      size: null,
      labels: [],
      outcome: null,
      doneWhen: [],
      body: planBody,
      bodyTruncated: false,
      githubError: null,
      runs: [],
      prs: [],
      questions: [],
    },
  };
}

const assets = (n: number) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      assetUrl(i + 1),
      { contentType: "image/png", body: mockPng(20 + i * 40) },
    ]),
  );

/** Waits for the story and every picture it shows (`pictures` thumbnails) to be on screen. */
async function ready(page: RenderedPage, pictures: number) {
  await page.boxes(".mat-section");
  const loaded = await page.evaluate(async (want) => {
    await document.fonts.ready;
    for (let i = 0; i < 100; i++) {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(".mat-thumb-img")];
      if (imgs.length >= want && imgs.every((img) => img.complete && img.naturalWidth > 0)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return document.querySelectorAll(".mat-thumb-img").length;
  }, pictures);
  expect(loaded).toBeGreaterThanOrEqual(pictures);
  if (page.errors().length) throw new Error(page.errors().join("; "));
}

describeRendered("Plan and mockups in the question", () => {
  it(
    "tells the story nested, compares side by side at one scale and never scrolls the page sideways",
    async () => {
      for (const [width, height] of [
        [1920, 940],
        [2560, 1145],
        [1600, 700],
        [1280, 900],
      ] as const) {
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme,
            api: api(10),
            assets: assets(17),
          });
          try {
            await ready(page, 16);
            const sideways = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              undefined,
            );
            expect(sideways).toBeLessThanOrEqual(0);
            const headings = await page.boxes(".mat-heading");
            const parent = headings[0] as { x: number };
            const child = (await page.boxes("[data-depth='1'] > .mat-heading"))[0] as { x: number };
            const grand = (await page.boxes("[data-depth='2'] > .mat-heading"))[0] as { x: number };
            expect(child.x).toBeGreaterThan(parent.x);
            expect(grand.x).toBeGreaterThan(child.x);
            const pair = await page.boxes("[data-comparison='before-after'] .mat-thumb");
            expect(pair).toHaveLength(2);
            const [left, right] = pair as { x: number; y: number; width: number }[];
            expect(Math.abs((left?.y ?? 0) - (right?.y ?? 1))).toBeLessThan(2);
            expect(Math.abs((left?.width ?? 0) - (right?.width ?? 1))).toBeLessThan(2);
            expect((right?.x ?? 0) > (left?.x ?? 0) + (left?.width ?? 0) - 1).toBe(true);
            // a long story scrolls inside the panel: its last section and the options stay reachable
            expect(await page.reachable(".mat-packet > .mat-section:last-of-type")).toEqual([true]);
            expect((await page.reachable(".mat-plan"))[0]).toBe(true);
            expect(await page.reachable(".opt")).toEqual([true, true]);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `story-${width}x${height}-${colorScheme}.png`));
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "opens a picture full size and steps with the arrow keys inside the window",
    async () => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 700,
        api: api(0),
        assets: assets(7),
      });
      try {
        await ready(page, 6);
        await page.click("[data-comparison='before-after'] .mat-thumb");
        await page.boxes(".mat-viewer-img");
        await page.press("ArrowRight");
        const title = await page.evaluate(
          () => document.querySelector(".mat-viewer-title")?.textContent,
          undefined,
        );
        expect(title).toBe("After");
        const viewer = await page.box(".mat-viewer");
        expect(viewer.width).toBe(1600);
        expect(await page.reachable(".mat-viewer-frame")).toEqual([true]);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
