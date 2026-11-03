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
  "/api/settings/crew-pause": null,
  "/api/overview": {
    ...OVERVIEW,
    pipeline: [stage("ready", 5), stage("building", 7), stage("review", 0), stage("merged", 4)],
  },
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew?shape=summary": { rows: [...seats, ...loops], firstRunToday: null },
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
      `retains compact monitoring and complete readers at %i wide, ${colorScheme}`,
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

        // Crew and activity own the primary column; measured panels remain independent.
        const crew = await page.box("#agentsP");
        const timeline = await page.box("#timelineP");
        const machine = await page.box("#machineSummaryP");
        const log = await page.box("#actP");
        const summary = await page.box("#quotaSummaryP");
        expect(log.y).toBeGreaterThanOrEqual(crew.y + crew.height - 1);
        // Machine belongs to its independent analytical stack, not the primary row.
        expect(machine.height).toBeGreaterThan(0);
        if (width === 1920) {
          expect(summary.x).toBeGreaterThanOrEqual(crew.x + crew.width);
          expect(timeline.y).toBeGreaterThanOrEqual(summary.y + summary.height - 1);
        }

        // The Work column gets the room the others leave.
        const work = await page.boxes("#agentsList .trow:not(.head) .work-cell");
        for (const cell of work) expect(cell.width).toBeGreaterThanOrEqual(260);

        // Loops sit in a strip under the roster, not in it.
        const strip = await page.box("#agentsP .loops-strip");
        const list = await page.box("#agentsList");
        expect(strip.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
        expect(await page.boxes("#agentsP .loop-chip")).toHaveLength(2);

        // Reviewed8ce uses five aligned summaries; quiet lanes have words, not a blank card.
        const lanes = await page.boxes("#pipelineP .pipeline-stage");
        expect(lanes).toHaveLength(5);
        const empty = await page.box("#pipelineP .pipeline-stage.empty");
        const full = await page.box("#pipelineP .pipeline-stage.progress");
        expect(empty.width).toBeGreaterThanOrEqual(112);
        expect(empty.width).toBeLessThanOrEqual(full.width + 1);
        expect(empty.height).toBeLessThanOrEqual(96);
        const laneFacts = await page.evaluate(
          () =>
            [...document.querySelectorAll("#pipelineP .pipeline-stage")].map((lane) => ({
              heading: lane.querySelector("h3")!.getBoundingClientRect().top,
              count: lane.querySelector(".pipeline-counts")!.getBoundingClientRect().top,
              quiet: lane.classList.contains("empty"),
              text: lane.textContent,
              href: lane.querySelector("h3 a")?.getAttribute("href"),
              cards: lane.querySelectorAll(".pipeline-chip").length,
            })),
          undefined,
        );
        for (const lane of laneFacts) {
          expect(lane.href).toMatch(/^\/board\?stage=/);
          if (lane.quiet) {
            expect(lane.text).toContain("Observed empty");
            expect(lane.cards).toBe(0);
          }
          for (const peer of laneFacts.filter(
            (candidate) => Math.abs(candidate.heading - lane.heading) <= 1,
          ))
            expect(Math.abs(peer.count - lane.count)).toBeLessThanOrEqual(1);
        }
        expect((await page.box("#pipelineP")).height).toBeLessThanOrEqual(280);

        // Pipeline follows live Activity; analytical panels size their own columns.
        const pipeline = await page.box("#pipelineP");
        expect(pipeline.y).toBeGreaterThanOrEqual(log.y + log.height - 1);

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
        ).toEqual([
          "Agent",
          "State",
          "Work",
          "Tokens/min · 30m avg",
          "Cost",
          "Context · used / limit · left · used%",
          "In state",
        ]);

        // The complete existing allowance table is reached through its native reader.
        await page.click("#quotaSummaryP .quota-details");
        expect(await page.boxes("#quotaP tbody tr")).toHaveLength(3);
        expect(await page.reachable("#quotaP tbody tr", ".evidence-body")).not.toContain(false);
        await page.press("Escape");
        await page.click("#machineSummaryP > .ph button");
        expect(
          await page.evaluate(
            () => document.querySelectorAll("#machP .transcript-footprint").length,
            undefined,
          ),
        ).toBe(0);
        expect(await page.reachable("#machP .machine-window", ".evidence-body")).toEqual([true]);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
