/** Rules over the crew (`/api/crew`) that more than one page uses. */
import {
  ATTENTION_KINDS,
  ATTENTION_LABEL,
  type AttentionItem,
  type ConfigView,
  type Crew,
  type CrewLoop,
  type CrewMode,
  type CrewRow,
  type DriverStop,
  HUD_STATE_LABEL,
  HUD_STATE_TONE,
  type HudLampKind,
  type HudState,
  type HudTone,
  LAST_TEXT_MAX,
  LIVE_DETAIL_MAX,
  type LoopPhase,
  type LoopWait,
  type PullRequestView,
  ROLES,
  type RunDigest,
  type RunPr,
  type RunStatus,
  type RunView,
  reviewCheckPill,
  STALL_MS,
  seatCallSign,
  type TestLockState,
} from "@mc/core";
import { useCallback } from "react";
import { RESOURCES, useResource } from "./data.ts";
import { cutText, hhmm, mss, percent, prLabel, wkdTime } from "./fmt.ts";

/** The seat palette size: `--seat-1…--seat-7` (hud.css), wrapping by config index. */
const SEAT_PALETTE = 7;

/** A seat's colour token by its config index: the one palette every page draws from. */
export const seatColorVar = (index: number): string =>
  `--seat-${(Math.max(0, index) % SEAT_PALETTE) + 1}`;

/**
 * The attention items a seat's row shows: the seat's own, about the run it is working now. Run
 * items carry the ticket, not the run, so one about another ticket belongs to a run the seat has
 * set aside (in review, ready to merge, parked) and shows under that ticket in Needs you instead.
 * An escalation is the repo's, not a run's, and always stays.
 */
export function seatItems(row: CrewRow, items: AttentionItem[]): AttentionItem[] {
  return items.filter(
    (i) =>
      i.agentId === row.id &&
      (i.escalationId !== null || i.ticket === null || i.ticket === row.ticket),
  );
}

/** Shared task-manager order for Overview and j/k; ties retain configured order. */
export function crewOrder(rows: CrewRow[], items: AttentionItem[], now = Date.now()): CrewRow[] {
  const end = Math.floor(now / 60_000) * 60_000;
  const tokens = (r: CrewRow) =>
    (r.digest?.minuteTokens ?? [])
      .filter(([at]) => at < end && at >= end - 10 * 60_000)
      .reduce((sum, [, n]) => sum + n, 0);
  const rank = (r: CrewRow) => {
    if (needLine(r, items, now).length) return 0;
    if (r.hudState === "running") return 1;
    if (r.hudState === "stopped") return 4;
    if (
      ["waiting", "blocked", "parked", "stalled", "error"].includes(r.hudState) ||
      ["ci", "review", "parked"].includes(r.loop?.phase ?? "")
    )
      return 2;
    return 3;
  };
  const keys = new Map(rows.map((row) => [row, { rank: rank(row), tokens: tokens(row) }]));
  return [...rows].sort((a, b) => {
    const ka = keys.get(a);
    const kb = keys.get(b);
    if (!ka || !kb) return a.index - b.index;
    return ka.rank - kb.rank || (ka.rank === 1 ? kb.tokens - ka.tokens : 0) || a.index - b.index;
  });
}

/**
 * The lamp for some attention items (one agent's, one tab's, or one item): red when any is an
 * error, else amber; named by their kinds in Needs-you order. null for none (render nothing).
 */
export function needsLamp(
  items: readonly AttentionItem[],
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

/**
 * A review seat's doing line while it checks a PR: the Board pill's words (seat, minutes since the
 * run started) then the PR and the ticket ref when there is one.
 */
export const reviewingLine = (
  row: Pick<CrewRow, "id" | "kind" | "displayCallSign" | "run" | "stateSince">,
  r: ReviewingPr,
  now: number,
): string => {
  const seat = seatCallSign(row.id);
  const since = row.run?.startedAt ?? row.stateSince;
  const checking = reviewCheckPill({ kind: "checking", seat, since }, now).label;
  return `${checking}${DOING_SEP}${prLabel(r.prNumber)}${r.ref ? `${DOING_SEP}${r.ref}` : ""}`;
};

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
  if (row.crewPause) return `Paused: ${row.crewPause.reason}`;
  if (row.reviewing && row.hudState === "idle") return reviewingLine(row, row.reviewing, now);
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
      if (reviewing) return reviewingLine(row, reviewing, now);
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
  const { prNumber, state, check } = row.review;
  const lead = check ? `${reviewCheckPill(check, now).label}${DOING_SEP}` : REVIEW_LEAD[state];
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
        ...(p.uat ? { uat: p.uat } : {}),
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
  const figures =
    usedPct !== null && stopPct !== null ? ` (${percent(usedPct)} of ${percent(stopPct)})` : "";
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
  /**
   * The button the line carries: Answer, Open or Read (open the Item panel), Interrupt or Stop the
   * run (both stop the seat's turn), or none.
   */
  action: "answer" | "open" | "read" | "interrupt" | "stop" | null;
  key: string;
}

const ASKS = ["decision", "question", "approval"] as const;

/**
 * The need line under an agent row (catalogue 2.1.2, the parts that exist): its stall (age from
 * the item's `at`; a crew seat's carries Interrupt, or Stop the run while it holds the test lock),
 * a parked escalation, asks for an answer, and the loop's own error.
 */
export function needLine(
  row: CrewRow,
  items: AttentionItem[],
  now: number,
  lock?: TestLockState,
): NeedPart[] {
  const mine = seatItems(row, items);
  const parts: NeedPart[] = [];
  const stall = mine.find((i) => i.kind === "stalled");
  if (stall) {
    const age = mss(now - stall.at);
    const holding = lock?.holder?.seatId === row.id;
    const waiting = new Set((lock?.waiting ?? []).map((w) => w.seatId)).size;
    parts.push({
      text: holding
        ? `Stalled ${age} and holding the test lock${waiting > 0 ? `; ${waiting} waiting` : ""}`
        : `Stalled ${age}${stall.tool ? ` in ${stall.tool}` : ""}`,
      // an observed loop is not ours to stop
      action: row.kind !== "crew" ? null : holding ? "stop" : "interrupt",
      key: stall.key,
    });
  }
  const parked = mine.find((i) => i.kind === "parked");
  if (parked) parts.push({ text: `Parked: ${parked.text}`, action: "open", key: parked.key });
  const asks = mine.filter((i) => ASKS.some((kind) => i.kind === kind));
  if (asks.length > 0) {
    const others = asks.filter((i) => i.owner !== "operator");
    for (const owner of new Set(others.map((i) => i.owner))) {
      const group = others.filter((i) => i.owner === owner);
      const ask = group.reduce((a, b) => (b.at < a.at ? b : a));
      parts.push({
        text: `${ATTENTION_LABEL[ask.kind]} for ${ask.owner === "loop" ? callSign(row) : ask.owner === "controller" ? "the controller" : "FLIGHT"}${group.length > 1 ? ` · ${group.length} items` : ""}`,
        action: "open",
        key: ask.key,
      });
    }
    const operatorAsks = asks.filter((i) => i.owner === "operator");
    if (operatorAsks.length > 0) {
      const oldest = operatorAsks.reduce((a, b) => (b.at < a.at ? b : a));
      const labels = ASKS.filter((kind) => operatorAsks.some((i) => i.kind === kind)).map(
        (kind, index) =>
          index === 0 ? ATTENTION_LABEL[kind] : ATTENTION_LABEL[kind].toLowerCase(),
      );
      const kinds =
        labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
      parts.push({ text: `${kinds} for you`, action: "answer", key: oldest.key });
    }
  }
  const tag = mine.find((i) => i.kind === "tag");
  if (tag && !parts.some((p) => p.action === "answer")) {
    parts.push({ text: ATTENTION_LABEL.tag, action: "read", key: tag.key });
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

/** Keep the operator and the owner distinct on compact loop and Agent headers. */
export function needOwnerLabel(row: CrewRow, items: AttentionItem[]): string {
  const mine = seatItems(row, items);
  if (mine.some((i) => i.owner === "operator")) return "needs you";
  if (mine.length > 0 && mine.every((i) => i.owner === "loop")) return "has an item to resolve";
  const owners = [
    ...new Set(
      mine.map((i) =>
        i.owner === "loop" ? callSign(row) : i.owner === "controller" ? "the controller" : "FLIGHT",
      ),
    ),
  ];
  return owners.length ? `waiting on ${owners.join(", ")}` : "has an item";
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

/** The configured name, otherwise a crew seat's upper-case id or a loop's id as it is. */
export const callSign = (row: Pick<CrewRow, "id" | "kind" | "displayCallSign">): string =>
  row.displayCallSign ?? (row.kind === "crew" ? seatCallSign(row.id) : row.id);

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

/** What stands where a seat's loop would show, when it has none. */
export const NO_LOOP = "No loop in flight.";
/** The template on screen: the run's profile, else the build loop. */
export const loopTemplate = (loop: CrewLoop): string => loop.profile ?? BUILD_LOOP_TEMPLATE;

/** The step on screen: the profile's step for the phase, else the build loop's phase label. */
export const loopStepLabel = (loop: CrewLoop): string => loop.step ?? LOOP_PHASE_LABEL[loop.phase];

/** What a looped run waits on, as Overview words it (the server decides `wait`). */
export const WAIT_TEXT = {
  ci: "waiting on CI",
  retro: "waiting on RETRO's review",
  main: "waiting on main: updating the branch",
  operator: "waiting on you",
  lock: "in line for the test lock",
} as const;
/** A set-aside run whose rework or park is due back on its seat. */
export const seatWaitText = (call: string): string => `waiting on ${call} for rework`;
/** Waits shown amber, as the mockup's lock line. */
export const WAIT_WARN: readonly LoopWait[] = ["lock", "operator"];
/** The lead of a set-aside run's line under its seat's row. */
export const SET_ASIDE_LABEL = "Set aside";

/** " · try n of max" from the second try on, else "". */
export function loopTryText(loop: CrewLoop): string {
  const tries = loop.tries ?? null;
  return tries !== null && tries.n > 1 ? `${DOING_SEP}try ${tries.n} of ${tries.max}` : "";
}

/** When `runId` joined the test lock's line (its first `waiting` entry, the oldest); null when it is not listed. */
export function lockSince(
  lock: TestLockState | undefined,
  runId: string | null | undefined,
): number | null {
  if (!lock || runId === null || runId === undefined) return null;
  return lock.waiting.find((w) => w.runId === runId)?.since ?? null;
}

/** The line under a Loop step saying what the run waits on; null when it waits on nothing. */
export function waitText(
  loop: CrewLoop,
  call: string,
  lockSince: number | null,
  now: number,
): string | null {
  const wait = loop.wait ?? null;
  switch (wait) {
    case null:
      return null;
    case "ci":
    case "retro":
    case "main":
      return WAIT_TEXT[wait];
    case "operator":
      return loop.phase === "parked" && loop.parked
        ? `${WAIT_TEXT.operator}: ${loop.parked}`
        : WAIT_TEXT.operator;
    case "lock":
      return lockSince === null
        ? WAIT_TEXT.lock
        : `${WAIT_TEXT.lock}${DOING_SEP}${mss(now - lockSince)}`;
    case "seat":
      return seatWaitText(call);
  }
}

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
 * held at, unless `heldAt` names it (from the run's tries): steps before it are done, it is held
 * and later steps are to do. Done: every step done. Otherwise, steps before the phase are done,
 * the phase is current (held while the seat's state holds it) and later steps are to do.
 */
export function loopMarks(loop: CrewLoop, hudState: HudState, heldAt?: LoopPhase): StepMark[] {
  if (loop.phase === "parked") {
    const held = heldAt === undefined ? -1 : (LOOP_PATH as readonly LoopPhase[]).indexOf(heldAt);
    if (held < 0) return LOOP_PATH.map(() => "held");
    return LOOP_PATH.map((_, i) => (i < held ? "done" : i === held ? "held" : "todo"));
  }
  if (loop.phase === "done") return LOOP_PATH.map(() => "done");
  const at = (LOOP_PATH as readonly LoopPhase[]).indexOf(loop.phase);
  const held = LOOP_HELD_STATES.includes(hudState);
  return LOOP_PATH.map((_, i) => (i < at ? "done" : i === at ? (held ? "held" : "cur") : "todo"));
}

/** A profile step on screen, or a build-loop phase standing as one. */
export interface ShownStep {
  name: string;
  phase: Exclude<LoopPhase, "parked"> | null;
}
/** The build-loop path's step names on screen: the checks step reads "Checks" where the engine phase reads "CI". */
export const LOOP_STEP_LABEL: Record<Exclude<LoopPhase, "parked">, string> = {
  working: LOOP_PHASE_LABEL.working,
  ci: "Checks",
  review: LOOP_PHASE_LABEL.review,
  done: LOOP_PHASE_LABEL.done,
};
/** The profile step that a landed plan marks done. */
export const PLAN_STEP = "plan";
/** The profile step that an open PR marks done. */
export const DRAFT_PR_STEP = "draft PR";

/** The run's profile steps, else the build loop's path labelled by phase. */
export function loopSteps(loop: CrewLoop): ShownStep[] {
  return loop.steps?.length
    ? loop.steps.map(({ name, phase }) => ({ name, phase }))
    : LOOP_PATH.map((phase) => ({ name: LOOP_STEP_LABEL[phase], phase }));
}

/** One mark per shown step, using phase progress and evidence for steps without a phase. */
export function stepMarks(loop: CrewLoop, hudState: HudState, heldAt?: LoopPhase): StepMark[] {
  const base = loopMarks(loop, hudState, heldAt);
  const phaseMark = (phase: Exclude<LoopPhase, "parked">): StepMark | undefined =>
    base[LOOP_PATH.indexOf(phase)];
  const steps = loopSteps(loop);
  return steps.map((step) => {
    const mark = step.phase === null ? undefined : phaseMark(step.phase);
    if (mark !== undefined) return mark;
    if (step.name === PLAN_STEP) return loop.planned === true ? "done" : "todo";
    if (step.name === DRAFT_PR_STEP) {
      return loop.prNumber !== null ? "done" : "todo";
    }
    return "todo";
  });
}

/** The step bar's tooltip: the shown step names joined by " → ". */
export const loopPathTitle = (loop: CrewLoop): string =>
  loopSteps(loop)
    .map((s) => s.name)
    .join(" → ");

/** A row whose run is in a loop that has not finished: it belongs in Work in flight. */
export const isLoopInFlight = (row: Pick<CrewRow, "loop" | "run">): boolean =>
  row.loop !== null && row.loop.phase !== "done" && row.run !== null && row.run.endedAt === null;

/** A crew seat with no open run: free for work, whatever its last run's ticket was. */
export const isSeatFree = (row: Pick<CrewRow, "kind" | "run" | "reviewing">): boolean =>
  row.kind === "crew" && !row.reviewing && (row.run === null || row.run.endedAt !== null);

/** What a crew row's state pill says, beyond the engine's own states. */
export const MAX_STATE_PILL_LENGTH = 10;
export const SEAT_STATUS_LABEL = {
  ci: "Watching",
  review: "Review",
  blocked: "Blocked",
  parked: "Parked",
  idle: "Idle",
  free: "Free",
} as const;

/** The doing line of a free seat. */
export const SEAT_FREE_LINE = "Free for work";

const ENGINE_STATES: readonly HudState[] = [
  "running",
  "stalled",
  "blocked",
  "error",
  "stopped",
  "parked",
];

/**
 * The one rule for a state pill: an observed loop keeps the engine's state; a crew seat says what
 * its open run is doing (waiting on CI or review, blocked, between turns) or that it is free.
 */
export type SeatStatus = { label: string; tone: HudTone; reason?: string };

export function seatStatus(row: CrewRow): SeatStatus {
  if (row.crewPause) return { label: "Paused", tone: "warn", reason: row.crewPause.reason };
  if (row.reviewing && (row.hudState === "idle" || row.hudState === "running"))
    return { label: "Checking", tone: "neutral" };
  const engine = { label: HUD_STATE_LABEL[row.hudState], tone: HUD_STATE_TONE[row.hudState] };
  const reason = row.loop?.parked ?? row.note ?? undefined;
  if (row.kind !== "crew" || ENGINE_STATES.includes(row.hudState)) {
    return (row.hudState === "blocked" || row.hudState === "parked") && reason
      ? { ...engine, reason }
      : engine;
  }
  if (isSeatFree(row)) return { label: SEAT_STATUS_LABEL.free, tone: "neutral" };
  switch (row.loop?.phase) {
    case "ci":
      return { label: SEAT_STATUS_LABEL.ci, tone: "neutral" };
    case "review":
      return { label: SEAT_STATUS_LABEL.review, tone: "neutral" };
    case "parked":
      return reason
        ? { label: SEAT_STATUS_LABEL.parked, tone: "warn", reason }
        : { label: SEAT_STATUS_LABEL.parked, tone: "warn" };
    default:
      return row.hudState === "idle" ? { label: SEAT_STATUS_LABEL.idle, tone: "neutral" } : engine;
  }
}

/** Whether a seat has a run in flight: its latest run is running and has not ended. */
export const hasActiveRun = (row: Pick<CrewRow, "run">): boolean =>
  row.run !== null && row.run.status === "running" && row.run.endedAt === null;

/**
 * The seats of the repo's crew session that can take a ticket now: not a scratch copy, not the
 * watch seat, and without a run in flight. Empty when the repo has no session.
 */
export function freeSeats(config: ConfigView, crew: Crew, repoId: string) {
  const session = config.crew?.sessions.find((s) => s.repoId === repoId);
  return (session?.seats ?? []).filter((seat) => {
    const row = crew.rows.find((r) => r.id === seat.id);
    return seat.mode !== "scratch" && seat.loop !== "watch" && (!row || !hasActiveRun(row));
  });
}

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

/** Resolve a seat id or its call sign, ignoring case and preferring an exact id. */
export function namedSeat(id: string, rows: readonly CrewRow[] | undefined): CrewRow | undefined {
  return (
    rows?.find((row) => row.id === id) ??
    rows?.find(
      (row) =>
        row.id.toLowerCase() === id.toLowerCase() ||
        callSign(row).toLowerCase() === id.toLowerCase(),
    )
  );
}

/** A configured seat's display name, with the raw call sign as a loading/unknown fallback. */
export function seatName(id: string, rows: readonly CrewRow[] | undefined): string {
  const row = namedSeat(id, rows);
  return row ? callSign(row) : seatCallSign(id);
}

/** Subscribe labels to crew updates, including a rename. */
export function useSeatName(): (id: string) => string {
  const rows = useResource<Crew>(RESOURCES.crew).data?.rows;
  return useCallback((id: string) => seatName(id, rows), [rows]);
}

/** Whether Work should show current references rather than the last assignment. */
export function isCurrentWork(row: CrewRow): boolean {
  if (row.paused || row.hudState === "stopped" || row.hudState === "error") return false;
  if (row.reviewing && (row.hudState === "idle" || row.hudState === "running")) return true;
  if (["running", "stalled", "parked"].includes(row.hudState)) return true;
  if (isSeatFree(row)) return false;
  return (
    ["waiting", "blocked"].includes(row.hudState) ||
    (row.kind === "crew" && ["ci", "review", "parked"].includes(row.loop?.phase ?? ""))
  );
}
