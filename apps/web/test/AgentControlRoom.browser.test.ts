// @vitest-environment node
import { expect, it } from "vitest";
import { populatedAgentView } from "./agentV2Fixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const view = populatedAgentView();
const roster = [
  ["flight-1", "FLIGHT", "FLIGHT", "Keep every seat moving without losing operator context."],
  [
    "fao-1",
    "FAO",
    "planner",
    "Plan the long ticket title that must remain readable in the roster.",
  ],
  ["inco-1", "INCO", "writer", "Build the complete fixed-screen Agents control room."],
  ["guido-1", "GUIDO", "writer", "Implement the full detailed live activity transcript."],
  ["guido-2", "GUIDO", "writer", "Investigate a very long test failure from the current build."],
  [
    "retro-1",
    "RETRO",
    "reviewer",
    "Review the resulting implementation against the acceptance list.",
  ],
  ["flight-2", "FLIGHT", "FLIGHT", "Coordinate another repository's operator decision."],
  ["fao-2", "FAO", "planner", "Break down a complex operator request into ready work."],
  ["retro-2", "RETRO", "reviewer", "Check the accessible labels on all truncated work lines."],
].map(([id, role, mode, summary], index) => ({
  ...view.row,
  id,
  role,
  mode,
  index,
  repoId: index < 6 ? "mission-control" : "shop-app",
  summary,
  hudState: index === 0 ? "running" : "idle",
  lastOutputAt: NOW - (index + 1) * 60_000,
  digest: {
    ...view.row.digest,
    minuteTokens: [[NOW - (index + 1) * 60_000, 100 + index]],
  },
}));
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": { rows: roster, firstRunToday: null },
  "/api/agents/guido-1": view,
  "/api/agents/guido-2": { ...view, row: roster[4] },
  "/api/attention": [],
  "/api/limits": [],
  "/api/agents/guido-1/stream?limit=20": {
    runId: view.row.run?.id,
    events: [{ id: "1:0", at: NOW, kind: "op", text: "Build the Agent page." }],
    tasks: [],
    truncated: false,
    more: false,
  },
  "/api/agents/guido-2/stream?limit=20": {
    runId: view.row.run?.id,
    events: [{ id: "1:0", at: NOW, kind: "op", text: "Continue the second seat." }],
    tasks: [],
    truncated: false,
    more: false,
  },
  "/api/seats/guido-1/message": { ok: true, state: "delivered", deliveredAt: NOW },
  "/api/runs/r-12/loop": { loop: null },
};

describeRendered("Agent control room", () => {
  it.each([
    { width: 1920, height: 940 },
    { width: 2560, height: 1145 },
  ])(
    "fits $width × $height without page scrolling",
    async ({ width, height }) => {
      const page = await renderAt({ page: "test/agentV2Browser.html", width, height, api });
      await page.box(".agent-control-room");
      expect(
        await page.evaluate(
          () => ({
            page: document.documentElement.scrollHeight <= innerHeight + 1,
            hasLegacy: !!document.querySelector(".agent-v2-story, .agent-v2-deliverables, #sideP"),
            roster: document.querySelectorAll(".agent-roster-card").length,
            textFits: [
              ...document.querySelectorAll<HTMLElement>(
                ".agent-roster-card, .agent-identity-band, .agent-live-activity",
              ),
            ].every((el) => el.scrollWidth <= el.clientWidth + 1),
            rosterScrolls: (() => {
              const el = document.querySelector<HTMLElement>(".agent-roster-list");
              return !!el && el.scrollHeight > el.clientHeight;
            })(),
            activityMarks: document.querySelectorAll(".agent-roster-strip i").length,
            idleContext: document
              .querySelectorAll(".agent-roster-card")[1]
              ?.querySelector(".agent-roster-context")
              ?.textContent?.includes("—"),
          }),
          null,
        ),
      ).toEqual({
        page: true,
        hasLegacy: false,
        roster: 9,
        textFits: true,
        rosterScrolls: true,
        activityMarks: 9,
        idleContext: true,
      });
      expect(
        await page.unclipped(
          ".agent-roster, .agent-identity-band, .agent-live-activity, #agentInput",
        ),
      ).not.toContain(false);
      await page.press("j");
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/guido-2");
      await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 25)), null);
      expect(
        await page.evaluate(
          () => document.querySelector(".agent-roster-card.on")?.textContent?.includes("guido-2"),
          null,
        ),
      ).toBe(true);
      await page.press("k");
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/guido-1");
      await page.press("j");
      await page.evaluate(() => history.back(), null);
      await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 25)), null);
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/guido-1");
      expect(
        await page.evaluate(
          () => document.querySelector(".agent-roster-card.on")?.textContent?.includes("guido-1"),
          null,
        ),
      ).toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "groups and folds 25 seats without moving the page scroll",
    async () => {
      const many = Array.from({ length: 25 }, (_, index) => ({
        ...roster[index % roster.length],
        id: index === 0 ? "guido-1" : `agent-${index}`,
        index,
        repoId: ["mission-control", "shop-app", "docs-site"][index % 3] as string,
        summary: `Seat ${index} works on a deliberately long, readable operator work summary.`,
      }));
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        api: { ...api, "/api/crew?shape=summary": { rows: many, firstRunToday: null } },
      });
      await page.box(".agent-roster-list");
      expect(
        await page.evaluate(() => {
          const list = document.querySelector<HTMLElement>(".agent-roster-list");
          return {
            groups: document.querySelectorAll(".agent-roster-group").length,
            seats: document.querySelectorAll(".agent-roster-card").length,
            internalScroll: !!list && list.scrollHeight > list.clientHeight,
            pageScroll: document.documentElement.scrollHeight <= innerHeight + 1,
          };
        }, null),
      ).toEqual({ groups: 3, seats: 25, internalScroll: true, pageScroll: true });
      await page.click(".agent-roster-group summary");
      expect(
        await page.evaluate(
          () => document.querySelectorAll(".agent-roster-group[open]").length,
          null,
        ),
      ).toBe(2);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens a linked seat and does not poll the roster while idle",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        search: "?at=/agent/guido-2",
        api,
      });
      await page.box(".agent-control-room");
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/guido-2");
      const crewRequests = () =>
        page.requests().filter((request) => request.path === "/api/crew?shape=summary").length;
      const initial = crewRequests();
      await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 30_000)), null);
      expect(crewRequests()).toBe(initial);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it("shows a sent receipt before the served read receipt", async () => {
    const page = await renderAt({ page: "test/agentV2Browser.html", width: 1920, height: 940, api });
    await page.box("#agentInput");
    await page.evaluate(() => {
      const lines: string[] = [];
      const observer = new MutationObserver(() => {
        const line = document.querySelector(".composer [role=status]")?.textContent?.trim();
        if (line && !lines.includes(line)) lines.push(line);
      });
      observer.observe(document.querySelector(".composer") as Node, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      (window as unknown as { receiptLines: string[] }).receiptLines = lines;
      const input = document.querySelector<HTMLInputElement>("#agentInput");
      if (!input) throw new Error("composer input missing");
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "Please check the guard.");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, null);
    await page.click("#agentForm button.primary");
    await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 25)), null);
    expect(
      await page.evaluate(
        () => (window as unknown as { receiptLines: string[] }).receiptLines,
        null,
      ),
    ).toEqual(["Message sent.", "Message read."]);
    await page.close();
  }, BROWSER_TEST_TIMEOUT_MS);
});
