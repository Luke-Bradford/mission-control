// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PAGE_PATHS } from "../src/router.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();
const HARNESS = "test/demoBrowser.html";
const SHOTS = process.env.MC_SHOT_DIR;

const open = (at: string, width = 1600, height = 900, colorScheme: "light" | "dark" = "light") =>
  renderAt({
    page: HARNESS,
    width,
    height,
    colorScheme,
    search: `?demo=1&at=${encodeURIComponent(at)}`,
  });

async function eventually(page: RenderedPage, read: () => Promise<boolean>, what: string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (page.errors().length) throw new Error(page.errors().join("; "));
    if (await read()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The fly-out is on screen: not hidden, not folded to its rail, with a box that takes text. */
const flyOutOpen = (page: RenderedPage) =>
  page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>("#dock");
    const box = document.querySelector<HTMLTextAreaElement>("#dockInput");
    const rect = box?.getBoundingClientRect();
    return Boolean(
      dock &&
        !dock.hidden &&
        !dock.classList.contains("collapsed") &&
        box &&
        !box.disabled &&
        rect &&
        rect.width > 0 &&
        rect.height > 0,
    );
  }, null);

describeRendered("The FLIGHT fly-out in the production App", () => {
  const PATHS = Object.entries(PAGE_PATHS);
  it.each(PATHS)(
    "opens with f on %s",
    async (_name, path) => {
      const page = await open(path);
      await page.box("header");
      // Start folded, so the press has something to open (the choice is remembered per browser).
      if (await flyOutOpen(page)) await page.press("f");
      await eventually(page, async () => !(await flyOutOpen(page)), "the fly-out to close");
      await page.press("f");
      await eventually(page, () => flyOutOpen(page), `the fly-out to open on ${path}`);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  const stoppedApi = {
    "/api/config": CONFIG,
    "/api/attention": [],
    "/api/crew?shape=summary": { rows: [], firstRunToday: null },
    "/api/flight": {
      seat: { id: "flight-1", call: "FLIGHT-1", model: "opus", state: "stopped", live: false },
      decisions: [],
    },
    "/api/comms/flight": { messages: [] },
    "/api/comms/crew": { messages: [] },
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "/api/comms/agents/inco-1": { messages: [], inbox: [], contacts: [], unread: 0 },
    "/api/comms/agents/inco-1?summary=1": { messages: [], inbox: [], contacts: [], unread: 0 },
  };
  const openStopped = async (path: string, width: number, height = 900) => {
    const page = await renderAt({
      page: HARNESS,
      width,
      height,
      search: `?at=${encodeURIComponent(path)}`,
      api: stoppedApi,
    });
    await page.box("header");
    if (!(await flyOutOpen(page))) await page.press("f");
    await eventually(page, () => flyOutOpen(page), "the fly-out");
    return page;
  };

  it(
    "with FLIGHT stopped, the box takes text, the line says FLIGHT is stopped with Start FLIGHT, and Send fits its button",
    async () => {
      for (const [path, width] of [
        [PAGE_PATHS.needs, 1280],
        [PAGE_PATHS.comms, 1600],
        [PAGE_PATHS.board, 1920],
      ] as const) {
        const page = await openStopped(path, width);
        await page.click("#dockInput");
        await page.press("h");
        await page.press("i");
        await eventually(
          page,
          () =>
            page.evaluate(() => {
              const box = document.querySelector<HTMLTextAreaElement>("#dockInput");
              const state = document.querySelector("#dockState")?.textContent ?? "";
              const start = [...document.querySelectorAll<HTMLElement>("#dockState button")].find(
                (b) => b.textContent === "Start FLIGHT",
              );
              const send = document.querySelector<HTMLElement>(".dsend button[type=submit]");
              const visible = (e: HTMLElement | null | undefined) =>
                Boolean(e && e.getBoundingClientRect().width > 0);
              return (
                box?.disabled === false &&
                box.value === "hi" &&
                state.includes("FLIGHT is stopped") &&
                visible(start) &&
                visible(send) &&
                (send?.scrollWidth ?? 1) <= (send?.clientWidth ?? 0)
              );
            }, null),
          `the stopped state at ${width} on ${path}`,
        );
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "beside the open fly-out at 1600, Comms' breadcrumb ends before its hint begins",
    async () => {
      const page = await openStopped(PAGE_PATHS.comms, 1600);
      await page.box(".comms-chat-title");
      expect(
        await page.evaluate(() => {
          const crumb = document.querySelector(".comms-chat-title .comms-breadcrumb");
          const hint = document.querySelector(".comms-chat-title .comms-chat-hint");
          if (!crumb || !hint) return false;
          return crumb.getBoundingClientRect().right <= hint.getBoundingClientRect().left + 0.5;
        }, null),
      ).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "at 1280 with the fly-out open, Comms gives the conversation room and the trail fits or ends in an ellipsis",
    async () => {
      const page = await openStopped(PAGE_PATHS.comms, 1280);
      await page.box("#chatP");
      const facts = await page.evaluate(() => {
        const chat = document.querySelector("#chatP")?.getBoundingClientRect();
        const crumb = document.querySelector<HTMLElement>(".comms-chat-title .comms-breadcrumb");
        const last = crumb?.lastElementChild as HTMLElement | null;
        return {
          chatW: chat?.width ?? 0,
          fits: crumb ? crumb.scrollWidth <= crumb.clientWidth + 1 : false,
          ellipsis: last ? getComputedStyle(last).textOverflow === "ellipsis" : false,
        };
      }, null);
      expect(facts.chatW).toBeGreaterThanOrEqual(420);
      expect(facts.fits || facts.ellipsis).toBe(true);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it.each([
    [1440, 900],
    [1600, 900],
  ])(
    "on an agent's Comms view at %i with the fly-out open, the conversation and its box keep their room",
    async (width, height) => {
      const page = await openStopped("/comms/agents/inco-1", width, height);
      await page.box(".comms-messages");
      const facts = await page.evaluate(
        () => ({
          messages: document.querySelector(".comms-messages")?.getBoundingClientRect().width ?? 0,
          box: document.querySelector("#comms-compose")?.getBoundingClientRect().width ?? 0,
        }),
        null,
      );
      expect(facts.messages).toBeGreaterThanOrEqual(360);
      expect(facts.box).toBeGreaterThanOrEqual(240);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "on Comms at 1280 with the fly-out open, the conversation keeps a useful height",
    async () => {
      const page = await openStopped(PAGE_PATHS.comms, 1280, 900);
      await page.box(".comms-messages");
      const height = await page.evaluate(
        () => document.querySelector(".comms-messages")?.getBoundingClientRect().height ?? 0,
        null,
      );
      expect(height).toBeGreaterThanOrEqual(400);
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  if (SHOTS) {
    it.each([
      [1280, 1000],
      [1600, 1000],
      [1920, 1000],
      [1600, 700],
      [2560, 1440],
    ])(
      "screenshots the fly-out at %i x %i",
      async (width, height) => {
        mkdirSync(SHOTS, { recursive: true });
        for (const theme of ["light", "dark"] as const)
          for (const [name, path] of [
            ["board", PAGE_PATHS.board],
            ["comms", PAGE_PATHS.comms],
            ["needs", PAGE_PATHS.needs],
            ["flight", PAGE_PATHS.flight],
          ] as const) {
            const page = await open(path, width, height, theme);
            await page.box("header");
            if (!(await flyOutOpen(page))) await page.press("f");
            await eventually(page, () => flyOutOpen(page), "the fly-out");
            await page.screenshot(join(SHOTS, `flyout-${name}-${width}x${height}-${theme}.png`));
          }
      },
      BROWSER_TEST_TIMEOUT_MS * 3,
    );
  }
});
