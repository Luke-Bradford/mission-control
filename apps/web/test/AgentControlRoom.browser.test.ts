// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { crewSummary, WORK_SUMMARY_MAX } from "@mc/core";
import { expect, it } from "vitest";
import { agentView } from "./agentV2Fixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW, run, seatRow } from "./fixtures.ts";
import { handoffFixture } from "./handoffFixture.ts";

const { renderAt } = browserSession();
const view = agentView(
  seatRow({
    repoId: "mission-control",
    hudState: "running",
    loop: null,
    ticket: "mission-control#1703",
    ticketTitle: "Keep the complete Agents control room usable with a busy crew",
    summary:
      "The selected seat is completing its existing ticket and preserving the operator's current reading position. ".padEnd(
        WORK_SUMMARY_MAX,
        "Further checked work remains visible in the live activity. ",
      ),
  }),
);
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
].map(([id, role, mode, summary], index) =>
  seatRow({
    ...view.row,
    id: id ?? "",
    role: role ?? null,
    mode: mode === "writer" ? "writer" : "read-only",
    index,
    repoId: index < 6 ? "mission-control" : "shop-app",
    summary: (summary ?? "").padEnd(WORK_SUMMARY_MAX, " awkward.long.work-description"),
    ticket: index % 2 === 0 ? `mission-control#${1700 + index}` : null,
    ticketTitle:
      index % 2 === 0 ? "A long ticket title for a busy seat. ".repeat(7).slice(0, 240) : null,
    hudState: index % 3 === 0 ? "running" : "idle",
    lastOutputAt: NOW - (index + 1) * 60_000,
    digest: {
      toolCalls: 3,
      turns: 1,
      lastEventAt: NOW,
      model: view.row.model,
      contextTokens: 42000,
      contextWindow: 200000,
      liveTool: null,
      lastText: summary ?? null,
      tools: {},
      subagents: [],
      minuteTokens: [[NOW - (index + 1) * 60_000, 100 + index]],
      turnUsage: [],
      background: [],
      compactions: 0,
    },
  }),
);
const seatApi = Object.fromEntries(
  roster.flatMap((row) => [
    [`/api/agents/${row.id}`, agentView(row)],
    [
      `/api/agents/${row.id}/stream?limit=20`,
      { runId: row.run?.id, events: [], truncated: false, lastOutputAt: NOW, reason: null },
    ],
  ]),
);
const api = {
  ...seatApi,
  "/api/config": CONFIG,
  "/api/crew?shape=summary": crewSummary({ rows: roster, firstRunToday: null }),
  "/api/agents/guido-1": view,
  "/api/agents/guido-2": agentView(roster[4]),
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
    { width: 1920, height: 940, colorScheme: "light" as const },
    { width: 1920, height: 940, colorScheme: "dark" as const },
    { width: 2560, height: 1145, colorScheme: "light" as const },
    { width: 2560, height: 1145, colorScheme: "dark" as const },
  ])(
    "fits $width × $height in $colorScheme without page scrolling",
    async ({ width, height, colorScheme }) => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width,
        height,
        colorScheme,
        search: "?dock=folded",
        api,
      });
      await page.box(".agent-control-room");
      expect(
        await page.evaluate(
          () => ({
            page: document.documentElement.scrollHeight <= innerHeight + 1,
            hasLegacy: !!document.querySelector(".agent-v2-story, .agent-v2-deliverables, #sideP"),
            roster: document.querySelectorAll(".agent-roster-card").length,
            activityFillsWorkspace:
              Math.abs(
                (document.querySelector(".agent-live-activity")?.getBoundingClientRect().bottom ??
                  0) -
                  (document.querySelector(".agent-seat-workspace")?.getBoundingClientRect()
                    .bottom ?? 0),
              ) <= 1,
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
        activityFillsWorkspace: true,
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
      expect(
        await page.evaluate(
          () => document.querySelector(".agent-identity-words")?.getAttribute("title"),
          null,
        ),
      ).toBe(view.row.summary);
      const evidenceDir = process.env.MC_AGENT_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await page.screenshot(join(evidenceDir, `agents-${width}x${height}-${colorScheme}.png`));
      }
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
        ticket: null,
        ticketTitle: null,
      }));
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        api: {
          ...api,
          ...Object.fromEntries(
            many.flatMap((row) => [
              [`/api/agents/${row.id}`, agentView(row)],
              [
                `/api/agents/${row.id}/stream?limit=20`,
                {
                  runId: row.run?.id,
                  events: [],
                  truncated: false,
                  lastOutputAt: NOW,
                  reason: null,
                },
              ],
            ]),
          ),
          "/api/crew?shape=summary": crewSummary({ rows: many, firstRunToday: null }),
        },
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
      for (let group = 1; group <= 3; group++) {
        const selector = `.agent-roster-group:nth-child(${group}) > summary`;
        await page.click(selector);
        expect(
          await page.evaluate(
            () => document.querySelectorAll(".agent-roster-group[open]").length,
            null,
          ),
        ).toBe(2);
        await page.click(selector);
        expect(
          await page.evaluate(
            () => document.querySelectorAll(".agent-roster-group[open]").length,
            null,
          ),
        ).toBe(3);
      }
      await page.evaluate(() => {
        const card = [...document.querySelectorAll<HTMLButtonElement>(".agent-roster-card")].find(
          (el) => el.textContent?.includes("Seat 24 works"),
        );
        if (!card) throw new Error("Target seat absent");
        card.click();
      }, null);
      await page.box('.agent-identity-band[aria-label="agent-24 details"]');
      expect(
        await page.evaluate(() => {
          const current = document
            .querySelector<HTMLElement>(".agent-roster-card.on")
            ?.getBoundingClientRect();
          const list = document.querySelector(".agent-roster-list")?.getBoundingClientRect();
          return (
            !!current && !!list && current.top >= list.top - 1 && current.bottom <= list.bottom + 1
          );
        }, null),
      ).toBe(true);
      await page.press("j");
      await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 50)), null);
      expect(
        await page.evaluate(() => {
          const id = decodeURIComponent(location.pathname.split("/").at(-1) ?? "");
          const current = document
            .querySelector<HTMLElement>(".agent-roster-card.on")
            ?.getBoundingClientRect();
          const list = document.querySelector(".agent-roster-list")?.getBoundingClientRect();
          return (
            !!document.querySelector(`.agent-identity-band[aria-label="${id} details"]`) &&
            !!current &&
            !!list &&
            current.top >= list.top - 1 &&
            current.bottom <= list.bottom + 1
          );
        }, null),
      ).toBe(true);
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

  it(
    "clicks, enters, wraps keyboard order and restores selected content with Back",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        api,
      });
      await page.box(".agent-control-room");
      await page.click(".agent-roster-card");
      await page.box('.agent-identity-band[aria-label="flight-1 details"]');
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/flight-1");
      await page.press("k");
      await page.box('.agent-identity-band[aria-label="retro-2 details"]');
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/retro-2");
      await page.press("j");
      await page.box('.agent-identity-band[aria-label="flight-1 details"]');
      await page.evaluate(
        () => document.querySelectorAll<HTMLButtonElement>(".agent-roster-card")[1]?.focus(),
        null,
      );
      await page.press("Enter");
      await page.box('.agent-identity-band[aria-label="fao-1 details"]');
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/fao-1");
      await page.evaluate(() => history.back(), null);
      await page.box('.agent-identity-band[aria-label="flight-1 details"]');
      expect(await page.evaluate(() => location.pathname, null)).toBe("/agent/flight-1");
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens the saved handoff destination used by Board cards",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        search: `?at=${encodeURIComponent("/agent/guido-1?handoff=old")}`,
        api: { ...api, "/api/runs/old/handoff": handoffFixture },
      });
      await page.box("#agent-handoff");
      await page.click("#agent-handoff summary");
      expect(
        await page.evaluate(
          () => ({
            goal: document
              .querySelector(".handoff-body")
              ?.textContent?.includes("Preserve an unfinished ticket"),
            currentSeatShown: !!document.querySelector(".agent-control-room"),
          }),
          null,
        ),
      ).toEqual({ goal: true, currentSeatShown: false });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens the historical run destination used by Overview activity",
    async () => {
      const historic = run({ id: "historic-run", agentId: "guido-1", endedAt: NOW - 1000 });
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        search: `?at=${encodeURIComponent("/agent/guido-1?run=historic-run")}`,
        api: {
          ...api,
          "/api/agents/guido-1/runs?limit=50": [historic],
          "/api/runs/historic-run/loop": {
            runId: historic.id,
            loop: null,
            tries: [],
            events: [
              { key: "historic-event", at: NOW - 2000, text: "The preserved historical run event" },
            ],
            round: 0,
            budget: null,
            review: null,
          },
        },
      });
      await page.box(".trace-panel");
      expect(
        await page.evaluate(
          () => ({
            run: document.querySelector(".run-trace")?.textContent?.includes("historic-run"),
            event: document
              .querySelector(".run-trace")
              ?.textContent?.includes("The preserved historical run event"),
            currentSeatShown: !!document.querySelector(".agent-control-room"),
          }),
          null,
        ),
      ).toEqual({ run: true, event: true, currentSeatShown: false });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "shows a sent receipt before the served read receipt",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        api,
      });
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
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps a typed message through a page reload",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        api,
      });
      await page.box("#agentInput");
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>("#agentInput");
        if (!input) throw new Error("composer input missing");
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        set?.call(input, "Survive a reload.");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, null);
      await page.reload();
      await page.box("#agentInput");
      expect(
        await page.evaluate(
          () => document.querySelector<HTMLInputElement>("#agentInput")?.value ?? null,
          null,
        ),
      ).toBe("Survive a reload.");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
