// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, crewRow, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "comms-shots");

const message = (i: number) => ({
  id: `comms:${i}`,
  at: NOW - (60 - i) * 60_000,
  from: "shop-app-ta",
  to: "crew",
  text: `Message ${i} on the crew channel`,
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  pinned: false,
  operator: false,
});

const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": { rows: [crewRow()], firstRunToday: null },
  "/api/attention": [],
  "/api/flight": { seat: null, decisions: [] },
  "/api/comms/crew": {
    messages: Array.from({ length: 50 }, (_, i) => message(i + 10)),
    hasMore: true,
    unread: 0,
  },
  "/api/comms/flight": { messages: [] },
  "/api/comms/mentions": { mentions: [] },
  "/api/comms/pins": { messages: [] },
  "/api/comms/agents/shop-app-ta?summary=1": { contacts: [], unread: 0 },
};

describeRendered("Comms with older messages to load, rendered", () => {
  it.each([1600, 1920])(
    "shows Load older above the first message at %i wide",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({ page: "test/commsBrowser.html", width, height: 1000, api });
      const button = await page.box(".comms-older button");
      const first = await page.box(".comms-bubble");
      expect(button.width).toBeGreaterThan(0);
      expect(button.y + button.height).toBeLessThanOrEqual(first.y + 1);
      expect(await page.unclipped("#chatP")).toEqual([true]);
      // The pane opens on the latest message; scroll up to the paging row for the picture.
      await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("#convo");
        if (pane) pane.scrollTop = 0;
      }, undefined);
      await page.screenshot(join(SHOTS, `comms-${width}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
