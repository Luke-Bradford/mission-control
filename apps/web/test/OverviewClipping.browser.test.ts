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
const GIB = 2 ** 30;

const STATES = ["running", "running", "idle", "waiting", "running", "idle"] as const;
const seats = Array.from({ length: 11 }, (_, i) =>
  seatRow({ id: `seat-${i}`, index: i, hudState: STATES[i % STATES.length] }),
);
const loops = [
  crewRow({ id: "ebull-ta", index: 12 }),
  crewRow({ id: "studio-builder", index: 13 }),
];
const card = (stage: string, ticket: number) => ({
  repoId: "shop-app",
  ticket,
  // Merged cards carry their PR title, which usually ends in the number.
  title:
    stage === "merged"
      ? `feat(web): a long pull request title that has to be cut to two lines (#${ticket})`
      : `Ticket ${ticket} with a long title that has to be cut to two lines at most`,
  pr: stage === "merged" ? ticket : null,
  ci: [],
  since: NOW - 60_000,
  who: "seat-1",
});
const stage = (name: PipelineStage["stage"], count: number): PipelineStage => ({
  stage: name,
  count,
  oldestAt: count ? NOW - 60_000 : null,
  cards: Array.from({ length: Math.min(count, 8) }, (_, i) => card(name, i + 1)),
});
const limits: LimitRow[] = [
  limit5h({ accountId: "claude-main", used: 41 }),
  limit7d({ accountId: "claude-main", used: 63, fullAt: NOW + 50 * 3_600_000 }),
  limit7d({ accountId: "codex-main", used: 12, fullAt: NOW + 6 * 24 * 3_600_000 }),
];
const accounts = [
  { id: "claude-main", vendor: "claude" as const, alertAt: 70, stopAt: 80 },
  { id: "codex-main", vendor: "codex" as const, alertAt: 70, stopAt: 80 },
];
const comms = (i: number) => ({
  at: NOW - i * 60_000,
  kind: "comms",
  who: "MC",
  to: "seat-1",
  text: `message ${i} ${"words ".repeat(40)}`,
  ref: null,
  url: null,
  status: null,
  prs: [],
  summary: null,
});

const api = {
  "/api/overview": {
    ...OVERVIEW,
    pipeline: [
      stage("ready", 5),
      stage("building", 7),
      stage("review", 0),
      stage("merging", 0),
      stage("merged", 4),
    ],
  },
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew": { rows: [...seats, ...loops], firstRunToday: null },
  "/api/attention": [],
  "/api/machine": {
    latest: {
      at: NOW,
      cpuPct: 37.4,
      cores: 16,
      memUsedBytes: 20.5 * GIB,
      memTotalBytes: 64 * GIB,
      diskFreeBytes: 412 * GIB,
      diskTotalBytes: 1000 * GIB,
      agents: { count: 3, rssBytes: 2 * GIB, cpuPct: 80 },
    },
    warning: null,
    transcripts: {
      totalBytes: 12.3 * 2 ** 20,
      oldestAt: NOW - 3 * 3_600_000,
      seats: [{ seatId: "seat-1", bytes: 8 * 2 ** 20, files: 3 }],
    },
  },
  "/api/limits": limits,
  "/api/limits/github": { queries: {}, pollCost: null },
  "/api/health": [],
  "/api/activity": Array.from({ length: 12 }, (_, i) => comms(i + 1)),
  "/api/settings/away": { on: false, until: "", may: {} },
  "/api/config": { ...CONFIG, accounts },
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true, note: null },
};

/** Panels whose body is a list that scrolls with a visible scrollbar. Every other panel shows all of its content. */
const SCROLLING_PANELS = ["agentsP", "timelineP", "actP"];

interface Problems {
  problems: string[];
}

describeRendered("Overview panels never clip or wrap their header", () => {
  for (const [width, height] of [
    [1280, 1000],
    [1600, 1000],
  ] as const) {
    for (const colorScheme of ["light", "dark"] as const) {
      it(
        `at ${width}x${height}, ${colorScheme}`,
        async () => {
          mkdirSync(SHOTS, { recursive: true });
          const page = await renderAt({
            page: "test/overviewBrowser.html",
            width,
            height,
            colorScheme,
            api,
          });
          await page.screenshot(join(SHOTS, `overview-clip-${width}-${colorScheme}.png`));
          const { problems } = await page.evaluate((scrolling: string[]): Problems => {
            const out: string[] = [];
            const box = (el: Element) => el.getBoundingClientRect();
            for (const panel of document.querySelectorAll<HTMLElement>("#page-overview .panel")) {
              const id = panel.id;
              // the header stays on one line
              const ph = panel.querySelector<HTMLElement>(":scope > .ph");
              if (ph) {
                const parts = [
                  ...ph.children,
                  ...(ph.querySelector(".act")?.children ?? []),
                ].filter((el) => box(el).width > 0);
                const tops = parts.map((el) => box(el).top);
                const spread = Math.max(...tops) - Math.min(...tops);
                if (spread > 8) out.push(`${id}: header wraps (${spread}px)`);
              }
              // nothing is cut off by the panel itself
              if (panel.scrollHeight > panel.clientHeight + 1) {
                out.push(`${id}: panel clips ${panel.scrollHeight - panel.clientHeight}px`);
              }
              for (const el of panel.querySelectorAll<HTMLElement>("*")) {
                const style = getComputedStyle(el);
                const scrollsY = /auto|scroll/.test(style.overflowY);
                const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
                const over = el.scrollHeight - el.clientHeight;
                if (over <= 1 || el.clientHeight === 0 || el.closest(".sr-only")) continue;
                // line clamps and ellipsis are meant; real blocks are not
                if (style.webkitLineClamp !== "none" && style.webkitLineClamp !== "") continue;
                if (scrollsY && !scrolling.includes(id)) {
                  out.push(`${id}: ${el.className || el.tagName} scrolls instead of showing`);
                } else if (clipsY && style.display !== "-webkit-box") {
                  out.push(`${id}: ${el.className || el.tagName} clips ${over}px`);
                }
              }
            }
            // pipeline cards are whole
            const lanes = document.querySelectorAll<HTMLElement>("#pipelineP .pipeline-stage");
            const body = document.querySelector<HTMLElement>("#pipelineP")?.getBoundingClientRect();
            for (const chip of document.querySelectorAll<HTMLElement>(
              "#pipelineP .pipeline-chip",
            )) {
              if (body && box(chip).bottom > body.bottom + 1) out.push("pipeline: card cut off");
            }
            if (lanes.length === 0) out.push("pipeline: no lanes");
            return { problems: out };
          }, SCROLLING_PANELS);
          expect(problems).toEqual([]);
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  // A short screen scrolls the page instead of cutting content off.
  for (const colorScheme of ["light", "dark"] as const) {
    it(
      `at 1600x700, ${colorScheme}, the page scrolls and every Board link is reachable`,
      async () => {
        const page = await renderAt({
          page: "test/overviewBrowser.html",
          width: 1600,
          height: 700,
          colorScheme,
          api,
        });
        expect(await page.reachable("#pipelineP .pipeline-more")).not.toContain(false);
        expect(await page.reachable(".overview-metrics")).toEqual([true]);
        expect(await page.reachable("#pipelineP .pipeline-chip")).not.toContain(false);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
