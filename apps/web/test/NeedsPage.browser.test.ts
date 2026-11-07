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
import { brief, HOUR, item, MIN, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;

const SHA = "a".repeat(40);
const PICTURE = `/api/prs/1453/evidence/${SHA}/needs-light-after.png`;
/** A 1600 x 1000 mockup, so a thumbnail and a large picture differ. */
const MOCKUP = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#e8eef9"/><rect x="40" y="40" width="440" height="920" fill="#c5d3ee"/><rect x="520" y="40" width="1040" height="120" fill="#9db4e0"/><text x="560" y="115" font-size="48" font-family="sans-serif">Proposed layout</text></svg>`;
const ASSETS = { [PICTURE]: { contentType: "image/svg+xml", body: MOCKUP } };

const KEY = "decision:layout";
const discussionPath = (key: string) => `/api/attention/${encodeURIComponent(key)}/discussion`;

const LONG = Array.from(
  { length: 9 },
  (_, i) => `Line ${i + 1} of a longer reply that explains the trade-off in some detail.`,
).join("\n");

function messages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    itemKey: KEY,
    correlationId: "d1",
    role: i % 2 ? "operator" : "flight",
    text: i % 5 === 0 ? LONG : `Message ${i + 1}: short and plain.`,
    at: NOW - (n - i) * MIN,
  }));
}

function api(n = 6, optionCount = 2, extraAsks = 0) {
  const asks = [
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
        original: `Here is the proposal.\n\n![Proposed layout](${PICTURE})\n\nSee the [spec](https://example.com/spec) too.`,
        assessment: "A list with the open item beside it keeps every ask one click away.",
        recommendation: "List and open item.",
        recommendedOptionId: "list",
        options: [
          { id: "list", label: "List and open item", answer: "Use the list and open item." },
          { id: "column", label: "One long column", answer: "Use one long column." },
          ...Array.from({ length: Math.max(0, optionCount - 2) }, (_, i) => ({
            id: `extra${i}`,
            label: `Another layout ${i + 1}`,
            answer: `Use another layout ${i + 1}.`,
            description:
              "A longer description of this option, so the card is more than one line. ".repeat(3),
          })),
        ],
      }),
    }),
    item({ key: "question:two", kind: "question", escalationId: null, text: "Second ask" }),
    item({ key: "question:three", kind: "question", escalationId: null, text: "Third ask" }),
    ...Array.from({ length: extraAsks }, (_, i) =>
      item({ key: `question:extra${i}`, kind: "question", escalationId: null, text: `Ask ${i}` }),
    ),
  ];
  const base = desktopFixture().api;
  const discussion = { id: "d1", itemKey: KEY, version: "v1", messages: messages(n) };
  return {
    ...base,
    "/api/attention": asks,
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    [discussionPath(KEY)]: discussion,
    [`${discussionPath(KEY)}?id=d1`]: discussion,
  };
}

async function ready(page: RenderedPage) {
  await page.boxes("#page-needs .needs-band");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
}

async function pictureLoaded(page: RenderedPage) {
  await page.boxes(".needs-frame img");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const img = document.querySelector(".needs-frame img") as HTMLImageElement;
        if (img.complete && img.naturalWidth) resolve();
        else img.addEventListener("load", () => resolve());
      }),
    undefined,
  );
}

describeRendered("Needs you page", () => {
  it(
    "the open item fills the width with the mockup shown large",
    async () => {
      for (const [width, height, minImage] of [
        [2560, 1200, 1100],
        [1920, 940, 850],
      ] as const) {
        const label = `${width}x${height}`;
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: api(),
          assets: ASSETS,
        });
        try {
          await ready(page);
          await pictureLoaded(page);
          const detail = await page.box(".needs-detail");
          // The edge is the FLIGHT fly-out's, which every page has, or the window's without one.
          const dock = await page.evaluate(
            () => document.querySelector<HTMLElement>("#dock")?.getBoundingClientRect().x ?? null,
            undefined,
          );
          expect(
            (dock ?? width) - (detail.x + detail.width),
            `${label}: detail reaches the right edge`,
          ).toBeLessThanOrEqual(32);
          const image = await page.box(".needs-frame img");
          expect(image.width, `${label}: the mockup is large`).toBeGreaterThanOrEqual(minImage);
          const band = await page.box(".needs-band");
          expect(
            band.y + band.height,
            `${label}: the band is on the first screen`,
          ).toBeLessThanOrEqual(height);
          const tab = await page.box(".tabs a.needs-tab b");
          expect(
            tab.y + tab.height,
            `${label}: the tab count is on the first screen`,
          ).toBeLessThanOrEqual(height);
          const scroll = await page.evaluate(
            () => document.documentElement.scrollHeight - innerHeight,
            undefined,
          );
          expect(scroll, `${label}: the page itself does not scroll`).toBeLessThanOrEqual(0);
          expect(await page.reachable(".needs-band")).toEqual([true]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "thirty messages stay readable and the question stays on screen",
    async () => {
      for (const [width, height] of [
        [2560, 1200],
        [1920, 940],
        [1600, 700],
      ] as const) {
        const label = `${width}x${height}`;
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: api(30),
          assets: ASSETS,
        });
        try {
          await ready(page);
          await page.boxes("#needsMsgs .dmsg");
          const before = await page.box(".needs-band");
          for (const to of ["top", "bottom"] as const) {
            await page.evaluate((where) => {
              const log = document.getElementById("needsMsgs") as HTMLElement;
              log.scrollTop = where === "top" ? 0 : log.scrollHeight;
            }, to);
            expect(
              await page.box(".needs-band"),
              `${label}: band after scrolling to ${to}`,
            ).toEqual(before);
          }
          if (width >= 1920) {
            const message = await page.box("#needsMsgs .dmsg");
            expect(
              message.width,
              `${label}: messages are wide enough to read`,
            ).toBeGreaterThanOrEqual(400);
          }
          expect(
            await page.reachable("#needsMsgs .dmsg:last-of-type"),
            `${label}: last message`,
          ).toEqual([true]);
          expect(
            await page.reachable("#needsDiscussionForm textarea"),
            `${label}: composer`,
          ).toEqual([true]);
          expect(before.height, `${label}: the band stays within its limit`).toBeLessThanOrEqual(
            136,
          );
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "four options show in full and the conversation keeps its height",
    async () => {
      for (const [width, height] of [
        [2560, 1200],
        [1920, 940],
      ] as const) {
        const label = `${width}x${height}`;
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: api(6, 4),
          assets: ASSETS,
        });
        try {
          await ready(page);
          const side = await page.box(".needs-side");
          const options = await page.boxes(".needs-answer .opt");
          expect(options).toHaveLength(4);
          const last = options[3] as { y: number; height: number };
          expect(
            last.y + last.height,
            `${label}: the last option is inside the side column`,
          ).toBeLessThanOrEqual(side.y + side.height);
          const log = await page.box("#needsMsgs");
          expect(
            log.height,
            `${label}: the conversation log is tall enough`,
          ).toBeGreaterThanOrEqual(280);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "the conversation composer fills its column and Hold keeps the question in view",
    async () => {
      for (const [width, height] of [
        [2560, 1440],
        [1920, 1080],
      ] as const) {
        const label = `${width}x${height}`;
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: api(),
          assets: ASSETS,
        });
        try {
          await ready(page);
          const composer = await page.box("#needsDiscussionForm");
          const area = await page.box("#needsDiscussionForm textarea");
          expect(
            area.width / composer.width,
            `${label}: the conversation textarea fills its row`,
          ).toBeGreaterThanOrEqual(0.9);
          const answer = await page.boxes(".needs-answer .composer textarea");
          expect(answer.length, `${label}: the answer composer is there`).toBeGreaterThan(0);
          if (SHOTS) {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot(join(SHOTS, `needs-${width}x${height}-hold-closed.png`));
          }
          await page.click(".needs-hold button");
          await page.boxes(".needs-hold .hold-form");
          const open = await page.evaluate(() => {
            const band = document.querySelector(".needs-band") as HTMLElement;
            const q = document.querySelector(".needs-band-question") as HTMLElement;
            const r = q.getBoundingClientRect();
            const b = band.getBoundingClientRect();
            return {
              bandClips: band.scrollHeight > band.clientHeight + 1,
              questionInside: r.top >= b.top && r.bottom <= b.bottom,
              questionLines: Math.round(
                r.height / Number.parseFloat(getComputedStyle(q).lineHeight),
              ),
              fullLines: Math.round(
                q.scrollHeight / Number.parseFloat(getComputedStyle(q).lineHeight),
              ),
              formInside:
                (
                  document.querySelector(".needs-hold .hold-form") as HTMLElement
                ).getBoundingClientRect().bottom <=
                b.bottom + 1,
              bottom: b.bottom,
            };
          }, undefined);
          expect(open.bandClips, `${label}: nothing in the band is cut off`).toBe(false);
          expect(open.questionInside, `${label}: the question sits inside the band`).toBe(true);
          expect(open.questionLines, `${label}: the whole question shows`).toBe(open.fullLines);
          expect(open.formInside, `${label}: the Hold form sits inside the band`).toBe(true);
          expect(open.bottom, `${label}: the open band leaves room below`).toBeLessThan(height / 2);
          if (SHOTS) await page.screenshot(join(SHOTS, `needs-${width}x${height}-hold-open.png`));
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "every nav tab is fully visible at 1280 with a two-digit Needs you count",
    async () => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1280,
        height: 900,
        api: api(6, 2, 34),
        assets: ASSETS,
      });
      try {
        await ready(page);
        const count = await page.evaluate(
          () => document.querySelector(".tabs a.needs-tab b")?.textContent ?? "",
          undefined,
        );
        expect(count).toBe("37");
        const clipped = await page.evaluate(() => {
          const tabs = document.querySelector(".tabs") as HTMLElement;
          const box = tabs.getBoundingClientRect();
          const status = document.querySelector(".top-status")?.getBoundingClientRect();
          return {
            scrolls: tabs.scrollWidth > tabs.clientWidth + 1,
            outside: [...tabs.querySelectorAll("a")]
              .filter((a) => {
                const r = a.getBoundingClientRect();
                return r.right > box.right + 1 || (status && r.right > status.left + 1);
              })
              .map((a) => a.textContent),
          };
        }, undefined);
        expect(clipped.scrolls, "the tabs need no sideways scroll").toBe(false);
        expect(clipped.outside, "no tab sits under the status readout").toEqual([]);
        if (SHOTS) await page.screenshot(join(SHOTS, "needs-1280x900-nav.png"));
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "captures the design views",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        for (const [width, height] of [
          [2560, 1200],
          [1920, 940],
        ] as const) {
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api(),
            assets: ASSETS,
          });
          try {
            await ready(page);
            await pictureLoaded(page);
            // populated: the question, the picture, the options and the conversation are all there
            await page.boxes(".needs-band-question");
            await page.boxes("#needsMsgs .dmsg");
            await page.boxes(".needs-row");
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `needs-${width}x${height}-${scheme}.png`));
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
