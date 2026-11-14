// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "flight-thread-shots");
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
  line("comms:1", "What needs acting on?", "CAPCOM"),
  line("comms:2", "**Two** things:\n\n- merge #12\n- review PR 14"),
  line("comms:3", "This continuation has no recorded time.", "flight-1", null),
  { ...line("comms:4", "Keep working", "CAPCOM"), choice: { label: "Keep working" } },
];
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": {
    rows: [seatRow({ id: "flight-1", role: "FLIGHT", hudState: "idle", run: null })],
    firstRunToday: null,
  },
  "/api/attention": [],
  "/api/flight": { seat: { id: "flight-1", live: true, state: "idle" }, decisions: [] },
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

describeRendered("the shared FLIGHT thread in Comms", () => {
  it.each([1600, 1920])(
    "shows formatted messages, a visible box and no overflow at %i wide, light",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/commsBrowser.html",
        search: "?at=/comms",
        width,
        height: 1000,
        colorScheme: "light",
        api,
      });
      try {
        await page.box("main .flight-thread-message");
        const text = await page.evaluate(
          () => document.querySelector("main .flight-thread-log")?.textContent ?? "",
          undefined,
        );
        expect(text).not.toContain("**");
        expect(text).toContain("You chose: Keep working");
        expect(await page.boxes("main .flight-thread-message")).toHaveLength(messages.length);
        expect(await page.unclipped("main .flight-thread-input")).toEqual([true]);
        expect(page.errors()).toEqual([]);
        await page.screenshot(join(SHOTS, `flight-thread-${width}-light.png`));
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
