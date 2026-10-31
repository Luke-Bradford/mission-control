import type {
  AgentState,
  AwaySettings,
  BoardItem,
  Crew,
  CrewRow,
  CrewSummary,
  CrewSummaryRow,
  Escalation,
  PullRequestView,
  Run,
  SeatSessionRow,
  SubagentInfo,
} from "./types.ts";
import { zoneFormatter } from "./util.ts";

export const STALL_MS = 10 * 60_000;
/** The stall threshold while the run has a background task in flight (ruling R21). */
export const BACKGROUND_STALL_MS = 60 * 60_000;
/** The Needs-you text of a stalled agent. */
export const STALL_TEXT = "No output";
export const STREAM_TEXT_MAX = 2000;
/** A file's diff (`/api/agents/:id/files/diff`) is cut at this many characters. */
export const DIFF_MAX_CHARS = 200_000;
/** The Files tab's answer for a read-only or scratch seat: it writes nothing. */
export const READONLY_FILES_NOTE = "Read-only agent: no file changes.";

/** Why Update is off, and the toast of a check, when the hub already runs origin/main's code. */
export const UP_TO_DATE_MAIN = "Up to date with main.";
/** Why Update (and Check for updates) is off when the server has no updater. */
export const UPDATE_UNAVAILABLE = "updates are not available on this server";
/** `GET /api/update/log` when update.log exists but cannot be read; the errno and path stay in the hub log. */
export const UPDATE_LOG_UNREADABLE = "could not read update.log";
/** Why Update (and Check for updates) is off on a preview server. */
export const PREVIEW_SERVER = "this is a preview server";
export const FLIGHT_NOT_RUNNING = "FLIGHT is not running yet. It arrives in phase 3.";
export const ENGINE_NOT_RUNNING = "Arrives with the engine (phase 2).";
export const RETRY_NOTE =
  "Tries 1 and 2 resume the same agent; try 3 starts a fresh agent on a stronger model; after that the ticket parks for you. A retry that makes no progress (same failures, same diff) stops early.";

/** Telemetry ranges, in minutes. */
export const TELEMETRY_RANGES = { "1h": 60, "6h": 360, "24h": 1440, "7d": 10080 } as const;
export type TelemetryRange = keyof typeof TELEMETRY_RANGES;
/** History charts have this many points whatever the range. */
export const TELEMETRY_POINTS = 72;
/** The live tokens-per-minute chart covers this many minutes. */
export const LIVE_MINUTES = 60;
/** Cycle-time rows, in display order; issues without a size go in a last `NO_SIZE` row. */
export const TICKET_SIZES = ["XS", "S", "M", "L", "XL"] as const;
export type TicketSize = (typeof TICKET_SIZES)[number];
export const NO_SIZE = "none";

export const DEFAULT_AWAY: AwaySettings = {
  on: false,
  until: "",
  may: { pickUp: true, research: true, check: true, status: true, safePr: true },
};

/** The most keys one `POST /api/attention/ack` takes; clients send more in batches. */
export const ACK_BATCH_MAX = 50;

export const METER_WARN_PCT = 80;
export const METER_FULL_PCT = 100;

/** Flow history (cycle time, first-push CI) covers this many days. */
export const FLOW_DAYS = 14;
export const FLOW_COLLECTOR_PREFIX = "flow:";
export const flowCollector = (repoId: string): string => `${FLOW_COLLECTOR_PREFIX}${repoId}`;
/** Starts with `github:` so the Sources pill picks it up. */
export const prSweepCollector = (repoId: string): string => `github:${repoId}:prs`;
export const MACHINE_COLLECTOR = "machine";
/** The job that folds the transcripts of runs older than the collectors' fold window (#26 A3). */
export const BACKFILL_COLLECTOR = "backfill";
export const USAGE_COLLECTOR_PREFIX = "usage:";
export const usageCollector = (accountId: string): string =>
  `${USAGE_COLLECTOR_PREFIX}${accountId}`;

/** The settings key under which the collector keeps a loop's driver stop (JSON `DriverStop`). */
export const driverStopKey = (loopId: string): string => `driver-stop:${loopId}`;

function zoneParts(ms: number, timeZone: string) {
  const f = zoneFormatter(timeZone, {
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return p as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Offset (ms, local minus UTC) of `timeZone` at the instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** `HH:MM` (24-hour) of the instant `ms` in `timeZone`. */
export function clockHm(ms: number, timeZone: string): string {
  const p = zoneParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Epoch ms of local midnight of the day containing `ms` in `timeZone` (DST-safe). */
export function startOfLocalDay(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day);
  const DAY = 86_400_000;
  const candidates = [
    wall - offsetAt(wall - DAY, timeZone),
    wall - offsetAt(wall + DAY, timeZone),
    wall - offsetAt(wall, timeZone),
  ].sort((a, b) => a - b);
  for (const c of candidates) {
    const q = zoneParts(c, timeZone);
    if (
      q.year === p.year &&
      q.month === p.month &&
      q.day === p.day &&
      q.hour === 0 &&
      q.minute === 0 &&
      q.second === 0
    ) {
      return c;
    }
  }
  return wall - offsetAt(wall, timeZone);
}

export const HUD_STATES = [
  "running",
  "stalled",
  "blocked",
  "parked",
  "waiting",
  "idle",
  "stopped",
  "error",
] as const;
export type HudState = (typeof HUD_STATES)[number];

export const HUD_STATE_LABEL: Record<HudState, string> = {
  running: "Running",
  stalled: "Stalled",
  blocked: "Blocked",
  parked: "Parked",
  waiting: "Waiting",
  idle: "Idle",
  stopped: "Stopped",
  error: "Error",
};

/** Changes into or out of these are recorded as Activity events (#26 B14); running <-> idle is not. */
export const NOTABLE_STATES: readonly HudState[] = [
  "stalled",
  "error",
  "blocked",
  "stopped",
  "parked",
];

/**
 * The Activity text for an agent changing HUD state: `{From} → {To}`, then the cause for the
 * states that have one (stalled: the silence; error: the source error; stopped: the driver's reason).
 */
export function stateChangeText(
  from: HudState,
  to: HudState,
  row: Pick<CrewRow, "stop" | "sourceError">,
): string {
  const head = `${HUD_STATE_LABEL[from]} → ${HUD_STATE_LABEL[to]}`;
  if (to === "stalled") return `${head}: no output for ${STALL_MS / 60_000} min`;
  if (to === "error" && row.sourceError) return `${head}: ${row.sourceError}`;
  if (to === "stopped" && row.stop) return `${head}: ${row.stop.reason}`;
  return head;
}

/**
 * Activity text for a crew seat's turn starting: a message took it from idle to running.
 * Assumes only the operator messages seats today (FLIGHT and other seats arrive later).
 */
export const SEAT_TURN_START_TEXT = "Idle → Running (your message)";
/** Activity text for a crew seat's turn ending. */
export const SEAT_TURN_END_TEXT = "Running → Idle (turn ended)";

/**
 * The Activity text for a crew seat's turn start or end, or null for any other change. Loops'
 * running <-> idle stays unrecorded (their idle between fires would be noise).
 */
export function seatTurnText(from: HudState, to: HudState): string | null {
  if (from === "idle" && to === "running") return SEAT_TURN_START_TEXT;
  if (from === "running" && to === "idle") return SEAT_TURN_END_TEXT;
  return null;
}

export const HUD_STATE_RANK: Record<HudState, number> = {
  error: 0,
  stalled: 0,
  blocked: 1,
  parked: 1,
  waiting: 2,
  running: 3,
  idle: 4,
  stopped: 5,
};

/** The colour family of a pill; `neutral` is grey with a dot. */
export type HudTone = "ok" | "warn" | "crit" | "neutral";

/** Mockup L112–114: green is being worked, amber waits, red is broken, grey is everything else. */
export const HUD_STATE_TONE: Record<HudState, HudTone> = {
  running: "ok",
  stalled: "warn",
  blocked: "warn",
  parked: "warn",
  waiting: "warn",
  error: "crit",
  idle: "neutral",
  stopped: "neutral",
};

/** A lamp's shape and colour: warn diamond, crit square, ok circle, off ring. */
export type HudLampKind = "ok" | "warn" | "crit" | "off";

/**
 * A state lamp. Running breathes (being worked); stalled and blocked breathe because they wait on
 * you; waiting (on another agent) and parked (your choice) hold still.
 */
export const HUD_STATE_LAMP: Record<HudState, { kind: HudLampKind; pulse: boolean }> = {
  running: { kind: "ok", pulse: true },
  stalled: { kind: "warn", pulse: true },
  blocked: { kind: "warn", pulse: true },
  waiting: { kind: "warn", pulse: false },
  parked: { kind: "warn", pulse: false },
  error: { kind: "crit", pulse: false },
  idle: { kind: "off", pulse: false },
  stopped: { kind: "off", pulse: false },
};

/** `plain` is a pill without the dot (a word, not a state). */
export type PillTone = HudTone | "plain";
export type PillSpec = { label: string; tone: PillTone };

export const CI_PILL: Record<NonNullable<PullRequestView["ci"]>, PillSpec> = {
  passing: { label: "CI passing", tone: "ok" },
  failing: { label: "CI failing", tone: "crit" },
  pending: { label: "CI pending", tone: "neutral" },
};

/** A finished subagent is grey: the mockup's green `Done` would read as being worked. */
export const SUBAGENT_PILL: Record<SubagentInfo["status"], PillSpec> = {
  running: { label: "Running", tone: "ok" },
  completed: { label: "Done", tone: "neutral" },
  failed: { label: "Failed", tone: "crit" },
  stopped: { label: "Stopped", tone: "neutral" },
};

/** A PR's one pill, first match wins: merged, closed, draft, then its review state. */
export function prPill(pr: {
  state: PullRequestView["state"];
  isDraft?: boolean;
  review?: PullRequestView["review"];
}): PillSpec {
  if (pr.state === "merged") return { label: "Merged", tone: "ok" };
  if (pr.state === "closed") return { label: "Closed", tone: "plain" };
  if (pr.isDraft) return { label: "Draft", tone: "plain" };
  if (pr.review === "changes") return { label: "Changes asked", tone: "crit" };
  if (pr.review === "approved") return { label: "Approved", tone: "ok" };
  if (pr.review === "requested") return { label: "Review asked", tone: "plain" };
  return { label: "Open", tone: "plain" };
}

/**
 * A run's pill. The agent's latest run, while still running, takes the agent's stall or error, so
 * a run never reads green while its agent is stalled or broken; every other run goes by status.
 */
export function runPill(
  run: Pick<Run, "id" | "status">,
  row: Pick<CrewRow, "hudState" | "run">,
): PillSpec {
  if (run.status === "running" && run.id === row.run?.id) {
    if (row.hudState === "stalled") return { label: "Stalled", tone: "warn" };
    if (row.hudState === "error") return { label: "Error", tone: "crit" };
  }
  switch (run.status) {
    case "running":
      return { label: "Running", tone: "ok" };
    case "failed":
      return { label: "Failed", tone: "crit" };
    case "blocked":
      return { label: "Blocked", tone: "warn" };
    case "ok":
      return { label: "Finished", tone: "neutral" };
    case "unknown":
      return { label: "Unknown", tone: "neutral" };
  }
}

/** When a run silent since `lastOutputAt` becomes stalled: the threshold `hudState` applies. */
export function stallStart(lastOutputAt: number, backgroundInFlight: boolean): number {
  return lastOutputAt + (backgroundInFlight ? BACKGROUND_STALL_MS : STALL_MS);
}

/**
 * The HUD state. A working run is stalled once its last output is STALL_MS old, or
 * BACKGROUND_STALL_MS while it waits on a background task of its own (a shell or subagent writes
 * nothing to the transcript until it ends).
 */
export function hudState(i: {
  state: AgentState;
  paused: boolean;
  /** The loop's driver stopped itself; it resumes on its own, so this is not a Needs-you item. */
  stopped: boolean;
  lastOutputAt: number | null;
  now: number;
  backgroundInFlight: boolean;
}): HudState {
  switch (i.state) {
    case "error":
      return "error";
    case "working": {
      const limit = i.backgroundInFlight ? BACKGROUND_STALL_MS : STALL_MS;
      return i.lastOutputAt !== null && i.now - i.lastOutputAt >= limit ? "stalled" : "running";
    }
    case "waiting-you":
      return "blocked";
    case "waiting-agent":
      return "waiting";
    case "idle":
      return i.paused ? "parked" : i.stopped ? "stopped" : "idle";
  }
}

/**
 * A crew seat's HUD state from its seat-session row. A running seat is stalled by the loops' rule:
 * STALL_MS without output, counted from the row's last change while it has written nothing.
 */
export function crewHudState(
  row: SeatSessionRow | null,
  lastOutputAt: number | null,
  now: number,
  /** The seat's run is in line for the test lock: it waits, silent, and is not stalled. */
  waitingForLock = false,
): HudState {
  if (row === null) return "idle";
  switch (row.state) {
    case "starting":
    case "running":
      if (waitingForLock) return "waiting";
      return now - (lastOutputAt ?? row.updatedAt) >= STALL_MS ? "stalled" : "running";
    case "idle":
      return "idle";
    case "parked":
      return "parked";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

export const HUD_COLUMNS = [
  "Backlog",
  "Refinement",
  "Blocked",
  "Ready",
  "In progress",
  "In review",
  "Ready for QA",
  "Done",
] as const;
export type HudColumn = (typeof HUD_COLUMNS)[number];

/** Shown on a card whose GitHub state and project Status disagree. */
export const STATUS_OUT_OF_DATE = "Status out of date";

/** The column the Status alone gives (an empty Status is Backlog), ignoring the issue's own state. */
function statusColumn(i: Pick<BoardItem, "status" | "state">): HudColumn {
  const status = i.status.trim().toLowerCase();
  if (status === "") return "Backlog";
  const named = HUD_COLUMNS.find((c) => c.toLowerCase() === status);
  if (named) return named;
  switch (i.state) {
    case "planned":
      return "Ready";
    case "in progress":
      return "In progress";
    case "review":
      return "In review";
    case "blocked":
      return "Blocked";
    case "done":
      return "Done";
  }
}

/** A closed issue is Done whatever its Status says. */
export function hudColumnOf(i: Pick<BoardItem, "status" | "state" | "closed">): HudColumn {
  return i.closed ? "Done" : statusColumn(i);
}

/** GitHub and the project disagree: closed outside Done, or open inside Done. */
export function statusOutOfDate(i: Pick<BoardItem, "status" | "state" | "closed">): boolean {
  return (statusColumn(i) === "Done") !== i.closed;
}

/** How long an open PR may sit unchanged, with no agent on its ticket, before it waits on you. */
export const PR_WAIT_MS = 60 * 60_000;

/**
 * What you have to do to a PR, or null when it is not waiting on you: it is open, no agent is
 * running on its ticket, and it has not changed for `PR_WAIT_MS`.
 */
export function prYouAction(
  pr: PullRequestView,
  agentRunning: boolean,
  now: number,
): string | null {
  if (pr.state !== "open" || agentRunning || now - pr.updatedAt < PR_WAIT_MS) return null;
  if (pr.isDraft) return "decide on the draft";
  return pr.review === "approved" ? "merge" : "review";
}

/** Sort order of the Needs-you list (catalogue 2.5.1). */
export const ATTENTION_KINDS = [
  "lock",
  "stalled",
  "error",
  "person",
  "decision",
  "approval",
  "question",
  "blocked",
  "review",
  "ready",
  "flag",
  "ratelimit",
  "tag",
  "parked",
  "pr",
  "message",
  "stray",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** Who an attention item waits on: the operator, FLIGHT, the controller, a lane's login or a loop. */
export type AttentionOwner = "operator" | "flight" | "controller" | "loop" | `lane:${string}`;
export const OWNER_OPERATOR = "operator" satisfies AttentionOwner;
export const FLIGHT_TRIAGE_LABEL = {
  waiting: "Waiting for FLIGHT triage",
  handling: "FLIGHT is handling",
  missed: "FLIGHT hasn't triaged this",
  down: "Waiting on FLIGHT — not triaging",
} as const;
export const OWNER_FLIGHT = "flight" satisfies AttentionOwner;
/**
 * Kinds that are always the operator's call: FLIGHT may brief them for the operator but never keep
 * them, and once past FLIGHT's triage window (or while FLIGHT is not triaging) they reach the
 * operator as themselves, never folded into the "FLIGHT is not triaging" item (#758).
 */
export const OPERATOR_CALL_KINDS: readonly AttentionKind[] = [
  "approval",
  "decision",
  "flag",
  "ratelimit",
];
export const OWNER_CONTROLLER = "controller" satisfies AttentionOwner;
export const OWNER_LOOP = "loop" satisfies AttentionOwner;
export const laneOwner = (login: string): AttentionOwner => `lane:${login}`;

export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  person: "Asked of you",
  decision: "Decision",
  approval: "Approval",
  question: "Question",
  message: "Message",
  tag: "Tagged you",
  stalled: "Stalled",
  parked: "Parked",
  error: "Error",
  pr: "PR",
  stray: "Stray file",
  lock: "Test lock",
  blocked: "Blocked",
  review: "Ready for review",
  ready: "Ready to merge",
  flag: "Check before merging",
  ratelimit: "Rate-limited",
};

/** A crew seat's doing line while its run is in line for the test lock. */
export const LOCK_WAITING_TEXT = "waiting for the test lock";

/** Why the commit tool recorded a stray: outside every writer's area, or inside another's. */
export const STRAY_KINDS = ["outside", "other-area"] as const;
export type StrayKind = (typeof STRAY_KINDS)[number];

/** A stray's Needs-you text; `owner` is the call sign whose area holds it (`other-area`). */
export function strayText(path: string, sessionId: string, owner: string | null): string {
  return owner === null
    ? `${path} changed in s/${sessionId} outside every agent's area`
    : `${path} changed in s/${sessionId} inside ${owner}'s area`;
}

/** A seat's `ask_flight` question, as FLIGHT and (once FLIGHT briefs it) the operator see it. */
export const questionText = (call: string, text: string): string => `${call} asks: ${text}`;

/** The lock item: seats in line behind a holder whose run has stalled. */
export const lockBlockedText = (waiting: readonly string[], holder: string): string =>
  `${waiting.join(", ")} waiting for the test lock, held by a stalled run (${holder})`;

export function escalationKind(e: Pick<Escalation, "kind" | "source">): AttentionKind {
  if (e.source === "label") return e.kind === "autonomy-question" ? "decision" : "question";
  switch (e.kind) {
    case "operator-decision":
    case "autonomy-question":
      return "decision";
    case "mvp-ready":
      return "approval";
    case "loop-blocked":
      return "parked";
  }
}

// Guard drawer, test lock (catalogue 2.5, 2.7.4, 2.1.4)

/** The Guard drawer's summary: blocked commands this week, and how many are not yet acknowledged. */
export const guardSummary = (total: number, fresh: number): string =>
  `Guard: ${total} blocked command${total === 1 ? "" : "s"}${fresh > 0 ? `, ${fresh} new` : ""} (for information)`;
export const GUARD_NONE_TEXT = "Guard: nothing blocked this week.";
export const GUARD_NOTE =
  "The guard catches agent mistakes and ordinary spellings, not deliberate evasion.";

/** The test lock, as the Overview box, Setup and the header say it. */
export const LOCK_FREE_TEXT = "No full-suite run in progress.";
export const LOCK_NOBODY_WAITING = "Nobody waiting.";
export const lockHolderText = (call: string, command: string, elapsed: string): string =>
  `${call} holds it: ${command} · ${elapsed}`;
export const lockWaitingLine = (call: string, elapsed: string): string =>
  `${call} waiting · ${elapsed}`;
/** The header's Lock span: the holder's call sign or "free", and the queue length. */
export const lockHeaderText = (holder: string | null, queued: number): string =>
  `Lock: ${holder ?? "free"}${queued > 0 ? ` +${queued}` : ""}`;
export const LOCK_HEADER_TITLE = "Full-suite test lock";

export const lockUsualText = (min: number, over: boolean): string =>
  `usually about ${min} min${over ? " · over its usual time" : ""}`;
export const LOCK_OUTCOME_TEXT = {
  done: "finished",
  pass: "passed",
  fail: "failed",
  freed: "freed with its run",
} as const;

/** Overview timeline window and maximum tool ticks per lane. */
export const TIMELINE_WINDOW_MS = 60 * 60_000;
export const TIMELINE_TICKS_MAX = 300;

/** How long a reversible decision waits before its recommended option applies. */
export const DECISION_DEFAULT_WAIT_MS = 40 * 60_000;

/** The Comms line recording an automatically applied decision. */
export const defaultAppliedText = (label: string, ask: string): string =>
  `Default applied: ${label} (${ask})`;

/** A crew row cut down to what the Overview reads (see `CrewSummaryRow`). */
export function crewRowSummary(row: CrewRow): CrewSummaryRow {
  const { events: _events, digest, asideRuns, ...rest } = row;
  return {
    ...rest,
    digest:
      digest === null
        ? null
        : {
            lastEventAt: digest.lastEventAt,
            minuteTokens: digest.minuteTokens,
            liveTool: digest.liveTool,
            lastText: digest.lastText,
            background: digest.background,
            contextTokens: digest.contextTokens,
            contextWindow: digest.contextWindow,
            compactions: digest.compactions,
          },
    ...(asideRuns === undefined
      ? {}
      : { asideRuns: asideRuns.map(({ events: _aside, ...run }) => run) }),
  };
}

export function crewSummary(crew: Crew): CrewSummary {
  return { rows: crew.rows.map(crewRowSummary), firstRunToday: crew.firstRunToday };
}

/** A page's first load moves at most this many bytes (gzipped) across all its responses. */
export const HUD_PAGE_BUDGET_BYTES = 500 * 1024;
/** No single response of a page's first load is over this many bytes (gzipped). */
export const HUD_RESPONSE_BUDGET_BYTES = 300 * 1024;
