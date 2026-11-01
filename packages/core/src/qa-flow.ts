import type { DefectRefs, DefectVia, PrFileInput } from "./qa-flow-model.ts";

export type { DefectRefs, DefectVia, PrFileInput } from "./qa-flow-model.ts";

import { type MetricDef, percentile } from "./metrics.ts";

/** Fewer rounds than this is anecdote: a ratio is still reported, marked `enough: false`. */
export const REWORK_MIN_ROUNDS = 3;

/** The label that marks an issue as a bug. */
export const BUG_LABEL = "bug";
export const isBugLabelled = (labels: readonly string[]): boolean =>
  labels.some((l) => l.toLowerCase() === BUG_LABEL);

const SCOPE = "Scope: the crew sessions' repos.";

/** The QA board's workflow figures. One definition each, served beside the numbers. */
export const QA_FLOW_METRICS = {
  escapedDefects: {
    label: "Escaped defects",
    window: "selected range",
    unit: "defects",
    definition: `Issues labelled bug, filed after a pull request merged in the selected range, whose body names that pull request (#N or its URL), one of its commits (a sha of 7 or more characters: the merge commit, the head, or a commit the hub made for its branch), or a file that exactly one pull request merged in the 90 days before the bug was filed changed. A file two or more of them changed is left out. The pull request must have merged in the selected range. Counted once per issue and pull request. ${SCOPE}`,
    source: "GET /api/qa/flow (escapedDefects)",
    from: "server",
  },
  reviewCheck: {
    label: "Review state",
    window: "now",
    unit: "state",
    definition:
      "The newest review of the PR that is not superseded: queued (waiting, with its place in the review seat's queue), checking (the seat and when it started; a starting review counts), sent (blocking findings reported and the developer fixing), ready (a clean report with nothing holding the merge), held (a controller check, the operator's acceptance, a merge hold, FLIGHT's clearance, or any other park). A failed attempt reads queued until the cap, then held.",
    source: "GET /api/repos/:repoId/prs (check) and GET /api/crew (review.check)",
    from: "server",
  },
  reviewWait: {
    label: "Review wait",
    window: "selected range",
    unit: "milliseconds",
    definition: `Per pull request head: from the review being queued to a reviewer starting it. Heads whose review ended in the selected range and was reported; a review that never started is left out. Summarised as median and p85. ${SCOPE}`,
    source: "GET /api/qa/flow (reviewTimings)",
    from: "server",
  },
  reviewTime: {
    label: "Review time",
    window: "selected range",
    unit: "milliseconds",
    definition: `Per pull request head: from a reviewer starting the review to its report. Heads whose review ended in the selected range and was reported. Summarised as median and p85. ${SCOPE}`,
    source: "GET /api/qa/flow (reviewTimings)",
    from: "server",
  },
  reworkRatio: {
    label: "Rework ratio",
    window: "selected range",
    unit: "rounds",
    definition: `Reported review rounds with at least one blocking finding, over all reported rounds that ended in the selected range, per author seat and per model. Under ${REWORK_MIN_ROUNDS} rounds is marked as too few to judge. ${SCOPE}`,
    source: "GET /api/qa/flow (rework)",
    from: "server",
  },
  testsPerPr: {
    label: "Tests per PR",
    window: "selected range",
    unit: "test files",
    definition: `Test files (*.test.*, *.spec.*, or under test/, tests/ or __tests__/) a merged pull request added or changed, from its diff; deletions are not counted. Pull requests merged in the selected range. The diff is read up to its first 100 files. ${SCOPE}`,
    source: "GET /api/qa/flow (testsPerPr)",
    from: "server",
  },
} as const satisfies Readonly<Record<string, MetricDef>>;
export type QaFlowMetricId = keyof typeof QA_FLOW_METRICS;

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pull requests, commits and files a bug body names. A PR URL counts only for `repo`
 * (`owner/name`); a bare `#N` is this repo's.
 */
export function parseDefectRefs(body: string, repo?: string): DefectRefs {
  const prs = [...body.matchAll(/(?:^|[^\w/])#(\d+)\b/g)].map((m) => Number(m[1]));
  if (repo !== undefined) {
    const url = new RegExp(`github\\.com/${escapeRe(repo)}/pull/(\\d+)\\b`, "gi");
    for (const m of body.matchAll(url)) prs.push(Number(m[1]));
  }
  // A sha has a digit in it, so plain words made of a-f do not read as one.
  const shas = [...body.matchAll(/\b[0-9a-f]{7,40}\b/gi)]
    .map((m) => m[0].toLowerCase())
    .filter((s) => /\d/.test(s));
  const paths = [...body.matchAll(/(?<![\w./:-])[\w.@-]+(?:\/[\w.@-]+)+\.\w+/g)].map((m) => m[0]);
  return { prs: uniq(prs), shas: uniq(shas), paths: uniq(paths) };
}

/** A merged pull request as the escaped-defect link sees it. */
export interface MergedPrFacts {
  number: number;
  mergedAt: number;
  shas: string[];
  files: string[];
}

const VIA_RANK: Record<DefectVia, number> = { pr: 0, commit: 1, file: 2 };

/**
 * The merged pull requests a bug is recorded against. `prs` are those merged in the window; only
 * ones merged before the bug was filed count. A PR named twice keeps its strongest route.
 */
export function linkEscapedDefect(
  bug: { createdAt: number; refs: DefectRefs },
  prs: readonly MergedPrFacts[],
): { prNumber: number; via: DefectVia }[] {
  const before = prs.filter((p) => p.mergedAt <= bug.createdAt);
  const found = new Map<number, DefectVia>();
  const add = (prNumber: number, via: DefectVia): void => {
    const had = found.get(prNumber);
    if (had === undefined || VIA_RANK[via] < VIA_RANK[had]) found.set(prNumber, via);
  };
  for (const p of before) {
    if (bug.refs.prs.includes(p.number)) add(p.number, "pr");
    if (bug.refs.shas.some((s) => p.shas.some((h) => h.toLowerCase().startsWith(s))))
      add(p.number, "commit");
  }
  for (const path of bug.refs.paths) {
    const touching = before.filter((p) => p.files.includes(path));
    if (touching.length === 1 && touching[0]) add(touching[0].number, "file");
  }
  return [...found].map(([prNumber, via]) => ({ prNumber, via }));
}

export interface ReviewHeadInput {
  reviewId: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
export interface ReviewHeadTiming {
  reviewId: number;
  reviewWaitMs: number;
  reviewMs: number;
}
export interface TimingSummary {
  n: number;
  medianMs: number | null;
  p85Ms: number | null;
}

const summarise = (xs: number[]): TimingSummary => ({
  n: xs.length,
  medianMs: percentile(xs, 50),
  p85Ms: percentile(xs, 85),
});

/** Wait and review time per head, left out when the review never started or ended. */
export function reviewTimings(rows: readonly ReviewHeadInput[]): {
  heads: ReviewHeadTiming[];
  wait: TimingSummary;
  review: TimingSummary;
} {
  const heads: ReviewHeadTiming[] = [];
  for (const r of rows) {
    if (r.startedAt === null || r.endedAt === null) continue;
    heads.push({
      reviewId: r.reviewId,
      reviewWaitMs: Math.max(0, r.startedAt - r.createdAt),
      reviewMs: Math.max(0, r.endedAt - r.startedAt),
    });
  }
  return {
    heads,
    wait: summarise(heads.map((h) => h.reviewWaitMs)),
    review: summarise(heads.map((h) => h.reviewMs)),
  };
}

export interface ReworkGroup {
  key: string;
  rounds: number;
  reworked: number;
  ratio: number;
  enough: boolean;
}

function groupRework(rows: readonly { key: string; blocking: number }[]): ReworkGroup[] {
  const by = new Map<string, { rounds: number; reworked: number }>();
  for (const r of rows) {
    const g = by.get(r.key) ?? { rounds: 0, reworked: 0 };
    g.rounds += 1;
    if (r.blocking > 0) g.reworked += 1;
    by.set(r.key, g);
  }
  return [...by]
    .map(([key, g]) => ({
      key,
      ...g,
      ratio: g.reworked / g.rounds,
      enough: g.rounds >= REWORK_MIN_ROUNDS,
    }))
    .sort((a, b) => b.rounds - a.rounds || a.key.localeCompare(b.key));
}

/** Rounds with a blocking finding over rounds, per author seat and per model. */
export function reworkRatios(
  rounds: readonly { seat: string; model: string; blocking: number }[],
): { bySeat: ReworkGroup[]; byModel: ReworkGroup[] } {
  return {
    bySeat: groupRework(rounds.map((r) => ({ key: r.seat, blocking: r.blocking }))),
    byModel: groupRework(rounds.map((r) => ({ key: r.model, blocking: r.blocking }))),
  };
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[^/]+$/;
export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

/** Test files a diff added and changed; a deleted test is neither. */
export function testsTouched(files: readonly PrFileInput[]): { added: number; changed: number } {
  let added = 0;
  let changed = 0;
  for (const f of files) {
    if (!isTestPath(f.path) || f.changeType === "DELETED") continue;
    if (f.changeType === "ADDED") added += 1;
    else changed += 1;
  }
  return { added, changed };
}

export interface EscapedDefectView {
  repoId: string;
  issueNumber: number;
  prNumber: number;
  via: DefectVia;
  filedAt: number;
  mergedAt: number;
  seat: string | null;
  model: string | null;
}

export interface PrTestsView {
  repoId: string;
  prNumber: number;
  mergedAt: number;
  added: number;
  changed: number;
}

/** `GET /api/qa/flow`. */
export interface QaFlowView {
  days: number;
  since: number;
  metrics: typeof QA_FLOW_METRICS;
  escapedDefects: EscapedDefectView[];
  reviewTimings: ReturnType<typeof reviewTimings> & {
    heads: (ReviewHeadTiming & { repoId: string; prNumber: number; sha: string })[];
  };
  rework: ReturnType<typeof reworkRatios>;
  testsPerPr: PrTestsView[];
}
