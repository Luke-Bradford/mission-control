// @vitest-environment node
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { brief, HOUR, item, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;

const KEY = "decision:layout";
const discussion = { id: "d1", itemKey: KEY, version: "v1", messages: [] };
const PREVIEW = {
  ticket: 1453,
  repoId: "shop-app",
  branch: "feature/1453-needs",
  sha: "a".repeat(40),
  publishedAt: NOW - HOUR,
  pr: 1465,
  running: true,
  url: "http://127.0.0.1:7440/",
};

function api() {
  return {
    ...desktopFixture().api,
    "/api/attention": [
      item({
        key: KEY,
        kind: "decision",
        agentId: "guido-1",
        escalationId: null,
        ticket: "shop-app#1453",
        text: "Which layout should the Needs you page use?",
        at: NOW - 2 * HOUR,
        brief: brief({
          ask: "Which layout should the Needs you page use: a list and the open item, or one long column?",
          recommendedOptionId: "list",
          options: [{ id: "list", label: "List and open item", answer: "Use the list." }],
        }),
      }),
    ],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/design-previews": [PREVIEW],
    "/api/design-previews/1453/open": PREVIEW,
    [`/api/attention/${encodeURIComponent(KEY)}/discussion`]: discussion,
    [`/api/attention/${encodeURIComponent(KEY)}/discussion?id=d1`]: discussion,
  };
}

describeRendered("Branch preview over Needs you", () => {
  it(
    "fills the window under a 40 px bar at true width, in both themes",
    async () => {
      for (const [width, height] of [
        [1920, 940],
        [2560, 1145],
      ] as const) {
        for (const colorScheme of ["light", "dark"] as const) {
          const label = `${width}x${height} ${colorScheme}`;
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme,
            api: api(),
          });
          try {
            await page.boxes(".preview-open button");
            await page.click(".preview-open button");
            const frame = await page.box(".preview-frame");
            expect(frame, `${label}: the overlay is the window`).toEqual({
              x: 0,
              y: 0,
              width,
              height,
            });
            const bar = await page.box(".preview-bar");
            expect(bar.height, `${label}: the bar is 40 px`).toBe(40);
            expect(bar.width).toBe(width);
            const iframe = await page.box(".preview-iframe");
            expect(iframe, `${label}: the app gets all the width`).toEqual({
              x: 0,
              y: 40,
              width,
              height: height - 40,
            });
            const inner = await page.evaluate(
              () => document.querySelector<HTMLIFrameElement>(".preview-iframe")?.clientWidth,
              undefined,
            );
            expect(inner, `${label}: the frame's viewport is the window's`).toBe(width);
            expect(await page.reachable(".preview-bar a, .preview-bar button")).toEqual([
              true,
              true,
            ]);
            const question = await page.box(".preview-question");
            expect(question.width, `${label}: the question has room`).toBeGreaterThan(400);
            if (SHOTS) await page.screenshot(`${SHOTS}/preview-${label.replace(" ", "-")}.png`);
            await page.press("Escape");
            expect(
              await page.evaluate(
                () => document.querySelectorAll(".preview-frame").length,
                undefined,
              ),
              `${label}: Esc closes it`,
            ).toBe(0);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
