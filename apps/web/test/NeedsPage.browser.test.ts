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

const LONG = Array.from(
  { length: 9 },
  (_, i) => `Line ${i + 1} of a longer reply that explains the trade-off in some detail.`,
).join("\n");

/** The stored FLIGHT thread: the operator's messages sent from this question, and FLIGHT's replies. */
function messages(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `comms:${i + 1}`,
    at: NOW - (n - i) * MIN,
    from: i % 2 ? "CAPCOM" : "flight-1",
    to: i % 2 ? "flight-1" : "CAPCOM",
    text: i % 5 === 0 ? LONG : `Message ${i + 1}: short and plain.`,
    operator: i % 2 === 1,
    ...(i % 2 ? { itemKey: KEY } : {}),
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
  return {
    ...base,
    "/api/attention": asks,
    "/api/attention/answered": [],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    "/api/comms/flight": { messages: messages(n) },
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
          await page.boxes("#needsSide .flight-thread-message");
          const before = await page.box(".needs-band");
          for (const to of ["top", "bottom"] as const) {
            await page.evaluate((where) => {
              const log = document.querySelector("#needsSide .flight-thread-log") as HTMLElement;
              log.scrollTop = where === "top" ? 0 : log.scrollHeight;
            }, to);
            expect(
              await page.box(".needs-band"),
              `${label}: band after scrolling to ${to}`,
            ).toEqual(before);
          }
          if (width >= 1920) {
            const message = await page.box("#needsSide .flight-thread-message");
            expect(
              message.width,
              `${label}: messages are wide enough to read`,
            ).toBeGreaterThanOrEqual(400);
          }
          expect(
            await page.reachable("#needsSide .flight-thread-message:last-of-type"),
            `${label}: last message`,
          ).toEqual([true]);
          expect(
            await page.reachable("#needsSide .flight-thread-form textarea"),
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
          const log = await page.box("#needsSide .flight-thread-log");
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
          const composer = await page.box("#needsSide .flight-thread-form");
          const area = await page.box("#needsSide .flight-thread-form textarea");
          expect(
            area.width / composer.width,
            `${label}: the conversation textarea takes the row beside Send`,
          ).toBeGreaterThanOrEqual(0.7);
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

  it.each(["light", "dark"] as const)(
    "every nav tab is fully visible and separate at 1280 with a two-digit Needs you count, %s",
    async (colorScheme) => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1280,
        height: 900,
        colorScheme,
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
                const sharesRow =
                  !!status && r.bottom > status.top + 1 && r.top < status.bottom - 1;
                return r.right > box.right + 1 || (sharesRow && r.right > (status?.left ?? 0) + 1);
              })
              .map((a) => a.textContent),
            separation: [...tabs.querySelectorAll("a")].every((a, index, all) => {
              if (index === 0) return a.getBoundingClientRect().height >= 24;
              const previous = all[index - 1].getBoundingClientRect();
              const current = a.getBoundingClientRect();
              return current.height >= 24 && current.left - previous.right >= 2;
            }),
          };
        }, undefined);
        expect(clipped.scrolls, "the tabs need no sideways scroll").toBe(false);
        expect(clipped.outside, "no tab sits under the status readout").toEqual([]);
        expect(clipped.separation, "each page tab keeps a visible gap and target size").toBe(true);
        const session = await page.evaluate(() => {
          const select = document.querySelector<HTMLSelectElement>("#sess");
          return {
            label: select?.selectedOptions[0]?.textContent,
            fits: !!select && select.scrollWidth <= select.clientWidth + 1,
            painted:
              !!select &&
              (() => {
                const style = getComputedStyle(select);
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                if (!context) return false;
                context.font = `${style.fontSize} ${style.fontFamily}`;
                return select.clientWidth >= context.measureText("All sessions").width + 32;
              })(),
            height: select?.getBoundingClientRect().height ?? 0,
          };
        }, undefined);
        expect(session.label).toBe("All sessions");
        expect(session.fits, "the session label is clipped").toBe(true);
        expect(session.painted, "the complete session label has room to paint").toBe(true);
        expect(session.height, "the session picker is a usable control").toBeGreaterThanOrEqual(24);
        if (SHOTS) await page.screenshot(join(SHOTS, `needs-1280x900-nav-${colorScheme}.png`));
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "send, reply, pick and the question leaving the list work on the page and in the fly-out at the evidence sizes, light and dark",
    async () => {
      const ASKED = "Why this layout?";
      const REPLY = "It keeps every ask one click away.";
      const PICKED = "List and open item";
      const choosePath = `/api/attention/${encodeURIComponent(KEY)}/choice`;
      /** The hub for one walk: it stores what the page sends, and FLIGHT's reply is the fixture's. */
      const hub = () => {
        const base = api(2);
        const [first, ...others] = base["/api/attention"];
        if (!first?.brief) throw new Error("the fixture's first ask has a brief");
        // The server-bound choice route is the only way an option can act.
        const open = {
          ...first,
          brief: boundBrief({
            options: [
              { id: "a", label: PICKED, answer: PICKED },
              { id: "b", label: "One long column", answer: "One long column" },
            ],
            recommendedOptionId: "a",
          }),
        };
        const earlier = base["/api/comms/flight"].messages;
        let sent = false;
        let chosen = false;
        const said = (id: number, operator: boolean, more: object) => ({
          id: `comms:${id}`,
          at: NOW,
          from: operator ? "CAPCOM" : "flight-1",
          to: operator ? "flight-1" : "CAPCOM",
          text: "",
          operator,
          ...more,
        });
        return {
          ...base,
          "/api/attention": () => (chosen ? others : [open, ...others]),
          "/api/comms/flight": () => ({
            messages: [
              ...earlier,
              ...(sent
                ? [
                    said(901, true, { text: ASKED, itemKey: KEY }),
                    said(902, false, { text: REPLY }),
                  ]
                : []),
              ...(chosen ? [said(903, true, { itemKey: KEY, choice: { label: PICKED } })] : []),
            ],
          }),
          "/api/comms": (method: string) => {
            if (method === "POST") sent = true;
            return { ok: true };
          },
          [choosePath]: (method: string) => {
            if (method === "POST") chosen = true;
            return {
              epoch: "e1",
              requestId: "r",
              optionId: "a",
              at: NOW,
              state: "applied",
              text: "Answer sent.",
              actor: { operator: true },
            };
          },
        };
      };
      /** Waits for `count` messages of the thread under `scope` to hold `words`; answers how many do. */
      const inThread = (page: RenderedPage, scope: string, words: string, count = 1) =>
        page.evaluate(
          ([css, text, n]) =>
            new Promise<number>((resolve) => {
              const started = performance.now();
              const look = () => {
                const found = [
                  ...document.querySelectorAll(`${css} .flight-thread-message`),
                ].filter((m) => m.textContent?.includes(text)).length;
                if (found === n || performance.now() - started > 5000) resolve(found);
                else setTimeout(look, 50);
              };
              look();
            }),
          [scope, words, count] as const,
        );
      /** Waits for the Needs you tab to count `n` waiting questions; answers what it shows. */
      const waiting = (page: RenderedPage, n: string) =>
        page.evaluate(
          (want) =>
            new Promise<string>((resolve) => {
              const started = performance.now();
              const look = () => {
                const shown = document.querySelector(".tabs a.needs-tab b")?.textContent ?? "";
                if (shown === want || performance.now() - started > 5000) resolve(shown);
                else setTimeout(look, 50);
              };
              look();
            }),
          n,
        );
      const posts = (page: RenderedPage, path: string) =>
        page.requests().filter((r) => r.method === "POST" && r.path === path).length;
      const SURFACES = [
        // the Needs you page (it opens its first question), and the fly-out for the same item over
        // Overview
        { name: "page", path: "/needs-you", scope: "#needsSide", opts: "#needsOpts" },
        { name: "flyout", path: `/?item=${KEY}`, scope: "#discuss", opts: "#dsOpts" },
      ] as const;
      for (const scheme of ["light", "dark"] as const) {
        for (const [width, height] of [
          [1280, 900],
          [1600, 1000],
          [1920, 940],
          [2560, 1200],
        ] as const) {
          for (const surface of SURFACES) {
            const page = await renderAt({
              page: "test/needsBrowser.html",
              search: `?path=${encodeURIComponent(surface.path)}`,
              width,
              height,
              colorScheme: scheme,
              api: hub(),
              assets: ASSETS,
            });
            const at = `${surface.name} ${width}x${height} ${scheme}`;
            const shot = async (step: string, onThread = true) => {
              if (!SHOTS) return;
              mkdirSync(SHOTS, { recursive: true });
              // after a send or a pick, bring the thread's newest message and its box into the picture
              if (onThread)
                await page.evaluate((css) => {
                  document
                    .querySelector(`${css} .flight-thread-form`)
                    ?.scrollIntoView({ block: "end" });
                }, surface.scope);
              await page.screenshot(
                join(SHOTS, `needs-${surface.name}-${width}x${height}-${scheme}-${step}.png`),
              );
            };
            try {
              if (surface.name === "page") {
                await ready(page);
              }
              await page.boxes(`${surface.scope} .flight-thread-message`);
              await page.boxes(`${surface.opts} button`);
              expect(await waiting(page, "3"), at).toBe("3");
              const heading = await page.evaluate(
                (css) => document.querySelector(`${css} .flight-thread-about`)?.textContent ?? "",
                surface.scope,
              );
              expect(heading, at).toBe(
                "About: Which layout should the Needs you page use: a list and the open item, or one long column?",
              );
              await shot("1-open", false);

              // send beside the question, as the operator does: click the box, type, press Enter
              await page.click(`${surface.scope} .flight-thread-input`);
              for (const key of ASKED) await page.press(key === " " ? "Space" : key);
              await page.press("Enter");
              expect(await inThread(page, surface.scope, ASKED), at).toBe(1);
              expect(await inThread(page, surface.scope, REPLY), at).toBe(1);
              expect(posts(page, "/api/comms"), at).toBe(1);
              await shot("2-reply");

              // pick an option: one receipt in the thread, and the question leaves the list (the
              // page moves on to the next question, whose thread is the same stored conversation)
              await page.click(`${surface.opts} button`);
              expect(await inThread(page, surface.scope, `You chose: ${PICKED}`), at).toBe(1);
              expect(await inThread(page, surface.scope, "You chose"), at).toBe(1);
              expect(posts(page, choosePath), at).toBe(1);
              expect(await waiting(page, "2"), at).toBe("2");
              if (surface.name === "page") {
                const list = await page.evaluate(
                  () => document.querySelector(".needs-list")?.textContent ?? "",
                  undefined,
                );
                expect(list, at).not.toContain("Which layout should the Needs you page use");
                expect(list, at).toContain("Second ask");
              }
              // the send and the reply are still there, once each, beside the receipt
              expect(await inThread(page, surface.scope, ASKED), at).toBe(1);
              expect(await inThread(page, surface.scope, REPLY), at).toBe(1);
              expect(page.errors(), at).toEqual([]);
              await shot("3-picked");
            } finally {
              await page.close();
            }
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
  it(
    "clicking an option on a briefed protected item from an unwatched repo records the answer",
    async () => {
      const key = "hold:studio";
      const choicePath = `/api/attention/${encodeURIComponent(key)}/choice`;
      const protectedAsk = item({
        key,
        kind: "decision",
        agentId: "studio",
        repoId: "autonomy-engine",
        escalationId: null,
        ticket: null,
        url: null,
        offers: [],
        text: "The studio switch-over is still open.",
        at: NOW - 2 * HOUR,
        brief: {
          ...brief({
            for: "operator",
            by: "hub",
            ask: "Should the old studio switch-over stay open?",
            recommendation: "Not now, clear it.",
            recommendedOptionId: "clear",
            options: [
              { id: "clear", label: "Not now, clear it", answer: "Clear it." },
              { id: "keep", label: "Keep it", answer: "Keep it open." },
            ],
          }),
          id: 31,
          state: { completeness: "complete", freshness: "current", reason: "Matches the source." },
          binding: {
            version: 2,
            sourceRevision: "c".repeat(64),
            meaningKey: "m",
            epoch: "e1",
            epochId: 31,
            preparedAt: NOW,
            preparedBy: { service: "stalled-comms" },
            actions: [
              {
                optionId: "clear",
                action: { kind: "record-decision" },
                defaultable: false,
                effect: "Records the decision.",
              },
              {
                optionId: "keep",
                action: { kind: "record-decision" },
                defaultable: false,
                effect: "Records the decision.",
              },
            ],
          },
        },
      });
      const receipt = {
        epoch: "e1",
        requestId: "r",
        optionId: "clear",
        at: NOW,
        state: "applied",
        text: "Decision recorded. No external action was performed.",
        actor: { operator: true },
      };
      const other = item({
        key: "question:other",
        kind: "question",
        escalationId: null,
        text: "Another ask still waiting",
      });
      let chosen = false;
      const choiceMessage = {
        id: "comms:900",
        at: NOW,
        from: "CAPCOM",
        to: "flight-1",
        text: "",
        operator: true,
        itemKey: key,
        choice: { label: "Not now, clear it" },
      };
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 1000,
        api: {
          ...api(),
          // the question is listed until the choice is posted, then the refetch leaves it out
          "/api/attention": () => (chosen ? [other] : [protectedAsk, other]),
          "/api/comms/flight": () => ({ messages: chosen ? [choiceMessage] : [] }),
          // the receipt route's GET and the choice POST share the path
          [`POST ${choicePath}`]: () => {
            chosen = true;
            return receipt;
          },
        },
      });
      try {
        await ready(page);
        const buttons = () =>
          page.evaluate(
            () =>
              [...document.querySelectorAll("#needsOpts button")].map((b) => ({
                text: b.textContent,
                disabled: (b as HTMLButtonElement).disabled,
              })),
            undefined,
          );
        await page.boxes("#needsOpts button");
        expect(await buttons()).toEqual([
          { text: "Not now, clear it", disabled: false },
          { text: "Keep it", disabled: false },
          { text: "Accept recommendation: Not now, clear it", disabled: false },
          { text: "Discuss", disabled: false },
        ]);
        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot(join(SHOTS, "needs-protected-before-1600x1000.png"));
        }
        await page.click("#needsOpts button");
        // The options block unmounts once the question leaves the list, so its receipt line
        // and disabled options are checked in the ItemPanel test; here the POST and the list prove it.
        expect(
          page.requests().filter((r) => r.method === "POST" && r.path === choicePath),
        ).toHaveLength(1);
        // the answered question leaves "Waiting on you" (and its count); the thread shows the pick once
        const listText = () =>
          page.evaluate(
            () =>
              new Promise<string>((resolve) => {
                const started = Date.now();
                const look = () => {
                  const text = document.querySelector(".needs-list")?.textContent ?? "";
                  if (
                    !text.includes("Should the old studio switch-over stay open?") ||
                    Date.now() - started > 5000
                  )
                    resolve(text);
                  else setTimeout(look, 50);
                };
                look();
              }),
            undefined,
          );
        const after = await listText();
        expect(after).not.toContain("Should the old studio switch-over stay open?");
        expect(after).toContain("Waiting on you · 1");
        expect(
          await page.evaluate(
            () => document.querySelector(".needs-list")?.textContent ?? "",
            undefined,
          ),
        ).toContain("Another ask still waiting");
        expect(
          await page.evaluate(
            () =>
              [...document.querySelectorAll("#needsSide .flight-thread-message")].filter((m) =>
                m.textContent?.includes("You chose: Not now, clear it"),
              ).length,
            undefined,
          ),
        ).toBe(1);
        if (SHOTS) await page.screenshot(join(SHOTS, "needs-protected-after-1600x1000.png"));
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "complete brief composition: facts, options, Accept and Discuss stay whole and reachable",
    async () => {
      const BIG = "A long sentence that must be read in full. ".repeat(190).slice(0, 8000);
      const variants = [
        { name: "two", options: 2, asks: 0, big: false },
        { name: "four", options: 4, asks: 0, big: false },
        { name: "three-asks", options: 2, asks: 2, big: false },
        { name: "fifty-asks", options: 2, asks: 49, big: false },
        { name: "stress", options: 4, asks: 0, big: true },
      ] as const;
      const sizes = [
        [1280, 900],
        [1600, 1000],
        [1920, 940],
        [1600, 700],
      ] as const;
      for (const variant of variants) {
        for (const [width, height] of sizes) {
          for (const colorScheme of ["light", "dark"] as const) {
            for (const dock of variant.name === "two" || variant.name === "stress"
              ? (["folded", "expanded"] as const)
              : (["folded"] as const)) {
              const options = Array.from({ length: variant.options }, (_, i) => ({
                id: `o${i}`,
                label: `Option ${i + 1}`,
                answer: `Answer ${i + 1}`,
                ...(variant.big ? { description: BIG } : {}),
              }));
              const base = api(0, 2, variant.asks);
              const decisionBrief = boundBrief({
                options,
                recommendedOptionId: "o0",
                ...(variant.big ? { context: BIG, recommendation: BIG } : {}),
              });
              if (variant.big && decisionBrief.decision) {
                decisionBrief.decision.costOfDelay = BIG;
                decisionBrief.decision.consulted = [{ who: "mc-dev-1", finding: BIG }];
              }
              for (const o of decisionBrief.options)
                if (variant.big) {
                  o.consequence = BIG;
                  if (o.reversibility) o.reversibility.detail = BIG;
                }
              const asks = (base["/api/attention"] as ReturnType<typeof item>[]).map((a) =>
                a.key === KEY ? { ...a, brief: decisionBrief } : a,
              );
              const page = await renderAt({
                page: "test/needsBrowser.html",
                width,
                height,
                colorScheme,
                api: { ...base, "/api/attention": asks },
                assets: ASSETS,
              });
              const label = `${variant.name} ${width}x${height} ${colorScheme} dock ${dock}`;
              try {
                await ready(page);
                // Needs you has no dock column: the dock is a drawer there at any width. "Expanded"
                // opens that drawer; it floats over the page, so the page must not shift or overflow
                // under it, and it is closed again before the focus and hit-test checks.
                if (dock === "expanded") {
                  await page.click('.iconbtn[title^="Show or hide FLIGHT"]');
                  const drawerOpen = await page.evaluate(
                    () => document.querySelector<HTMLElement>("#dock")?.hidden === false,
                    undefined,
                  );
                  expect(drawerOpen, `${label}: the dock drawer opens`).toBe(true);
                  const underDrawer = await page.evaluate(
                    () => document.documentElement.scrollWidth - innerWidth,
                    undefined,
                  );
                  expect(
                    underDrawer,
                    `${label}: no horizontal overflow, drawer open`,
                  ).toBeLessThanOrEqual(0);
                  await page.press("Escape");
                }
                await page.boxes(".needs-answer .decision-facts");
                const overflow = await page.evaluate(
                  () => document.documentElement.scrollWidth - innerWidth,
                  undefined,
                );
                expect(overflow, `${label}: no horizontal overflow`).toBeLessThanOrEqual(0);
                const factsInFold = await page.evaluate(
                  () =>
                    document
                      .querySelector(".needs-more")
                      ?.contains(document.querySelector(".decision-facts")) ?? false,
                  undefined,
                );
                expect(factsInFold, `${label}: facts are outside the Details fold`).toBe(false);
                await page.evaluate(() => {
                  const last = [
                    ...document.querySelectorAll<HTMLElement>(".opt .option-pick"),
                  ].pop();
                  last?.focus();
                }, undefined);
                const focused = await page.evaluate(
                  () => document.activeElement?.classList.contains("option-pick") ?? false,
                  undefined,
                );
                expect(focused, `${label}: the last option takes focus`).toBe(true);
                // Keyboard from the last option reaches Accept, and Accept shows a focus ring.
                for (let i = 0; i < 5; i++) {
                  const onAccept = await page.evaluate(
                    () => document.activeElement?.textContent?.startsWith("Accept") ?? false,
                    undefined,
                  );
                  if (onAccept) break;
                  await page.press("Tab");
                }
                const ring = await page.evaluate(() => {
                  const el = document.activeElement as HTMLElement | null;
                  const css = el ? getComputedStyle(el) : null;
                  return {
                    accept: el?.textContent?.startsWith("Accept") ?? false,
                    outline: css?.outlineStyle ?? "none",
                    shadow: css?.boxShadow ?? "none",
                  };
                }, undefined);
                expect(ring.accept, `${label}: keyboard reaches Accept`).toBe(true);
                expect(
                  ring.outline !== "none" || ring.shadow !== "none",
                  `${label}: Accept shows focus`,
                ).toBe(true);
                const reach = await page.evaluate(() => {
                  const hit = (el: Element | null) => {
                    if (!el) return false;
                    el.scrollIntoView({ block: "nearest" });
                    const r = el.getBoundingClientRect();
                    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    return top !== null && (el === top || el.contains(top));
                  };
                  const accept = [...document.querySelectorAll("button")].find((b) =>
                    b.textContent?.startsWith("Accept recommendation"),
                  );
                  const last = [...document.querySelectorAll(".opt .option-pick")].pop() ?? null;
                  return {
                    accept: hit(accept ?? null),
                    last: hit(last),
                  };
                }, undefined);
                expect(reach.accept, `${label}: Accept is painted and hit-testable`).toBe(true);
                expect(reach.last, `${label}: the last option is painted and hit-testable`).toBe(
                  true,
                );
                if (SHOTS) {
                  mkdirSync(SHOTS, { recursive: true });
                  await page.screenshot(
                    join(
                      SHOTS,
                      `needs-brief-${variant.name}-${width}x${height}-${colorScheme}-${dock}.png`,
                    ),
                  );
                }
              } finally {
                await page.close();
              }
            }
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );
  it(
    "the flyout keeps Accept apart from Discuss and the facts inside the panel inset",
    async () => {
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1600, 700],
      ] as const) {
        for (const colorScheme of ["light", "dark"] as const) {
          const base = api(0, 2, 0);
          const asks = (base["/api/attention"] as ReturnType<typeof item>[]).map((a) =>
            a.key === KEY
              ? {
                  ...a,
                  brief: boundBrief({
                    recommendedOptionId: "list",
                    options: [
                      {
                        id: "list",
                        label: "List and open item",
                        answer: "Use the list and open item.",
                      },
                      { id: "column", label: "One long column", answer: "Use one long column." },
                    ],
                  }),
                }
              : a,
          );
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme,
            search: `?path=${encodeURIComponent(`/comms?item=${KEY}`)}`,
            api: { ...base, "/api/attention": asks },
            assets: ASSETS,
          });
          const label = `flyout ${width}x${height} ${colorScheme}`;
          try {
            await page.boxes("#dsOpts .answer-actions");
            await page.evaluate(async () => {
              await document.fonts.ready;
            }, undefined);
            const m = await page.evaluate(() => {
              const box = (el: Element | null) => {
                const r = el?.getBoundingClientRect();
                return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
              };
              const buttons = [
                ...document.querySelectorAll<HTMLElement>("#dsOpts .answer-actions button"),
              ];
              const accept = buttons.find((b) => b.textContent?.startsWith("Accept")) ?? null;
              const discuss = buttons.find((b) => b.textContent === "Discuss") ?? null;
              const brief = document.querySelector("#dsBrief .brief, #dsBrief");
              const hit = (el: Element | null) => {
                if (!el) return false;
                el.scrollIntoView({ block: "nearest" });
                const r = el.getBoundingClientRect();
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return top !== null && (el === top || el.contains(top));
              };
              const lastOption =
                [...document.querySelectorAll("#dsOpts .option-pick")].pop() ?? null;
              return {
                accept: box(accept),
                discuss: box(discuss),
                facts: box(document.querySelector("#discuss .decision-facts")),
                panel: box(document.querySelector("#discuss")),
                brief: box(brief),
                acceptHit: hit(accept),
                lastHit: hit(lastOption),
                overflow: document.documentElement.scrollWidth - innerWidth,
              };
            }, undefined);
            if (!m.accept || !m.discuss || !m.facts || !m.panel)
              throw new Error(`${label}: missing`);
            expect(m.overflow, `${label}: no horizontal overflow`).toBeLessThanOrEqual(0);
            const sameRow = Math.abs(m.accept.y - m.discuss.y) < m.accept.h;
            if (sameRow)
              expect(
                m.discuss.x - (m.accept.x + m.accept.w),
                `${label}: Accept and Discuss are apart`,
              ).toBeGreaterThanOrEqual(4);
            expect(
              m.facts.x,
              `${label}: facts are inset from the panel edge`,
            ).toBeGreaterThanOrEqual(m.panel.x + 4);
            expect(m.acceptHit, `${label}: Accept is hit-testable`).toBe(true);
            expect(m.lastHit, `${label}: the last option is hit-testable`).toBe(true);
            await page.evaluate(() => {
              (
                document.querySelector("#dsOpts .option-pick:last-of-type") as HTMLElement | null
              )?.focus();
            }, undefined);
            for (let i = 0; i < 6; i++) {
              const onAccept = await page.evaluate(
                () => document.activeElement?.textContent?.startsWith("Accept") ?? false,
                undefined,
              );
              if (onAccept) break;
              await page.press("Tab");
            }
            const ring = await page.evaluate(() => {
              const el = document.activeElement as HTMLElement | null;
              const css = el ? getComputedStyle(el) : null;
              return {
                accept: el?.textContent?.startsWith("Accept") ?? false,
                visible: css ? css.outlineStyle !== "none" || css.boxShadow !== "none" : false,
              };
            }, undefined);
            expect(ring.accept, `${label}: keyboard reaches Accept`).toBe(true);
            expect(ring.visible, `${label}: Accept shows focus`).toBe(true);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(
                join(SHOTS, `needs-flyout-${width}x${height}-${colorScheme}.png`),
              );
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
