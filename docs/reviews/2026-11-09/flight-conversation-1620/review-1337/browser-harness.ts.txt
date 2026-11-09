// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "flight-source-shots");
const line = (id: string, text: string, from = "flight-1", at: number | null = NOW) => ({
  id,
  text,
  at,
  from,
  to: from === "CAPCOM" ? "flight-1" : "CAPCOM",
  ticket: null,
  label: null,
  ref: null,
  replyTo: null,
  mentions: [],
  reactions: [],
  operator: from === "CAPCOM",
});
const messages = [
  {
    ...line("comms:1", "What needs acting on?", "CAPCOM"),
    state: "stored",
    deliveredAt: null as number | null,
  },
  line("stream:flight-run:100:0", "The conversation fix is being checked."),
  line("comms:2", "The stored reply is in the same conversation."),
  line("stream:flight-run:300:0", "This continuation has no recorded time.", "flight-1", null),
  { ...line("comms:3", "You chose: Keep working", "CAPCOM"), choice: { label: "Keep working" } },
];
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": {
    rows: [seatRow({ id: "flight-1", role: "FLIGHT", hudState: "idle", run: null })],
    firstRunToday: null,
  },
  "/api/attention": [],
  "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
  "/api/comms/crew": { messages: [], hasMore: false },
  "/api/comms/flight": { messages, hasMore: false, cursor: messages.at(-1)?.id, unread: 0 },
  "/api/comms/read": { ok: true },
  "/api/comms/mentions": { mentions: [] },
  "/api/comms/pins": { messages: [] },
  "/api/comms/links": { links: [] },
  "/api/comms/chatter": { pairs: [] },
  "/api/comms/traffic": { hours: [] },
  "/api/comms/metrics": { p95BySeat: [], bySeat: [] },
};

describeRendered("the joined FLIGHT source in Comms", () => {
  it.each([
    { width: 1280, height: 1000 },
    { width: 1600, height: 1000 },
    { width: 1920, height: 1000 },
    { width: 1600, height: 700 },
  ])(
    "keeps source order, unknown time and valid controls at $width × $height in both themes",
    async ({ width, height }) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/commsBrowser.html",
          search: "?at=/",
          width,
          height,
          colorScheme: theme,
          api,
        });
        try {
          expect(
            await page.evaluate(() => {
              const link = document.querySelector<HTMLAnchorElement>('a[href="/comms"]');
              link?.click();
              return !!link;
            }, undefined),
          ).toBe(true);
          await page.box(".comms-bubble");
          const rows = await page.evaluate(
            () =>
              [...document.querySelectorAll(".comms-bubble")].map((row) => ({
                text: row.querySelector(".comms-bubble-body")?.textContent,
                time: row.querySelector(".comms-message-meta > span")?.textContent,
                actions: row.querySelectorAll(".comms-actions button").length,
              })),
            undefined,
          );
          expect(rows.map((row) => row.text)).toEqual(messages.map((message) => message.text));
          expect(rows[3]?.time).toBe("—");
          expect(rows[1]?.actions).toBe(0);
          expect(rows[3]?.actions).toBe(0);
          expect(rows[0]?.actions).toBeGreaterThan(0);
          expect(await page.unclipped("#chatP")).toEqual([true]);
          const labels = () =>
            page.evaluate(
              () =>
                [...document.querySelectorAll(".comms-delivery-state")].map((el) => el.textContent),
              undefined,
            );
          await expect.poll(labels).toEqual(["Stored"]);
          expect(
            await page.evaluate(
              () =>
                document
                  .getElementById("comms-message-comms:1")
                  ?.querySelectorAll('[data-testid="message-state"]').length,
              undefined,
            ),
          ).toBe(1);
          await page.screenshot(join(SHOTS, `flight-state-stored-${width}x${height}-${theme}.png`));
          for (const state of ["delivered", "answered"] as const) {
            Object.assign(messages[0] ?? {}, { state, deliveredAt: NOW });
            await page.evaluate(() => Reflect.get(window, "__refetchAgents")(), undefined);
            await expect
              .poll(labels)
              .toEqual([state === "answered" ? "Answered" : "Delivered 13:00"]);
            await page.screenshot(
              join(SHOTS, `flight-state-${state}-${width}x${height}-${theme}.png`),
            );
          }
          Object.assign(messages[0] ?? {}, { state: "stored", deliveredAt: null });
          expect(page.errors()).toEqual([]);
          await page.screenshot(join(SHOTS, `flight-source-${width}x${height}-${theme}.png`));
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
