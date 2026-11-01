// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type Box,
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
} from "./browserRunner.ts";
import { CONFIG, crewRow, NOW, seatRow } from "./fixtures.ts";

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
  "/api/comms/crew?history=1": {
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
      await page.click(".comms-older button");
      const button = await page.box("#convo .comms-older button");
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

// Enough seats that the list outgrows the viewport and scrolls.
const SEATS = Array.from({ length: 16 }, (_, i) => (i === 0 ? "guido-1" : `retro-${i}`));
const seats = SEATS.map((id, index) =>
  seatRow({ id, index: index + 1, role: id.startsWith("guido") ? "GUIDO" : "RETRO" }),
);
const flightPage = {
  messages: Array.from({ length: 6 }, (_, i) => ({
    ...message(i + 1),
    from: i % 2 === 0 ? "CAPCOM" : "flight-1",
    to: i % 2 === 0 ? "flight-1" : "CAPCOM",
    text: `FLIGHT and CAPCOM, message ${i + 1}`,
  })),
  hasMore: false,
  // Opening the conversation posted its read; the route now answers with the cursor moved.
  cursor: "comms:6",
  unread: 0,
};
const flightApi = {
  ...api,
  "/api/crew?shape=summary": {
    rows: [seatRow({ id: "flight-1", index: 0 }), ...seats],
    firstRunToday: null,
  },
  "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
  "/api/comms/flight": flightPage,
  "/api/comms/read": { ok: true },
  ...Object.fromEntries(
    SEATS.map((id) => [
      `/api/comms/agents/${id}?summary=1`,
      { messages: [], contacts: [], unread: 3, inboxUnread: 0, directUnread: 0 },
    ]),
  ),
};

describeRendered("Comms FLIGHT ↔ CAPCOM, opened, rendered", () => {
  it.each([1280, 1600, 1920])(
    "shows no read error and keeps the agent rows apart at %i wide",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/commsBrowser.html",
        width,
        height: 1000,
        search: "?at=/comms",
        api: flightApi,
      });
      await page.box(".comms-bubble");
      expect(await page.evaluate(() => document.body.textContent ?? "", undefined)).not.toContain(
        "Could not mark this conversation read",
      );
      const rows = await page.boxes(".comms-nav-row");
      expect(rows).toHaveLength(SEATS.length);
      // Each row ends where the next begins; its second line sits inside it.
      const lines = await page.boxes(".comms-nav-row .comms-nav-agent small");
      rows.forEach((row, i) => {
        const line = lines[i] as Box;
        expect(line.y + line.height).toBeLessThanOrEqual(row.y + row.height - 1);
        const next = rows[i + 1];
        if (next) expect(row.y + row.height).toBeLessThanOrEqual(next.y + 1);
      });
      // The Decisions panel does not give up its room to the list: its empty-state line shows whole.
      const decisions = await page.evaluate(() => {
        const panel = document.querySelector(".comms-decisions")?.getBoundingClientRect();
        const line = [...document.querySelectorAll(".comms-decisions *")]
          .filter((el) => el.children.length === 0 && el.textContent?.includes("No decisions"))
          .map((el) => el.getBoundingClientRect())[0];
        return panel && line
          ? { panelBottom: panel.bottom, lineTop: line.top, lineBottom: line.bottom }
          : null;
      }, undefined);
      expect(decisions).not.toBeNull();
      expect(decisions?.lineBottom).toBeLessThanOrEqual((decisions?.panelBottom ?? 0) + 0.5);
      await page.screenshot(join(SHOTS, `comms-flight-${width}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
