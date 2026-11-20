// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 20, 12);
const audit = {
  range: { since: now - 30 * 24 * HOUR, until: now },
  longRunners: [1, 2, 3].map((n) => ({
    runId: `r${n}`,
    agentId: `guido-${n}`,
    ticket: `mission-control#${n}`,
    startedAt: now - 9 * HOUR,
    durationMs: (6 + n) * HOUR,
  })),
  deathLoops: [{ runId: "d", agentId: "retro-1", parks: 4 }],
  reworkRounds: [{ runId: "w", agentId: "guido-1", rounds: 5, maxRound: 5 }],
  refusalsByRule: [{ rule: "git-env", count: 8 }],
  refusals: [
    { agentId: "guido-1", runId: "x", rule: "git-env", count: 5 },
    { agentId: "guido-2", runId: null, rule: "full-suite", count: 3 },
  ],
  refusalSpikes: [{ agentId: "guido-1", day: now - 2 * 24 * HOUR, count: 12 }],
  spendOutliers: [{ runId: "e", agentId: "guido-1", ticket: "mission-control#7", costUsd: 42.5 }],
  costPerMergedTicket: [{ ticket: "mission-control#7", costUsd: 42.5 }],
  prSizes: {
    prs: [1, 2, 3, 4, 5].map((n) => ({
      repoId: "mission-control",
      number: n,
      ticket: `mission-control#${n}`,
      mergedAt: now - n * 24 * HOUR,
      additions: n * 400,
      deletions: 0,
      changedFiles: n,
    })),
    outliers: [],
  },
  modelPromptTimeline: [],
  questions: { asked: 7, answered: 5, answerMs: HOUR },
  chatter: [{ from: "inco-1", to: "retro-1", ticket: "mission-control#862", rounds: 12 }],
  flakes: [{ key: "web:unit/Audit", count: 3, lastAt: now - HOUR }],
  changes: [],
  reviewRounds: {
    prs: [
      { rounds: 1, count: 5 },
      { rounds: 2, count: 3 },
    ],
    late: [],
  },
  surgeonProposals: [],
};

const api = {
  "/api/audit?range=30d": audit,
  "/api/config": { loops: [], crew: { sessions: [] } },
  "/api/waste": { at: now, spend: [], alarms: [], checks: [], flight: [], counts: null },
};

const { renderAt } = browserSession();

describeRendered("Audit first screen in a browser", () => {
  for (const [width, height] of [
    [1920, 940],
    [2560, 1145],
  ] as const) {
    it(
      `shows the verdict, five ranked rows and the three right-hand panels at ${width}×${height} without page scroll`,
      async () => {
        const page = await renderAt({ page: "test/auditBarBrowser.html", width, height, api });
        const rows = await page.boxes("tr.rec");
        expect(rows.length).toBeGreaterThanOrEqual(5);
        const verdict = await page.box(".audit-verdict-text");
        expect(verdict.y + verdict.height).toBeLessThanOrEqual(height);
        for (const row of rows.slice(0, 5)) expect(row.y + row.height).toBeLessThanOrEqual(height);
        for (const panel of [".audit-health", ".audit-files", ".audit-past"]) {
          const box = await page.box(panel);
          expect(box.y + box.height).toBeLessThanOrEqual(height);
        }
        const scrolls = await page.evaluate(
          () => document.documentElement.scrollHeight > window.innerHeight,
          null,
        );
        expect(scrolls).toBe(false);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
