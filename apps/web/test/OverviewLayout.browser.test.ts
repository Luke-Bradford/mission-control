// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LimitRow, PipelineStage } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import {
  CONFIG,
  crewRow,
  limit5h,
  limit7d,
  METRICS_VIEW,
  NOW,
  OVERVIEW,
  seatRow,
} from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "overview-shots");

const STATES = ["running", "running", "idle", "waiting", "running", "idle"] as const;
const seats = Array.from({ length: 11 }, (_, i) =>
  seatRow({ id: `seat-${i}`, index: i, hudState: STATES[i % STATES.length] }),
);
const loops = [
  crewRow({ id: "ebull-ta", index: 12, hudState: "running" }),
  crewRow({ id: "studio-builder", index: 13, hudState: "idle" }),
];
const card = (ticket: number) => ({
  repoId: "shop-app",
  ticket,
  title: `Ticket ${ticket} with a long title that has to be cut to two lines at most`,
  pr: null,
  ci: [],
  since: NOW - 60_000,
  who: "seat-1",
});
const stage = (name: PipelineStage["stage"], count: number): PipelineStage => ({
  stage: name,
  count,
  oldestAt: count ? NOW - 60_000 : null,
  cards: Array.from({ length: Math.min(count, 2) }, (_, i) => card(i + 1)),
});
const limits: LimitRow[] = [
  limit5h({ accountId: "claude-main", used: 41 }),
  limit7d({ accountId: "claude-main", used: 63, fullAt: NOW + 50 * 3_600_000 }),
  limit7d({ accountId: "codex-main", used: 12 }),
];
const accounts = [
  { id: "claude-main", vendor: "claude" as const, alertAt: 70, stopAt: 80 },
  { id: "codex-main", vendor: "codex" as const, alertAt: 70, stopAt: 80 },
];

const api = {
  "/api/overview": {
    ...OVERVIEW,
    pipeline: [stage("ready", 5), stage("building", 7), stage("review", 0), stage("merged", 4)],
  },
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew": { rows: [...seats, ...loops], firstRunToday: null },
  "/api/attention": [],
  "/api/machine": { latest: null, warning: null },
  "/api/limits": limits,
  "/api/limits/github": { queries: {}, pollCost: null },
  "/api/health": [],
  "/api/activity": [
    {
      at: NOW - 60_000,
      kind: "comms",
      who: "MC",
      to: "seat-1",
      text: `${"a long message ".repeat(30)}end`,
      ref: null,
      url: null,
      status: null,
      prs: [],
      summary: null,
    },
  ],
  "/api/settings/away": { on: false, until: "", may: {} },
  "/api/config": { ...CONFIG, accounts },
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true, note: null },
};

describeRendered("Overview v2 layout in a browser", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    it.each([1280, 1600, 1920])(
      `lays out as the mockup at %i wide, ${colorScheme}`,
      async (width) => {
        mkdirSync(SHOTS, { recursive: true });
        const page = await renderAt({
          page: "test/overviewBrowser.html",
          width,
          height: 1000,
          colorScheme,
          api,
        });
        await page.screenshot(join(SHOTS, `overview-${width}-${colorScheme}.png`));

        // Nothing spills sideways.
        expect(await page.unclipped("#page-overview")).toEqual([true]);

        // Crew beside Timeline: the Timeline takes the mockup's share of the row.
        const crew = await page.box("#agentsP");
        const timeline = await page.box("#timelineP");
        expect(Math.abs(crew.y - timeline.y)).toBeLessThan(2);
        const share = timeline.width / (crew.width + timeline.width + 12);
        const target = width <= 1280 ? 0.34 : width >= 1920 ? 0.27 : 0.31;
        expect(Math.abs(share - target)).toBeLessThan(0.02);

        // The Work column gets the room the others leave.
        const work = await page.boxes("#agentsList .trow:not(.head) .work-cell");
        for (const cell of work) expect(cell.width).toBeGreaterThanOrEqual(140);

        // Loops sit in a strip under the roster, not in it.
        const strip = await page.box("#agentsP .loops-strip");
        const list = await page.box("#agentsList");
        expect(strip.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
        expect(await page.boxes("#agentsP .loop-chip")).toHaveLength(2);

        // The empty In review lane is narrow beside its flexible neighbours.
        const lanes = await page.boxes("#pipelineP .pipeline-stage");
        expect(lanes).toHaveLength(5);
        const empty = await page.box("#pipelineP .pipeline-stage.empty");
        const full = await page.box("#pipelineP .pipeline-stage.progress");
        expect(empty.width).toBeLessThan(full.width / 2);

        // Live log, Machine and Quota share one row.
        const log = await page.box("#actP");
        const machine = await page.box("#machP");
        const quota = await page.box("#quotaP");
        expect(Math.abs(log.y - machine.y)).toBeLessThan(2);
        expect(Math.abs(log.y - quota.y)).toBeLessThan(2);
        expect(log.x).toBeLessThan(machine.x);
        expect(machine.x).toBeLessThan(quota.x);

        // A long Comms message is one line and its "read" link stays visible and reachable.
        await page.evaluate(() => {
          for (const b of document.querySelectorAll<HTMLElement>("#actP button")) {
            if (b.textContent === "Messages") b.click();
          }
        }, undefined);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)), undefined);
        const row = await page.box("#actList .arow.k-comms");
        expect(row.height).toBeLessThan(40);
        const read = await page.box("#actList .arow.k-comms .log-read");
        expect(read.height).toBeGreaterThanOrEqual(24);
        expect(read.x + read.width).toBeLessThanOrEqual(row.x + row.width + 1);
        expect(
          await page.evaluate(() => {
            const link = document.querySelector<HTMLElement>("#actList .log-read");
            link?.focus();
            return document.activeElement === link;
          }, undefined),
        ).toBe(true);

        // The roster has the seven approved columns.
        expect(
          await page.evaluate(
            () =>
              [...document.querySelectorAll("#agentsList [role=columnheader]")].map(
                (h) => h.textContent,
              ),
            undefined,
          ),
        ).toEqual(["Agent", "State", "Work", "Tokens · 30 min", "Cost", "Context", "In state"]);

        // The page stays on one screen.
        const bottom = await page.evaluate(
          () =>
            Math.max(
              ...[...document.querySelectorAll(".panel")].map(
                (p) => p.getBoundingClientRect().bottom,
              ),
            ),
          undefined,
        );
        expect(bottom).toBeLessThanOrEqual(1000);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
