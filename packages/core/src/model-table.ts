/** A group or side under this many runs shows counts only: no rate is drawn from it. */
export const MODEL_TABLE_MIN_RUNS = 20;
/** How far each side of a model change reaches. */
export const MODEL_CHANGE_SIDE_MS = 30 * 86_400_000;

/** How a model group is split further. */
export const MODEL_SPLITS = ["none", "type", "size", "plan"] as const;
export type ModelSplit = (typeof MODEL_SPLITS)[number];

/** One build run with a reported review, as the model table counts it. */
export interface ModelRunRow {
  runId: string;
  /** The build seat. */
  seatId: string;
  /** The seat of the run's first reported review, if any. */
  reviewSeatId: string | null;
  /** The run's ticket, `repo#n`; tokens per merged ticket counts each once. */
  ticket: string;
  model: string | null;
  effort: string | null;
  /** The template profile's name. */
  template: string | null;
  /** True when the run had a plan; a Size waiver is not a plan. */
  planned: boolean;
  size: string | null;
  merged: boolean;
  /** The run's highest review round. */
  maxRound: number;
  /** Blocking findings over all the run's reviews. */
  blocking: number;
  costUsd: number | null;
  /** Input, output and cache-creation tokens over every run on the ticket. */
  ticketTokens: number;
  endedAt: number;
}

/** A build or review seat's run, for finding where it changed model or effort. */
export interface SeatRun {
  seatId: string;
  loop: "build" | "review";
  model: string | null;
  effort: string | null;
  startedAt: number;
}

/** A share of runs: null percent when the group is too small to draw one. */
export interface ModelRate {
  count: number;
  of: number;
  percent: number | null;
}

export interface ModelGroupRow {
  model: string | null;
  effort: string | null;
  /** The split's value, null when not split. */
  split: string | null;
  runs: number;
  tooFew: boolean;
  /** Runs with a cost, the base of `meanCost`. */
  pricedRuns: number;
  meanCost: number | null;
  round2: ModelRate;
  round3: ModelRate;
  meanBlocking: number | null;
  tokensPerMerged: number | null;
}

export interface ModelSide {
  runs: number;
  tooFew: boolean;
  round3: ModelRate;
  tokensPerMerged: number | null;
}

export interface ModelChangeRow {
  at: number;
  /** The seat that changed; null for a repo-wide row. */
  seatId: string | null;
  change: string;
  before: ModelSide;
  after: ModelSide;
}

export const STEP_UP_STARTS = "Step-up advice starts";

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean tokens of the ticket, over the distinct merged tickets of `rows`. */
function tokensPerMerged(rows: readonly ModelRunRow[]): number | null {
  const tickets = new Map<string, number>();
  for (const r of rows) if (r.merged) tickets.set(r.ticket, r.ticketTokens);
  return mean([...tickets.values()]);
}

function rate(rows: readonly ModelRunRow[], round: number, tooFew: boolean): ModelRate {
  const count = rows.filter((r) => r.maxRound >= round).length;
  return {
    count,
    of: rows.length,
    percent: tooFew || rows.length === 0 ? null : (count / rows.length) * 100,
  };
}

const splitValue = (r: ModelRunRow, split: ModelSplit): string | null => {
  if (split === "type") return r.template ?? "—";
  if (split === "size") return r.size ?? "—";
  if (split === "plan") return r.planned ? "With plan" : "No plan";
  return null;
};

/** The table's groups by model, effort and the chosen split, biggest first; no ranking. */
export function modelGroups(rows: readonly ModelRunRow[], split: ModelSplit): ModelGroupRow[] {
  const groups = new Map<
    string,
    { model: string | null; effort: string | null; split: string | null; rows: ModelRunRow[] }
  >();
  for (const r of rows) {
    const value = splitValue(r, split);
    const key = JSON.stringify([r.model, r.effort, value]);
    const g = groups.get(key) ?? { model: r.model, effort: r.effort, split: value, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g): ModelGroupRow => {
      const tooFew = g.rows.length < MODEL_TABLE_MIN_RUNS;
      const priced = g.rows.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
      return {
        model: g.model,
        effort: g.effort,
        split: g.split,
        runs: g.rows.length,
        tooFew,
        pricedRuns: priced.length,
        meanCost: tooFew ? null : mean(priced),
        round2: rate(g.rows, 2, tooFew),
        round3: rate(g.rows, 3, tooFew),
        meanBlocking: tooFew ? null : mean(g.rows.map((r) => r.blocking)),
        tokensPerMerged: tooFew ? null : tokensPerMerged(g.rows),
      };
    })
    .sort(
      (a, b) =>
        b.runs - a.runs ||
        (a.model ?? "").localeCompare(b.model ?? "") ||
        (a.effort ?? "").localeCompare(b.effort ?? "") ||
        (a.split ?? "").localeCompare(b.split ?? ""),
    );
}

function side(rows: readonly ModelRunRow[]): ModelSide {
  const tooFew = rows.length < MODEL_TABLE_MIN_RUNS;
  return {
    runs: rows.length,
    tooFew,
    round3: rate(rows, 3, tooFew),
    tokensPerMerged: tooFew ? null : tokensPerMerged(rows),
  };
}

const describeRun = (r: { model: string | null; effort: string | null }): string =>
  [r.model ?? "default model", r.effort].filter((p) => p !== null && p !== "").join(" ");

/**
 * Where a build or review seat changed model or effort inside [from, until], with the rework and
 * tokens of the runs 30 days either side (stopping at the seat's neighbouring change, and at
 * `until` for the after side), plus a repo-wide row where step-up advice began.
 */
export function modelChanges(
  seatRuns: readonly SeatRun[],
  rows: readonly ModelRunRow[],
  stepUpSince: number | null,
  from: number,
  until: number,
): ModelChangeRow[] {
  const out: ModelChangeRow[] = [];
  const seats = new Map<string, SeatRun[]>();
  for (const r of seatRuns) {
    const key = `${r.loop}:${r.seatId}`;
    seats.set(key, [...(seats.get(key) ?? []), r]);
  }
  for (const runs of seats.values()) {
    runs.sort((a, b) => a.startedAt - b.startedAt);
    const changes = runs.flatMap((r, i) => {
      const p = runs[i - 1];
      return p !== undefined && (p.model !== r.model || p.effort !== r.effort)
        ? [{ at: r.startedAt, from: p, to: r }]
        : [];
    });
    changes.forEach((c, i) => {
      if (c.at < from || c.at > until) return;
      const prior = changes[i - 1]?.at ?? Number.NEGATIVE_INFINITY;
      const next = changes[i + 1]?.at ?? Number.POSITIVE_INFINITY;
      const mine = rows.filter((r) =>
        c.to.loop === "build" ? r.seatId === c.to.seatId : r.reviewSeatId === c.to.seatId,
      );
      const lo = Math.max(prior, c.at - MODEL_CHANGE_SIDE_MS);
      const hi = Math.min(next, c.at + MODEL_CHANGE_SIDE_MS, until);
      out.push({
        at: c.at,
        seatId: c.to.seatId,
        change: `${describeRun(c.from)} → ${describeRun(c.to)}`,
        before: side(mine.filter((r) => r.endedAt >= lo && r.endedAt < c.at)),
        after: side(mine.filter((r) => r.endedAt >= c.at && r.endedAt <= hi)),
      });
    });
  }
  if (stepUpSince !== null && stepUpSince >= from && stepUpSince <= until) {
    out.push({
      at: stepUpSince,
      seatId: null,
      change: STEP_UP_STARTS,
      before: side(
        rows.filter(
          (r) => r.endedAt >= stepUpSince - MODEL_CHANGE_SIDE_MS && r.endedAt < stepUpSince,
        ),
      ),
      after: side(
        rows.filter(
          (r) =>
            r.endedAt >= stepUpSince &&
            r.endedAt <= Math.min(stepUpSince + MODEL_CHANGE_SIDE_MS, until),
        ),
      ),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** What Audit's model panel shows: the groups for every split, and the changes. */
export interface ModelsView {
  groups: Record<ModelSplit, ModelGroupRow[]>;
  changes: ModelChangeRow[];
}

/** The rows an Audit window needs, as the store reads them. */
export interface ModelTableData {
  rows: ModelRunRow[];
  seatRuns: SeatRun[];
  stepUpSince: number | null;
}

/** The view for [from, until]: groups cover the runs ending inside it, changes reach 30 days either side. */
export function modelsView(data: ModelTableData, from: number, until: number): ModelsView {
  const inWindow = data.rows.filter((r) => r.endedAt >= from && r.endedAt <= until);
  return {
    groups: {
      none: modelGroups(inWindow, "none"),
      type: modelGroups(inWindow, "type"),
      size: modelGroups(inWindow, "size"),
      plan: modelGroups(inWindow, "plan"),
    },
    changes: modelChanges(data.seatRuns, data.rows, data.stepUpSince, from, until),
  };
}
