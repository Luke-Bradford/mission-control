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
import { boundBrief, brief, HOUR, item, MIN, NOW } from "./fixtures.ts";

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
      offers: ["not-now", "drop"],
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
    "/api/attention/answered": [],
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
    "shows every word of an answered question at the requested evidence sizes",
    async () => {
      const question = `${"Which cache should we use when the deployment queue contains a long sequence of related changes that need the operator to see every condition before accepting the recommendation? ".repeat(2)}End.`;
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
      ] as const) {
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: {
            ...api(),
            "/api/attention/answered": [
              {
                key: "ask:long",
                askAt: NOW - HOUR,
                kind: "withdrawn",
                reason: "FLIGHT withdrew this question.",
                by: "flight-1",
                question,
                ticket: "shop-app#1453",
                operator: true,
                at: NOW - MIN,
              },
            ],
          },
          assets: ASSETS,
        });
        try {
          await ready(page);
          await page.click(".needs-list summary");
          expect(
            await page.evaluate(
              () => document.querySelector(".needs-answered")?.textContent ?? "",
              undefined,
            ),
          ).toContain(question);
          expect(await page.reachable(".needs-answered", ".needs-list")).toEqual([true]);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "Clear stays beside the offered actions at the requested light and dark evidence sizes",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
      ] as const) {
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme,
            api: api(),
            assets: ASSETS,
          });
          try {
            await ready(page);
            expect(await page.reachable(".needs-band")).toEqual([true]);
            expect(await page.reachable(".needs-actions")).toEqual([true]);
            expect(
              await page.evaluate(
                () =>
                  [...document.querySelectorAll(".needs-actions button")].map(
                    (button) => button.textContent,
                  ),
                undefined,
              ),
            ).toEqual(["Not now", "Drop", "Clear"]);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `needs-${width}x${height}-${colorScheme}.png`));
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "the open item fills the width with the mockup shown large",
    async () => {
      for (const [width, height, minImage] of [
        [2560, 1200, 1300],
        [1920, 940, 900],
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
          expect(
            width - (detail.x + detail.width),
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
    "the conversation composer fills its column and offered actions keep the question in view",
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
            await page.screenshot(join(SHOTS, `needs-${width}x${height}-actions.png`));
          }
          const open = await page.evaluate(() => {
            const band = document.querySelector(".needs-band") as HTMLElement;
            const q = document.querySelector(".needs-band-title") as HTMLElement;
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
              actionsInside:
                (document.querySelector(".needs-actions") as HTMLElement).getBoundingClientRect()
                  .bottom <=
                b.bottom + 1,
              bottom: b.bottom,
            };
          }, undefined);
          expect(open.bandClips, `${label}: nothing in the band is cut off`).toBe(false);
          expect(open.questionInside, `${label}: the question sits inside the band`).toBe(true);
          expect(open.questionLines, `${label}: the whole question shows`).toBe(open.fullLines);
          expect(open.actionsInside, `${label}: actions sit inside the band`).toBe(true);
          expect(open.bottom, `${label}: the open band leaves room below`).toBeLessThan(height / 2);
          if (SHOTS)
            await page.screenshot(join(SHOTS, `needs-${width}x${height}-actions-open.png`));
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
            await page.boxes(".needs-band-title");
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

/** Fields of the stress state: 8,000 characters, and ids and labels with no break opportunity. */
const HUGE = "w".repeat(8000);
const LONG_ID = "option-".concat("x".repeat(120));

/**
 * The same open ask, with the server's complete bound brief and `optionCount` options. `asks` is
 * how many asks wait (0, 3, 50…); `stress` fills the fields to their 8,000-character limit.
 */
function boundApi(optionCount: number, stress = false, asks = 3) {
  const base = api();
  const all = base["/api/attention"];
  const options = Array.from({ length: optionCount }, (_, i) => ({
    id: i === 0 ? "list" : stress ? `${LONG_ID}-${i}` : `option-${i}`,
    label:
      i === 0
        ? "List and open item"
        : stress
          ? `Another-${"y".repeat(100)}`
          : `Another layout ${i}`,
    answer: `Use layout ${i}.`,
    consequence: stress ? HUGE : `Layout ${i} is used from the next release.`,
    reversibility: {
      kind: "reversible" as const,
      detail: stress ? HUGE : "Switch back at any time.",
    },
    action: { kind: "answer" as const, seatId: "guido-1", runId: "r1", text: `Use layout ${i}.` },
  }));
  const first = all[0];
  const filler = Array.from({ length: Math.max(0, asks - 1) }, (_, i) =>
    item({ key: `question:fill${i}`, kind: "question", escalationId: null, text: `Ask ${i}` }),
  );
  return {
    ...base,
    "/api/attention":
      asks === 0
        ? []
        : [
            {
              ...first,
              brief: boundBrief({ ...first.brief, options, recommendedOptionId: "list" }),
            },
            ...filler,
          ],
  };
}

describeRendered("Needs you page, a complete bound brief", () => {
  it(
    "keeps the whole comparison inside the card and the actions reachable",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        for (const [width, height, options, long] of [
          [1280, 900, 2, false],
          [1600, 900, 4, false],
          [1920, 940, 2, false],
          [1600, 700, 4, true],
        ] as const) {
          const label = `${width}x${height} ${scheme} ${options} options`;
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: boundApi(options, long),
            assets: ASSETS,
          });
          try {
            await ready(page);
            const card = await page.box(".bc");
            const rows = await page.boxes(".bc-option");
            expect(rows, `${label}: every option is shown`).toHaveLength(options);
            for (const row of rows)
              expect(
                row.x >= card.x - 1 && row.x + row.width <= card.x + card.width + 1,
                `${label}: an option sits inside the card`,
              ).toBe(true);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - innerWidth,
              undefined,
            );
            expect(overflow, `${label}: no sideways page scroll`).toBeLessThanOrEqual(0);
            expect(
              await page.reachable(".bc-actions button.primary"),
              `${label}: Accept is reachable`,
            ).toEqual([true]);
            expect(await page.reachable(".bc-actions button:not(.primary)")).toEqual([true]);
            expect(card.width, `${label}: the card is not squeezed`).toBeGreaterThanOrEqual(480);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `needs-bound-${width}x${height}-${scheme}.png`));
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});

describeRendered("Needs you page, bound brief stress and keyboard", () => {
  it(
    "shows an empty page with no card when nothing waits",
    async () => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 900,
        api: boundApi(2, false, 0),
        assets: ASSETS,
      });
      try {
        await page.boxes("#page-needs");
        expect(await page.evaluate(() => document.querySelectorAll(".bc").length, undefined)).toBe(
          0,
        );
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps three and fifty asks, and 8,000-character fields, inside the card with the last action reachable by keyboard",
    async () => {
      for (const [asks, stress, width, height] of [
        [3, false, 1600, 900],
        [50, false, 1280, 900],
        [3, true, 1600, 700],
        [3, true, 1280, 900],
      ] as const) {
        const label = `${asks} asks, ${stress ? "stress" : "normal"} at ${width}x${height}`;
        const page = await renderAt({
          page: "test/needsBrowser.html",
          width,
          height,
          api: boundApi(4, stress, asks),
          assets: ASSETS,
        });
        try {
          await ready(page);
          const card = await page.box(".bc");
          const rows = await page.boxes(".bc-option");
          expect(rows, `${label}: all four options`).toHaveLength(4);
          for (const row of rows)
            expect(
              row.x >= card.x - 1 && row.x + row.width <= card.x + card.width + 1,
              `${label}: an option sits inside the card`,
            ).toBe(true);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth - innerWidth, undefined),
            `${label}: no sideways page scroll`,
          ).toBeLessThanOrEqual(0);
          // Tab from the first radio through the rest of the card to Accept.
          await page.evaluate(() => {
            (document.querySelector(".bc-option input[type=radio]") as HTMLElement).focus();
          }, undefined);
          const seen: string[] = [];
          for (let i = 0; i < 12; i++) {
            await page.press("Tab");
            seen.push(
              await page.evaluate(() => {
                const a = document.activeElement as HTMLElement | null;
                return a?.closest(".bc-actions")
                  ? `action:${a.textContent?.slice(0, 20)}`
                  : (a?.tagName ?? "");
              }, undefined),
            );
          }
          expect(
            seen.some((name) => name.startsWith("action:Accept")),
            `${label}: Tab reaches Accept (${seen.join(",")})`,
          ).toBe(true);
          expect(await page.reachable(".bc-option:last-of-type")).toEqual([true]);
          expect(await page.reachable(".bc-actions button.primary")).toEqual([true]);
          const focusedInView = await page.evaluate(() => {
            const el = document.querySelector(".bc-actions button.primary") as HTMLElement;
            el.focus();
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight + 1;
          }, undefined);
          expect(focusedInView, `${label}: focused Accept is painted in the viewport`).toBe(true);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
