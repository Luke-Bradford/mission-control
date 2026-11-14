// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;
const crew = {
  id: "comms:1",
  at: NOW - 60000,
  from: "dev-1",
  to: "crew",
  text: "The crew message stays visible.",
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  pinned: false,
  operator: false,
};
const notice = {
  ...crew,
  id: "comms:2",
  from: "MC",
  text: "CI failed. Read the check.",
  kind: "notice",
};

describeRendered("The Comms hub-notice switch", () => {
  it(
    "hides and restores notices from Overview without hiding crew messages",
    async () => {
      for (const [width, height] of [
        [1280, 800],
        [1600, 900],
        [1600, 700],
        [1920, 1080],
      ] as const) {
        for (const colorScheme of ["light", "dark"] as const) {
          const api: Record<string, unknown> = {
            ...desktopFixture().api,
            "/api/comms/crew": { messages: [crew, notice], unread: 1 },
            "/api/comms/crew?notices=hide": { messages: [crew], unread: 1 },
            "/api/comms/flight": { messages: [] },
            "/api/comms/flight?notices=hide": { messages: [] },
            "/api/comms/pins": { messages: [] },
            "/api/comms/mentions": { mentions: [] },
            "/api/comms/read": { ok: true },
          };
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme,
            search: "?path=/",
            api,
          });
          try {
            await page.boxes("#page-overview");
            await page.click('header a[href="/comms"]');
            await page.boxes(".comms-notice-switch");
            await page.click(".comms-nav-top:nth-of-type(2)");
            await page.boxes("#comms-message-comms\\:2");
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            }, undefined);
            const control = await page.box(".comms-notice-switch");
            expect(control.x).toBeGreaterThanOrEqual(0);
            expect(control.y + control.height).toBeLessThanOrEqual(height);
            expect((await page.reachable(".comms-notice-switch input")).every(Boolean)).toBe(true);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(
                join(SHOTS, `notices-shown-${width}x${height}-${colorScheme}.png`),
              );
            }
            await page.evaluate(
              () =>
                (document.querySelector(".comms-notice-switch input") as HTMLInputElement).focus(),
              undefined,
            );
            await page.press("Space");
            await page.boxes("#comms-message-comms\\:1");
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    document
                      .querySelector("#convo")
                      ?.textContent?.includes("CI failed. Read the check."),
                  undefined,
                ),
              )
              .toBe(false);
            expect(
              await page.evaluate(
                () =>
                  document
                    .querySelector("#convo")
                    ?.textContent?.includes("The crew message stays visible."),
                undefined,
              ),
            ).toBe(true);
            if (SHOTS)
              await page.screenshot(
                join(SHOTS, `notices-hidden-${width}x${height}-${colorScheme}.png`),
              );
            await page.press("Space");
            await page.boxes("#comms-message-comms\\:2");
            expect(page.errors()).toEqual([]);
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
