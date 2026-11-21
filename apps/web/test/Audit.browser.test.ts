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
  mergedPerDay: [1, 2, 3, 4, 5, 6].map((n) => ({
    day: now - n * 24 * HOUR,
    merged: 10 + n,
    noReview: 2,
    round1: 4 + n,
    round2: 3,
    round3: 1,
  })),
  findingFiles: [
    {
      file: "apps/web/src/pages/a-long-directory-name/another-long-directory/Audit.tsx",
      findings: 6,
      touches: 3,
    },
    { file: "apps/server/src/store.ts", findings: 5, touches: 0 },
  ],
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
  "/api/waste": {
    at: now,
    spend: [],
    alarms: [
      {
        id: 1,
        check: "review-rounds",
        subject: "guido-1:20261120T113955Z",
        repoId: "mission-control",
        ticket: "mission-control#1662",
        seatId: "guido-1",
        runId: "guido-1:20261120T113955Z",
        level: 5,
        evidence:
          "PR 2148 (mission-control#1662) is on review round 5; the limit is 2. Reviews stop until FLIGHT decides: fix or park. Runs and their blocking review findings: guido-1:20261120T113955Z (4), guido-1:20261120T101112Z (3), guido-2:20261120T091011Z (6).",
        openedAt: now - HOUR,
        closedAt: null,
        resolvedAt: null,
        basis: null,
      },
    ],
    checks: [],
    flight: [],
    counts: null,
  },
};

const { renderAt } = browserSession();

const LONG = "a-very-long-guard-rule-name-that-goes-on-and-on-and-on-and-on-and-on";
/** The audit with `n` guard-rule rows, each with a long title, so the list has to scroll inside its panel. */
const withRules = (n: number) => ({
  ...api,
  "/api/audit?range=30d": {
    ...audit,
    longRunners: [],
    prSizes: { prs: [], outliers: [] },
    deathLoops: [],
    reworkRounds: [],
    refusalSpikes: [],
    spendOutliers: [],
    chatter: [],
    flakes: [],
    questions: { asked: 0, answered: 0, answerMs: 0 },
    refusals: Array.from({ length: n }, (_, i) => ({
      agentId: "guido-1",
      runId: null,
      rule: `${LONG}-${String(i).padStart(2, "0")}`,
      count: 100 - i,
    })),
  },
  "/api/waste": { ...api["/api/waste"], alarms: [] },
});

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
        for (const toggle of await page.boxes(".audit-rt")) {
          expect(toggle.height).toBeGreaterThanOrEqual(24);
        }
        // The list keeps a scrollbar gutter on screen, so a cut list shows that it scrolls.
        const gutter = await page.evaluate(() => {
          const el = document.querySelector(".audit-next .audit-scroll");
          return el ? el.getBoundingClientRect().width - el.clientWidth : 0;
        }, null);
        expect(gutter).toBeGreaterThan(0);
        // A long evidence line wraps inside the panel: every detail heading stays within it.
        const panel = await page.box(".audit-next");
        for (const h of await page.boxes(".audit-mg h3")) {
          expect(h.x).toBeGreaterThanOrEqual(panel.x);
          expect(h.x + h.width).toBeLessThanOrEqual(panel.x + panel.width);
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

  for (const [n, rows] of [
    [0, 0],
    [1, 1],
    [50, 50],
  ] as const) {
    it(
      `holds ${n} rows with long titles inside the panel at 1920×940: page still, list scrolls, every row reachable by keyboard`,
      async () => {
        const page = await renderAt({
          page: "test/auditBarBrowser.html",
          width: 1920,
          height: 940,
          api: withRules(n),
        });
        const toggles = n === 0 ? [] : await page.boxes(".audit-rt");
        expect(toggles).toHaveLength(rows);
        const pageScrolls = () =>
          page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight, null);
        expect(await pageScrolls()).toBe(false);
        if (n === 0) {
          expect(await page.boxes(".audit-next .audit-empty")).toHaveLength(1);
          await page.close();
          return;
        }
        // Tab through every toggle: each takes focus in turn and shows a focus ring.
        const focused = new Set<string>();
        for (let i = 0; i < 200 && focused.size < rows; i++) {
          await page.press("Tab");
          const f = await page.evaluate(() => {
            const el = document.activeElement;
            if (!(el instanceof HTMLElement) || !el.classList.contains("audit-rt")) return null;
            const st = getComputedStyle(el);
            const ring =
              (st.outlineStyle !== "none" && Number.parseFloat(st.outlineWidth) > 0) ||
              st.boxShadow !== "none";
            const list = el.closest(".audit-scroll")?.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return {
              text: el.textContent ?? "",
              ring,
              inView: !!list && box.top >= list.top - 1 && box.bottom <= list.bottom + 1,
            };
          }, null);
          if (f === null) continue;
          expect(f.ring, f.text).toBe(true);
          // Focus scrolls the list, never the page, so the focused row is always on screen.
          expect(f.inView, f.text).toBe(true);
          focused.add(f.text);
        }
        expect(focused.size).toBe(rows);
        expect(await pageScrolls()).toBe(false);
        if (n === 50) {
          // The list scrolls inside its panel and reaches the final action.
          const scroll = await page.evaluate(() => {
            const el = document.querySelector(".audit-next .audit-scroll");
            if (!el) return null;
            const st = getComputedStyle(el);
            return {
              overflows: el.scrollHeight > el.clientHeight,
              scrollable: st.overflowY === "auto" || st.overflowY === "scroll",
              atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
            };
          }, null);
          expect(scroll).toMatchObject({ overflows: true, scrollable: true, atEnd: true });
          const end = await page.box(".audit-end");
          const list = await page.box(".audit-next .audit-scroll");
          expect(end.y + end.height).toBeLessThanOrEqual(list.y + list.height + 1);
        }
        // The full title of the last row is reachable by opening it.
        const last = [...focused].pop() ?? "";
        await page.evaluate(() => {
          const all = document.querySelectorAll<HTMLElement>(".audit-rt");
          const el = all[all.length - 1];
          // The first row starts open, so a single row is already showing its full title.
          if (el?.getAttribute("aria-expanded") !== "true") el?.click();
        }, null);
        const full = await page.evaluate(
          () => document.querySelector(".audit-fulltitle")?.textContent ?? "",
          null,
        );
        expect(last.endsWith(full.trim().slice(-20))).toBe(true);
        expect(full).toContain(LONG);
        expect(await pageScrolls()).toBe(false);
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
