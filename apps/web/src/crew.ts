/** Rules over the crew (`/api/crew`) that more than one page uses. */
import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type CrewLoop,
  type CrewMode,
  type CrewRow,
  type DriverStop,
  HUD_STATE_LABEL,
  HUD_STATE_RANK,
  HUD_STATE_TONE,
  type HudLampKind,
  type HudState,
  type HudTone,
  LAST_TEXT_MAX,
  LIVE_DETAIL_MAX,
  type LoopPhase,
  type PullRequestView,
  ROLES,
  type RunDigest,
  type RunPr,
  type RunStatus,
  type RunView,
  STALL_MS,
  seatCallSign,
} from "@mc/core";
import { cutText, hhmm, mss, prLabel, wkdTime } from "./fmt.ts";

/**
 * The order the Overview table and j/k share: agents with an attention item first, then by state
 * (broken and stalled first), then config order.
 */
export function crewOrder(rows: CrewRow[], items: AttentionItem[]): CrewRow[] {
  const needs = new Set(items.map((i) => i.agentId).filter((id) => id !== null));
  return [...rows].sort(
    (a, b) =>
      Number(needs.has(b.id)) - Number(needs.has(a.id)) ||
      HUD_STATE_RANK[a.hudState] - HUD_STATE_RANK[b.hudState] ||
      a.index - b.index,
  );
}

/**
 * The lamp for some attention items (one agent's, one tab's, or one item): red when any is an
 * error, else amber; named by their kinds in Needs-you order. null for none (render nothing).
 */
export function needsLamp(
  items: AttentionItem[],
  pulse: boolean,
): { kind: HudLampKind; pulse: boolean; label: string } | null {
  if (items.length === 0) return null;
  const kinds = new Set(items.map((i) => i.kind));
  return {
    kind: kinds.has("error") ? "crit" : "warn",
    pulse,
    label: ATTENTION_KINDS.filter((k) => kinds.has(k))
      .map((k) => ATTENTION_LABEL[k])
      .join(", "),
  };
}

/**
 * What a seat's open session is doing, from the digest: the tool in hand with what it touches and
 * how long, else (between tools) a running seat's background task, else (or idle at the end of a
 * turn) the first sentence of its newest message. null when the server sent neither, and the caller falls back to the run number.
 */
export function seatActivity(row: CrewRow, now: number): string | null {
  const tool = toolLine(row, now);
  if (tool) return tool;
  if (row.digest?.liveTool) return null;
  return backgroundLine(row) ?? lastTextOf(row);
}

/** A scratch seat's area text. */
export const SCRATCH_AREA_TEXT = "scratch review copy";

/** The area text of a crew seat or row: read-only, scratch, its globs, or the whole checkout. */
export function seatAreaText(s: { mode: CrewMode | null; area: readonly string[] }): string {
  if (s.mode === "read-only") return "read-only";
  if (s.mode === "scratch") return SCRATCH_AREA_TEXT;
  return s.area.length > 0 ? s.area.join(", ") : "whole checkout";
}

/** The separator between the parts of a doing line. */
export const DOING_SEP = " · ";

/**
 * Contract-first (ticket 202 adds these to mc/core): the PR an idle RETRO seat is reviewing, and the
 * `ready` attention kind with its label. Switch to the core exports once 202 merges.
 */
export interface ReviewingPr {
  prNumber: number;
  sha: string;
  ref: string | null;
}
export type ReviewingRow = CrewRow & { reviewing?: ReviewingPr | null };
export const READY_KIND = "ready";
export const READY_TO_MERGE = "Ready to merge";

/** An idle reviewing seat's doing line: the PR, its short sha and the ticket ref when there is one. */
export const reviewingLine = (r: ReviewingPr): string =>
  `Reviewing PR #${r.prNumber} (${r.sha.slice(0, 7)})${r.ref ? `${DOING_SEP}${r.ref}` : ""}`;

/** Whether the seat has a session open: running, or idle at the end of a turn of an open run. */
const sessionOpen = (row: CrewRow): boolean =>
  row.hudState === "running" || (row.hudState === "idle" && hasActiveRun(row));

/** The live tool with what it touches and how long; null without a tool, or one with no detail. */
function toolLine(row: CrewRow, now: number): string | null {
  const live = row.digest?.liveTool;
  if (!live?.detail || !sessionOpen(row)) return null;
  // The time comes before the detail: a line cut short on a narrow row still shows how long.
  return `${live.name} ${mss(now - live.since)}${DOING_SEP}${cutText(live.detail, LIVE_DETAIL_MAX)}`;
}

/** A running seat waiting on its own background task (ruling R21): the newest one. */
function backgroundLine(row: CrewRow): string | null {
  if (row.hudState !== "running") return null;
  const task = row.digest?.background.at(-1);
  return task ? `background: ${task.description || task.type}` : null;
}

/** The first sentence of the newest message of an open session, cut; null when there is none. */
function lastTextOf(row: CrewRow): string | null {
  const text = row.digest?.lastText?.trim();
  return text && sessionOpen(row) ? cutText(text, LAST_TEXT_MAX) : null;
}

/** An idle seat whose looped run is not done says the loop's step (the server's text). */
export const loopLine = (row: CrewRow): string | null =>
  row.loop && row.loop.phase !== "done" && row.hudState === "idle" && !row.note
    ? row.loop.text
    : null;

/**
 * What a row says it is doing, by state; first match wins. `tz` is the operator's zone, null while
 * it loads: the line then leaves out only the clock time.
 */
export function doingLine(
  row: ReviewingRow,
  now: number,
  tz: string | null,
  /** The seat's repo's PRs (the PRs resource), where an idle seat's PR title is found. */
  repoPrs?: readonly PullRequestView[],
): string {
  if (isSeatFree(row) && row.hudState === "idle") return SEAT_FREE_LINE;
  // In `review` the PR line (idle case below) wins: it carries the title.
  if (row.loop?.phase !== "review") {
    const step = loopLine(row);
    if (step) return step;
  }
  const seq = row.run ? `run #${row.run.seq}` : "run";
  switch (row.hudState) {
    case "running": {
      const tool = toolLine(row, now);
      if (tool) return tool;
      const live = row.digest?.liveTool;
      if (live) return `${seq}${DOING_SEP}${live.name} ${mss(now - live.since)}`;
      // Waiting on its own background task: the newest one, ahead of the last text.
      const task = backgroundLine(row);
      if (task) return `${seq}${DOING_SEP}${task}`;
      return lastTextOf(row) ?? seq;
    }
    case "stalled":
      // A seat that has written nothing: the server sets a stalled row's stateSince to when the stall
      // began, STALL_MS after it went quiet (seats ignore background tasks), so step back to then.
      return `${seq}${DOING_SEP}no output for ${mss(now - (row.lastOutputAt ?? row.stateSince - STALL_MS))}`;
    case "error":
      if (row.kind === "crew") {
        return row.sourceError ? `${SEAT_RUN_FAILED}: ${row.sourceError}` : SEAT_RUN_FAILED;
      }
      return row.sourceError ? `Error: ${row.sourceError}` : "Error";
    case "parked":
      // A crew seat says why it parked (e.g. a rate limit); a loop is parked by the operator.
      return row.kind === "crew" && row.note ? row.note : "Paused by you";
    case "blocked":
      return row.note ?? "Waiting on you";
    case "waiting":
      return "Waiting";
    case "idle": {
      const reviewing = row.reviewing;
      if (reviewing) return reviewingLine(reviewing);
      const review = seatReview(row, now, repoPrs);
      if (review) return reviewText(review);
      return (
        row.note ??
        seatActivity(row, now) ??
        (tz ? `Idle since ${hhmm(row.stateSince, tz)}` : "Idle")
      );
    }
    case "stopped":
      if (row.stop) return stopLine(row.stop, now, tz);
      return row.kind === "crew" ? seatStopLine(row) : (row.note ?? "Stopped");
  }
}

/** What an idle seat says of its PR, ahead of `PR #n`. */
const REVIEW_LEAD: Record<NonNullable<CrewRow["review"]>["state"], string> = {
  draft: "Draft ",
  open: `In review${DOING_SEP}`,
  approved: `In review${DOING_SEP}`,
  changes: `Changes requested${DOING_SEP}`,
};

export interface SeatReview {
  lead: string;
  prNumber: number;
  tail: string | null;
}

/**
 * An idle seat's PR line in three runs: the words before the PR, the PR (`PR #n`, which a page may
 * link) and the words after it. The line's text and DoingLine's JSX both come from these.
 */
export function reviewParts(r: SeatReview): { before: string; pr: string; after: string } {
  return {
    before: r.lead,
    pr: prLabel(r.prNumber),
    after: r.tail ? `${DOING_SEP}${r.tail}` : "",
  };
}

const reviewText = (r: SeatReview): string => {
  const { before, pr, after } = reviewParts(r);
  return before + pr + after;
};

/**
 * An idle crew seat whose run has an open PR is waiting on review, not idle: the words before the
 * PR and its number (the lead is its state, so a cut line still says draft), then a tail: the PR's
 * title, found by number in the repo's PRs (a crew run's own `prs` is always empty), else the
 * seat's last words, else none; while the repo's PRs are loading (`repoPrs` undefined) none, so the
 * line does not change when they arrive. null for any other row (a loop never has one; a note says more).
 */
export function seatReview(
  row: CrewRow,
  now: number,
  repoPrs?: readonly PullRequestView[],
): SeatReview | null {
  if (row.kind !== "crew" || row.hudState !== "idle" || row.note || !row.review) return null;
  // A loop step other than review is the better line; in review the PR line carries the title.
  if (loopLine(row) !== null && row.loop?.phase !== "review") return null;
  const { prNumber, state } = row.review;
  const lead = REVIEW_LEAD[state];
  if (!repoPrs) return { lead, prNumber, tail: null };
  const title = repoPrs.find((p) => p.number === prNumber)?.title;
  return { lead, prNumber, tail: title || seatActivity(row, now) };
}

/** The PRs a run is known by: the ones it recorded, and any PR in the repo on its branch. */
export function runPrs(run: RunView, repoPrs: readonly PullRequestView[] | undefined): RunPr[] {
  const extra = (repoPrs ?? [])
    .filter((p) => run.branch !== null && p.branch === run.branch)
    .filter((p) => !run.prs.some((r) => r.number === p.number))
    .sort((a, b) => a.number - b.number)
    .map(
      (p): RunPr => ({
        repoId: p.repoId,
        number: p.number,
        title: p.title,
        url: p.url,
        state: p.state,
        ticket: p.ticket,
      }),
    );
  return [...run.prs, ...extra];
}

/** A stopped crew seat's doing line: why its last run ended, never its (finished) ticket. */
export const SEAT_RUN_ENDED = "Run ended";
/** The server marks a crew run `ok` only when the operator ends it (End run). */
export const SEAT_RUN_ENDED_BY_YOU = "Run ended by you";
export const SEAT_RUN_FAILED = "Run failed";
/** Prefix of the muted ticket reference on a stopped seat's row. */
export const SEAT_LAST_TICKET = "Last";

/** Why a crew seat stopped, from its last run's status, its PRs and its note. */
function seatStopLine(row: CrewRow): string {
  if (!row.run) return row.note ?? "Stopped";
  if (row.run.status === "failed") {
    const why = row.note ?? row.sourceError;
    return why ? `${SEAT_RUN_FAILED}: ${why}` : SEAT_RUN_FAILED;
  }
  const merged = row.prs.find((pr) => pr.state === "merged");
  if (merged) return `${SEAT_RUN_ENDED}${DOING_SEP}${prLabel(merged.number)} merged`;
  return row.run.status === "ok" ? SEAT_RUN_ENDED_BY_YOU : SEAT_RUN_ENDED;
}

/** A stopped or failed crew seat's ticket is not current work: show it as the last one. */
export const isFinishedWork = (row: Pick<CrewRow, "kind" | "hudState">): boolean =>
  row.kind === "crew" && (row.hudState === "stopped" || row.hudState === "error");

/**
 * A loop stopped by its own driver: why, and when it can start again. While `tz` is null the
 * resume time (which needs the zone) is left out; "resumes at its next start" needs none.
 */
export function stopLine(stop: DriverStop, now: number, tz: string | null): string {
  if (stop.quota === null) return `Stopped by its driver: ${stop.reason}`;
  const { usedPct, stopPct } = stop.quota;
  const figures = usedPct !== null && stopPct !== null ? ` (${usedPct}% of ${stopPct}%)` : "";
  const base = `Stopped at the 7-day quota${figures}`;
  if (stop.resumesAt === null) return base;
  if (stop.resumesAt <= now) return `${base}${DOING_SEP}resumes at its next start`;
  return tz === null ? base : `${base}${DOING_SEP}resumes after ${wkdTime(stop.resumesAt, tz)}`;
}

/**
 * How long a run has taken: to its end, or to `now` while it is running. A run that has neither
 * ended nor is running (status unknown, the loop gone quiet) has no honest duration: null.
 */
export function runElapsed(
  run: { startedAt: number; endedAt: number | null; status: RunStatus },
  now: number,
): number | null {
  if (run.endedAt !== null) return run.endedAt - run.startedAt;
  return run.status === "running" ? now - run.startedAt : null;
}

/** Context in use, as a percent of the window; null when either number is missing. */
export function contextPct(row: CrewRow): number | null {
  const used = row.digest?.contextTokens;
  const window = row.contextWindow;
  if (used === null || used === undefined || window === null || window <= 0) return null;
  return (100 * used) / window;
}

export interface NeedPart {
  text: string;
  /** The button the line carries: Answer or Open (both open the Item panel), or none. */
  action: "answer" | "open" | null;
  key: string;
}

const ASKS = ["decision", "approval", "question"] as const;

/**
 * The need line under an agent row (catalogue 2.1.2, the parts that exist): its stall (age from
 * the item's `at`), a parked escalation, asks for an answer, and the loop's own error.
 */
export function needLine(row: CrewRow, items: AttentionItem[], now: number): NeedPart[] {
  const mine = items.filter((i) => i.agentId === row.id);
  const parts: NeedPart[] = [];
  const stall = mine.find((i) => i.kind === "stalled");
  if (stall) {
    parts.push({
      text: `Stalled ${mss(now - stall.at)}${stall.tool ? ` in ${stall.tool}` : ""}`,
      action: null,
      key: stall.key,
    });
  }
  const parked = mine.find((i) => i.kind === "parked");
  if (parked) parts.push({ text: `Parked: ${parked.text}`, action: "open", key: parked.key });
  for (const kind of ASKS) {
    const ask = mine.find((i) => i.kind === kind);
    if (ask) {
      parts.push({ text: `${ATTENTION_LABEL[kind]} for you`, action: "answer", key: ask.key });
    }
  }
  const ready = mine.find((i) => (i.kind as string) === READY_KIND);
  if (ready) parts.push({ text: READY_TO_MERGE, action: "open", key: ready.key });
  if (row.sourceError) {
    const err = mine.find((i) => i.kind === "error");
    parts.push({
      text: `Error: ${row.sourceError}`,
      action: null,
      key: err?.key ?? `error:${row.id}`,
    });
  }
  return parts;
}

const MINUTE = 60_000;
const SPARK_MINUTES = 24;

/** Input + output tokens per minute for the last 24 minutes up to the newest bucket; gaps are 0. */
export function sparkValues(digest: RunDigest | null): number[] {
  const buckets = digest?.minuteTokens ?? [];
  if (buckets.length === 0) return [];
  const byStart = new Map(buckets);
  const end = Math.max(...buckets.map(([start]) => start));
  return Array.from(
    { length: SPARK_MINUTES },
    (_, i) => byStart.get(end - (SPARK_MINUTES - 1 - i) * MINUTE) ?? 0,
  );
}

/** Tokens in the newest complete minute bucket; 0 once that minute began over two minutes ago. */
export function tokensPerMinute(digest: RunDigest | null, now: number): number | null {
  if (!digest) return null;
  let newest: [number, number] | null = null;
  for (const b of digest.minuteTokens) {
    if (b[0] + MINUTE <= now && (newest === null || b[0] > newest[0])) newest = b;
  }
  return newest && now - newest[0] <= 2 * MINUTE ? newest[1] : 0;
}

/** The name on screen: a crew seat's id upper-cased (`GUIDO-1`), a loop's id as it is. */
export const callSign = (row: Pick<CrewRow, "id" | "kind">): string =>
  row.kind === "crew" ? seatCallSign(row.id) : row.id;

/** A role's title: its `here` text up to the first colon or comma, first letter up (`frontend developer` is `Frontend developer`). */
export function roleTitle(here: string): string {
  const head = (here.split(/[:,]/)[0] ?? "").trim();
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * The title of the role a seat holds, from the config's roles (`crew.roles`, which carry custom
 * ones) else the built-in `ROLES`; null for an observed loop or a role with no text.
 */
export function seatRoleTitle(
  id: string,
  rows: readonly Pick<CrewRow, "id" | "kind" | "role">[] | undefined,
  roles: readonly { name: string; here: string }[] | undefined,
): string | null {
  const row = rows?.find((r) => r.id.toLowerCase() === id.toLowerCase());
  if (row?.kind === "loop") return null;
  const role = row?.role ?? id;
  const here =
    roles?.find((r) => r.name === role)?.here ?? ROLES.find((r) => r.callSign === role)?.here;
  return here ? roleTitle(here) || null : null;
}

/**
 * `model · effort · CLI version`: the run's model id (else the config alias), a seat's effort
 * (`default` when unset; a loop has none), and the CLI version when it is known.
 */
export function modelLine(row: CrewRow): string {
  const parts = [row.run?.model ?? row.model ?? "—"];
  if (row.kind === "crew") parts.push(row.cli.effort ?? "default");
  if (row.cli.version) parts.push(`CLI ${row.cli.version}`);
  return parts.join(DOING_SEP);
}

/** How Work in flight names a loop's phase. */
export const LOOP_PHASE_LABEL: Record<LoopPhase, string> = {
  working: "Working",
  ci: "CI",
  review: "In review",
  parked: "Blocked",
  done: "Done",
};

/** The build loop's name on screen: the 7a loop is one implicit loop per run, with no template file. */
export const BUILD_LOOP_TEMPLATE = "build";
/** The build loop's path, in order (catalogue §2.4.5's stepper); `parked` is a held state, not a step. */
export const LOOP_PATH = [
  "working",
  "ci",
  "review",
  "done",
] as const satisfies readonly LoopPhase[];
/** The step bar's tooltip: the path joined by " → " (catalogue §2.1.2). */
export const LOOP_PATH_TITLE = LOOP_PATH.map((p) => LOOP_PHASE_LABEL[p]).join(" → ");
/** States that hold a loop's current step (catalogue §2.1.2: amber when stalled, parked, blocked or waiting). */
export const LOOP_HELD_STATES: readonly HudState[] = ["stalled", "parked", "blocked", "waiting"];
export type StepMark = "done" | "cur" | "held" | "todo";

/**
 * One mark per LOOP_PATH step. Parked: every step held, since CrewLoop does not say which step it
 * held at. Done: every step done. Otherwise, steps before the phase are done, the phase is current
 * (held while the seat's state holds it) and later steps are to do.
 */
export function loopMarks(loop: CrewLoop, hudState: HudState): StepMark[] {
  if (loop.phase === "parked") return LOOP_PATH.map(() => "held");
  if (loop.phase === "done") return LOOP_PATH.map(() => "done");
  const at = (LOOP_PATH as readonly LoopPhase[]).indexOf(loop.phase);
  const held = LOOP_HELD_STATES.includes(hudState);
  return LOOP_PATH.map((_, i) => (i < at ? "done" : i === at ? (held ? "held" : "cur") : "todo"));
}

/** A row whose run is in a loop that has not finished: it belongs in Work in flight. */
export const isLoopInFlight = (row: Pick<CrewRow, "loop" | "run">): boolean =>
  row.loop !== null && row.loop.phase !== "done" && row.run !== null && row.run.endedAt === null;

/** A crew seat with no open run: free for work, whatever its last run's ticket was. */
export const isSeatFree = (row: Pick<CrewRow, "kind" | "run">): boolean =>
  row.kind === "crew" && (row.run === null || row.run.endedAt !== null);

/** What a crew row's state pill says, beyond the engine's own states. */
export const SEAT_STATUS_LABEL = {
  ci: "Waiting on CI",
  review: "In review",
  blocked: "Blocked",
  idle: "Idle",
  free: "Free",
} as const;

/** The doing line of a free seat. */
export const SEAT_FREE_LINE = "Free for work";

const ENGINE_STATES: readonly HudState[] = ["running", "stalled", "error", "stopped", "parked"];

/**
 * The one rule for a state pill: an observed loop keeps the engine's state; a crew seat says what
 * its open run is doing (waiting on CI or review, blocked, between turns) or that it is free.
 */
export function seatStatus(row: CrewRow): { label: string; tone: HudTone } {
  const engine = { label: HUD_STATE_LABEL[row.hudState], tone: HUD_STATE_TONE[row.hudState] };
  if (row.kind !== "crew" || ENGINE_STATES.includes(row.hudState)) return engine;
  if (isSeatFree(row)) return { label: SEAT_STATUS_LABEL.free, tone: "neutral" };
  switch (row.loop?.phase) {
    case "ci":
      return { label: SEAT_STATUS_LABEL.ci, tone: "neutral" };
    case "review":
      return { label: SEAT_STATUS_LABEL.review, tone: "neutral" };
    case "parked":
      return { label: SEAT_STATUS_LABEL.blocked, tone: "warn" };
    default:
      return row.hudState === "idle" ? { label: SEAT_STATUS_LABEL.idle, tone: "neutral" } : engine;
  }
}

/** Whether a seat has a run in flight: its latest run is running and has not ended. */
export const hasActiveRun = (row: Pick<CrewRow, "run">): boolean =>
  row.run !== null && row.run.status === "running" && row.run.endedAt === null;

/** A crew seat's session as the composer sees it. */
export type SeatTurn = "running" | "idle" | "none";

/**
 * Whether a seat has a live session (its latest run is running and the seat is not in error or
 * stopped) and, if so, whether a turn is in flight.
 */
export function seatTurn(row: CrewRow): SeatTurn {
  if (row.run?.status !== "running" || row.hudState === "error" || row.hudState === "stopped")
    return "none";
  return row.hudState === "running" || row.hudState === "stalled" ? "running" : "idle";
}
