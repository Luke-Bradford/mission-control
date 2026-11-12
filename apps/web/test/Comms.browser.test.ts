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
import { boardItem, CONFIG, crewRow, NOW, REPOS, seatRow } from "./fixtures.ts";

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

const refMessage = {
  ...message(1),
  id: "comms:ref",
  text: "Handoff on #1452, see PR 1460",
  ticket: "shop-app#1452",
  ref: "#1452",
};

describeRendered("Comms ticket numbers, rendered", () => {
  it.each([
    [2560, 1200],
    [1920, 940],
  ])(
    "shows the number and its separate filter button at %ix%i",
    async (width, height) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/commsBrowser.html",
        width,
        height,
        api: {
          ...api,
          "/api/comms/crew": { messages: [refMessage], hasMore: false, unread: 0 },
          "/api/comms/crew?history=1": { messages: [refMessage], hasMore: false, unread: 0 },
        },
      });
      const number = await page.box(".comms-message-meta a.comms-ref");
      const filter = await page.box(".comms-message-meta .comms-ref-filter");
      const prLink = await page.box(".comms-bubble-body a.comms-ref");
      const prFilter = await page.box(".comms-bubble-body .comms-ref-filter");
      expect(number.width).toBeGreaterThan(0);
      expect(filter.width).toBeGreaterThan(0);
      // the number and the filter are each a 24px target, the number's link included
      for (const box of [number, filter, prLink, prFilter]) {
        expect(box.height).toBeGreaterThanOrEqual(24);
        expect(box.width).toBeGreaterThanOrEqual(24);
      }
      // two controls side by side, not one on top of the other
      expect(filter.x).toBeGreaterThanOrEqual(number.x + number.width - 1);
      await page.screenshot(join(SHOTS, `comms-refs-${width}x${height}.png`));
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
// A busy Tickets list: 50 tickets with messages, some with long titles.
const TALKED = Array.from({ length: 50 }, (_, i) => 3000 + i);
const ticketTitle = (n: number) =>
  n % 5 === 0
    ? `Ticket ${n}: a very long title that runs past the width of the left column and must wrap or clip`
    : `Ticket ${n}`;
const flightApi = {
  ...api,
  "/api/repos": REPOS,
  "/api/boards/shop-app": TALKED.map((n) => boardItem({ issueNumber: n, title: ticketTitle(n) })),
  "/api/boards/site-builder": [],
  "/api/comms/ticket-counts": {
    tickets: TALKED.map((n, i) => ({ ticket: `shop-app#${n}`, count: i + 1 })),
    unassignedCount: 0,
  },
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
  it.each([
    [1280, 1000],
    [1600, 1000],
    [1920, 1000],
    [1600, 900],
    [1600, 700],
  ])(
    "shows no read error and keeps the agent rows apart at %i x %i",
    async (width, height) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/commsBrowser.html",
        width,
        height,
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
      // The Tickets panel keeps its room: its search box shows whole inside it, below the nav.
      const tickets = await page.evaluate(() => {
        const panel = document.querySelector(".comms-tickets")?.getBoundingClientRect();
        const box = document.querySelector(".comms-ticket-search")?.getBoundingClientRect();
        const nav = document.querySelector(".comms-nav")?.getBoundingClientRect();
        return panel && box && nav
          ? {
              panelTop: panel.top,
              panelBottom: panel.bottom,
              panelLeft: panel.left,
              panelRight: panel.right,
              boxLeft: box.left,
              boxRight: box.right,
              boxTop: box.top,
              boxBottom: box.bottom,
              navBottom: nav.bottom,
              boxWidth: box.width,
            }
          : null;
      }, undefined);
      expect(tickets).not.toBeNull();
      expect(tickets?.boxTop).toBeGreaterThanOrEqual((tickets?.panelTop ?? 0) - 0.5);
      expect(tickets?.boxBottom).toBeLessThanOrEqual((tickets?.panelBottom ?? 0) + 0.5);
      expect(tickets?.panelTop).toBeGreaterThanOrEqual((tickets?.navBottom ?? 0) - 0.5);
      expect(tickets?.boxWidth).toBeGreaterThan(120);
      // neither list spills past the column, and each keeps at least three rows whole
      const shared = await page.evaluate(() => {
        const left = document.querySelector(".comms-left")?.getBoundingClientRect();
        const panel = document.querySelector(".comms-tickets")?.getBoundingClientRect();
        const nav = document.querySelector(".comms-nav")?.getBoundingClientRect();
        const list = document.querySelector(".comms-ticket-list")?.getBoundingClientRect();
        const whole = (box: DOMRect | undefined, sel: string) =>
          box
            ? [...document.querySelectorAll(sel)].filter((e) => {
                const r = e.getBoundingClientRect();
                return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
              }).length
            : 0;
        return {
          ticketsInColumn: left && panel ? panel.bottom <= left.bottom + 0.5 : false,
          ticketRows: whole(list, ".comms-ticket-list li"),
          agentRows: whole(nav, ".comms-nav-row"),
        };
      }, undefined);
      expect(shared.ticketsInColumn).toBe(true);
      expect(shared.ticketRows).toBeGreaterThanOrEqual(3);
      expect(shared.agentRows).toBeGreaterThanOrEqual(3);
      // the busy list shows rows, each with its message count, and no row runs past the panel
      const listed = await page.evaluate(() => {
        const panel = document.querySelector(".comms-tickets")?.getBoundingClientRect();
        const items = [...document.querySelectorAll(".comms-ticket-list li")];
        return {
          rows: items.length,
          counts: items.filter((li) => /\d+ messages?/.test(li.textContent ?? "")).length,
          overflow: items.filter((li) =>
            panel ? li.getBoundingClientRect().right > panel.right + 0.5 : true,
          ).length,
        };
      }, undefined);
      expect(listed.rows).toBeGreaterThan(5);
      expect(listed.counts).toBe(listed.rows);
      expect(listed.overflow).toBe(0);
      // the box ends inside the panel on both sides, so its border and focus ring are not clipped
      expect(tickets?.boxRight).toBeLessThanOrEqual((tickets?.panelRight ?? 0) - 0.5);
      expect(tickets?.boxLeft).toBeGreaterThanOrEqual((tickets?.panelLeft ?? 0) + 0.5);
      await page.screenshot(join(SHOTS, `comms-flight-${width}x${height}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
