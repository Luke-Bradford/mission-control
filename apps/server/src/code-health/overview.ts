import { createHash } from "node:crypto";
import {
  CODE_HEALTH_OVERVIEW_FILES_MAX,
  CODE_HEALTH_OVERVIEW_PAST_MAX,
  CODE_HEALTH_OVERVIEW_ROWS_MAX,
  CODE_HEALTH_OVERVIEW_VERSION,
  type CodeHealthFigure,
  type CodeHealthFigureState,
  type CodeHealthOverview,
  type CodeHealthPastItem,
  type CodeHealthWindow,
  codeHealthWindowBounds,
} from "@mc/core";
import type { Store } from "../store.ts";
import type { RecommendationRecord } from "./recommendations.ts";

/** Open proposals worth showing, strongest cause first; one order for the overview tab and this summary. */
export function rankProposals(rows: readonly RecommendationRecord[], at: number) {
  const priority = (rule: string) =>
    rule === "recurring-correction" ? 0 : rule === "repeated-rounds" ? 1 : 2;
  return rows
    .filter(
      (row) =>
        row.active &&
        (row.state.kind === "proposed" || (row.state.kind === "snoozed" && row.state.until <= at)),
    )
    .sort(
      (a, b) =>
        priority(a.rule) - priority(b.rule) ||
        (b.target.baseline ?? 0) - (a.target.baseline ?? 0) ||
        a.id.localeCompare(b.id),
    );
}

const percent = (part: number, whole: number) => (whole === 0 ? null : (part / whole) * 100);
const dayLabel = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A hash of what the page shows: time fields that move on every rebuild are left out. */
export function summaryRevision(body: Omit<CodeHealthOverview, "summaryRevision">): string {
  const text = JSON.stringify(body, (key, value) =>
    key === "generatedAt" || key === "sourceRevision" || key === "from" || key === "until"
      ? undefined
      : value,
  );
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** Builds the whole first screen from stored inputs and narrow aggregates; no git or network work. */
export function buildOverview(input: {
  store: Store;
  repoId: string;
  window: CodeHealthWindow;
  at: number;
  sourceRevision: string;
}): CodeHealthOverview {
  const { store, repoId, window, at, sourceRevision } = input;
  const { from, until } = codeHealthWindowBounds(window, at);
  const span = until - from;
  const prev = { from: from - span, until: from };
  const current = store.codeHealthMergedAggregate(repoId, from, until);
  const before = store.codeHealthMergedAggregate(repoId, prev.from, prev.until);
  const observed = store.codeHealthMergedObserved(repoId);
  const cost = store.codeHealthCostAggregate(repoId, from, until);
  const costBefore = store.codeHealthCostAggregate(repoId, prev.from, prev.until);
  const mergeCoverage =
    observed.first === null
      ? "No merged PRs are recorded for this repo."
      : observed.first > from
        ? `Merge records start ${dayLabel(observed.first)}. Earlier days in this window are not recorded, which is not the same as none merged.`
        : "Merge records cover the whole window.";

  const figure = (
    f: Pick<CodeHealthFigure, "id" | "label" | "value" | "unit" | "source" | "note"> &
      Partial<Pick<CodeHealthFigure, "numerator" | "denominator" | "coverage" | "updatedAt">> & {
        state?: CodeHealthFigureState;
        before?: number | null;
      },
  ): CodeHealthFigure => ({
    id: f.id,
    label: f.label,
    value: f.value,
    unit: f.unit,
    state: f.state ?? (f.value === null ? "unknown" : "available"),
    window: { label: window, from, until },
    comparison:
      f.before === undefined
        ? null
        : { label: `Previous ${window}`, value: f.before, from: prev.from, until: prev.until },
    numerator: f.numerator ?? null,
    denominator: f.denominator ?? null,
    source: f.source,
    coverage: f.coverage ?? mergeCoverage,
    updatedAt: f.updatedAt ?? current.newest,
    note: f.note,
  });

  const merged = figure({
    id: "merged",
    label: "Merged PRs",
    value: current.merged,
    unit: "merged PRs",
    before: before.merged,
    source: "Stored merge time of each merged PR",
    note: "Counted by the day each PR merged, in UTC.",
  });
  const hubReview = figure({
    id: "hub-review",
    label: "Merged PRs with a hub review",
    value: percent(current.reviewed, current.merged),
    unit: "% of merged PRs",
    numerator: current.reviewed,
    denominator: current.merged,
    before: percent(before.reviewed, before.merged),
    source: "Merged PRs linked to a reported hub review",
    note: "Measures whether a review record exists, not whether a review happened. A PR with no record is shown as no hub review, not as round zero.",
  });
  const rework = figure({
    id: "rework",
    label: "Reviewed PRs reaching round 2",
    value: percent(current.rework, current.reviewed),
    unit: "% of reviewed PRs",
    numerator: current.rework,
    denominator: current.reviewed,
    before: percent(before.rework, before.reviewed),
    source: "Highest reported review round of each PR merged in the window",
    note: "Only PRs with a reported hub review are in the denominator.",
  });
  const costState: CodeHealthFigureState =
    cost.priced === 0 ? "unknown" : cost.priced === cost.withRuns ? "available" : "partial";
  const costFigure = figure({
    id: "cost",
    label: "Median cost per merged PR",
    value: cost.median,
    unit: "USD, median of priced PRs",
    state: costState,
    numerator: cost.priced,
    denominator: cost.withRuns,
    before: costBefore.median,
    source: "Recorded cost of every run on the PR's branch",
    coverage:
      cost.withRuns === 0
        ? "No merged PR in this window has a run on record."
        : `${cost.priced} of ${cost.withRuns} merged PRs with runs have every run's cost recorded. The rest, for example Codex runs, are left out and not counted as free.`,
    updatedAt: current.newest,
    note: "Rebuilt with the summary; run cost is read at build time, so it can lag by up to ten minutes.",
  });

  const landing = store.codeHealthLandingAggregate(
    repoId,
    from,
    until,
    CODE_HEALTH_OVERVIEW_FILES_MAX,
  );
  const files = landing.rows.map((row) => ({
    ...row,
    ratio: figure({
      id: `landing:${row.path}`,
      label: `Findings per touch: ${row.path}`,
      value: row.touches === 0 ? null : row.findings / row.touches,
      unit: "findings per touch",
      numerator: row.findings,
      denominator: row.touches,
      source: "Distinct review findings on this file, over merged PRs that changed it",
      coverage:
        row.touches === 0
          ? "No merged PR in this window changed this file, so the ratio is undefined, not zero."
          : "Touches are the merged PRs whose changed-file list names this exact path.",
      updatedAt: landing.newest,
      note: "A finding repeated across review rounds of one PR counts once.",
    }),
  }));

  const decided = store.codeHealthDecidedRecommendations(repoId, CODE_HEALTH_OVERVIEW_PAST_MAX);
  const items: CodeHealthPastItem[] = decided.map((row) => {
    const result = row.remeasure;
    const outcome: CodeHealthPastItem["outcome"] =
      row.state.kind === "paid-off"
        ? "worked"
        : row.state.kind === "no-effect"
          ? "no-effect"
          : result === null
            ? "waiting"
            : result.change === "improved"
              ? "worked"
              : result.change;
    return {
      id: row.id,
      title: row.title ?? row.proposal,
      state: row.state.kind,
      decidedAt: row.baseline?.acceptedAt ?? row.updatedAt,
      metric: row.baseline?.target.metric ?? row.target.metric,
      baseline: row.baseline?.target.baseline ?? row.target.baseline,
      after: result && {
        at: result.at,
        current: result.current,
        change: result.change,
        note: result.note,
      },
      outcome,
    };
  });
  const measured = store.codeHealthRemeasureCounts(repoId);
  const funnel = store.codeHealthFunnel(repoId);

  const rows = rankProposals(store.codeHealthRecommendations(repoId, at), at)
    .slice(0, CODE_HEALTH_OVERVIEW_ROWS_MAX)
    .map((row) => ({ ...row, evidence: [] }));

  const verdict = (() => {
    if (current.merged === 0)
      return {
        tone: "unknown" as const,
        text: `No merged PRs are recorded in the last ${window}, so the build cannot be judged yet.`,
        figureIds: [merged.id],
      };
    const covered = `${current.reviewed} of ${current.merged} merged PRs have a hub review record`;
    if (current.reviewed === 0)
      return {
        tone: "unknown" as const,
        text: `${covered}, so rework cannot be judged for the last ${window}.`,
        figureIds: [merged.id, hubReview.id],
      };
    const rate = rework.value ?? 0;
    const was = rework.comparison?.value ?? null;
    const worse = was !== null && rate - was >= 5;
    return {
      tone: worse || (hubReview.value ?? 0) < 50 ? ("warn" as const) : ("ok" as const),
      text: `${current.rework} of ${current.reviewed} reviewed PRs needed a second round in the last ${window} (${Math.round(rate)}%${was === null ? "" : `, was ${Math.round(was)}%`}). ${covered}.`,
      figureIds: [rework.id, hubReview.id],
    };
  })();

  const body: Omit<CodeHealthOverview, "summaryRevision"> = {
    version: CODE_HEALTH_OVERVIEW_VERSION,
    repoId,
    window,
    generatedAt: at,
    sourceRevision,
    verdict,
    rows,
    figures: [merged, hubReview, rework, costFigure],
    // Nothing from outside the repo (releases, advisories, docs) is collected or stored yet.
    outside: {
      state: "not-collected",
      items: [],
      note: "Outside sources (new releases, advisories, vendor guides) are not collected yet, so none are listed rather than guessed.",
    },
    wasteAlarms: {
      state: "not-available",
      note: "Waste-alarm rows are not available yet; they arrive with the spend-alarm part of this page.",
    },
    build: { mergedPerDay: current.days, merged, hubReview, rework, cost: costFigure },
    landing: { files },
    past: {
      funnel,
      measured,
      items,
      detail: figure({
        id: "past",
        label: "What past recommendations achieved",
        value: items.length,
        unit: "decided proposals shown",
        source: "Stored acceptance and re-measure records",
        coverage: `Newest ${CODE_HEALTH_OVERVIEW_PAST_MAX} accepted or assessed proposals; the funnel counts every stored proposal. After-date results appear only once the hub has re-measured.`,
        updatedAt: decided.reduce<number | null>((a, row) => Math.max(a ?? 0, row.updatedAt), null),
        note: "A re-measure compares the same metric to the accepted baseline; it does not prove cause.",
      }),
    },
  };
  return { ...body, summaryRevision: summaryRevision(body) };
}
