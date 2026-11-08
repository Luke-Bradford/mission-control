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
import { brief, HOUR, item, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;
const KEY = "decision:layout";
const NOTICE = "FLIGHT is stopped. It reads this when it starts.";
const discussionPath = `/api/attention/${encodeURIComponent(KEY)}/discussion`;

/** Needs you with a FLIGHT question open and FLIGHT stopped. */
function api() {
  const base = desktopFixture().api;
  const discussion = { id: "d1", itemKey: KEY, version: "v1", messages: [] };
  return {
    ...base,
    "/api/flight": {
      seat: {
        id: "flight-1",
        call: "FLIGHT",
        model: "fixture-model",
        state: "stopped",
        live: false,
      },
      decisions: [],
    },
    "/api/attention": [
      item({
        key: KEY,
        kind: "decision",
        agentId: "flight-1",
        escalationId: null,
        text: "Which layout should the Needs you page use?",
        at: NOW - 2 * HOUR,
        brief: brief({
          for: "operator",
          options: [
            { id: "list", label: "List and open item", answer: "Use the list and open item." },
            { id: "column", label: "One long column", answer: "Use one long column." },
          ],
        }),
      }),
    ],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
    [discussionPath]: discussion,
    [`${discussionPath}?id=d1`]: discussion,
  };
}

async function ready(page: RenderedPage) {
  await page.boxes("#needsForm");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
}

describeRendered("Needs you with FLIGHT stopped", () => {
  it(
    "keeps the box, options and Ask FLIGHT open, with the notice and Start FLIGHT beside them",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        for (const [width, height] of [
          [1280, 800],
          [1600, 900],
        ] as const) {
          const label = `${width}x${height} ${scheme}`;
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api(),
          });
          try {
            await ready(page);
            const state = await page.evaluate(() => {
              const q = (s: string) => document.querySelector<HTMLElement>(s);
              const form = q("#needsForm") as HTMLElement;
              const input = q("#needsInput") as HTMLTextAreaElement;
              const notice = [...form.querySelectorAll(".flight-stopped")].map(
                (n) => n.textContent,
              );
              const start = form.querySelector<HTMLElement>(".flight-stopped button");
              const rect = (el: Element | null) => {
                const r = el?.getBoundingClientRect();
                return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
              };
              return {
                inputDisabled: input.disabled,
                optionsDisabled: [
                  ...document.querySelectorAll<HTMLButtonElement>(".option-pick"),
                ].map((b) => b.disabled),
                askDisabled: document.querySelector<HTMLInputElement>(
                  "#needsDiscussionForm textarea, #needsDiscussionForm input",
                )?.disabled,
                notice,
                start: rect(start),
                input: rect(input),
                width: innerWidth,
                height: innerHeight,
              };
            }, undefined);
            expect(state.inputDisabled, `${label}: reply box enabled`).toBe(false);
            expect(state.optionsDisabled.length, `${label}: options shown`).toBeGreaterThan(0);
            expect(
              state.optionsDisabled.every((d) => !d),
              `${label}: options enabled`,
            ).toBe(true);
            expect(state.askDisabled, `${label}: Ask FLIGHT box enabled`).toBe(false);
            expect(state.notice.join(" "), `${label}: notice`).toContain(NOTICE);
            expect(state.start, `${label}: Start FLIGHT shown`).not.toBeNull();
            const start = state.start as { x: number; y: number; w: number; h: number };
            expect(
              start.x + start.w,
              `${label}: Start FLIGHT inside the width`,
            ).toBeLessThanOrEqual(state.width);
            expect(start.w, `${label}: Start FLIGHT has a real hit area`).toBeGreaterThanOrEqual(
              60,
            );
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `flight-stopped-${width}x${height}-${scheme}.png`));
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
