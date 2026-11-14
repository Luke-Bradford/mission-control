import type {
  AgentId,
  AttentionKind,
  ChoiceTargetKind,
  CommsKind,
  CommsLabel,
  CommsSenderKind,
  DoneWhenEntry,
  FLIGHT_HEADLINE,
  FlightBriefSectionKey,
  HudColumn,
  HudState,
  PersonMessage,
  RepoId,
  ReportedTest,
  Run,
  SeatState,
  StrayKind,
} from "@mc/core";

export const COMMS_RETENTION_DAYS = 90;
export const FLIGHT_DECISIONS_RETENTION_DAYS = 90;
export const HISTORY_BATCH_ROWS = 500;
export const HISTORY_SWEEP_MAX_BATCHES = 10;
export const LIVE_COMMS_LIMIT = 5_000;
export const LIVE_LOOP_EVENTS_LIMIT = 5_000;
export const OPERATIONAL_RETENTION_DAYS = 90;
export const AUDIT_RETENTION_DAYS = 365;

/** One notification thread, as stored. */
export interface NotificationRow {
  id: string;
  repoId: RepoId;
  subjectType: string;
  title: string;
  number: number | null;
  reason: string;
  url: string;
  author: string | null;
  snippet: string | null;
  updatedAt: number;
  lastReadAt: number | null;
  unread: boolean;
  firstSeenAt: number;
  handledAt: number | null;
  handledHow: "marked" | "read" | "replied" | "copied" | "flight" | null;
  message?: PersonMessage;
  history?: PersonMessage[];
  /** The `updatedAt` that was handled: a thread updated after it is open again. */
  handledThrough: number | null;
}

/** What a GitHub read gives for a thread: the stored row less the bookkeeping the store owns. */
export type NotificationRead = Omit<
  NotificationRow,
  "unread" | "firstSeenAt" | "handledAt" | "handledHow" | "handledThrough"
>;

/** One section of FLIGHT's brief, as stored. */
export interface FlightBriefRow {
  sessionId: string;
  section: FlightBriefSectionKey | typeof FLIGHT_HEADLINE;
  text: string;
  updatedAt: number;
  updatedBy: string;
}

/** A card FLIGHT holds in Backlog behind an open PR. */
export interface Hold {
  ref: string;
  waitsOn: number;
  basis: string;
  at: number;
  releasedAt: number | null;
  /** The stored board has shown the card in Backlog since the hold; until then a Ready card is just stale. */
  seen: boolean;
  /** The PR state FLIGHT was last woken for on this hold, or null. */
  toldState: string | null;
}

/** One path a refused commit had outside the seat's area. */
export interface Stray {
  key: string;
  sessionId: string;
  path: string;
  /** The seat whose commit had it. */
  agentId: AgentId;
  kind: StrayKind;
  at: number;
}

/** A seat's open `ask_flight` question. */
export interface SeatQuestion {
  id: number;
  agentId: AgentId;
  runId: string;
  text: string;
  at: number;
  /** When FLIGHT passed it to the operator, else null. */
  passedAt: number | null;
  /**
   * When the operator set it aside with Not now (#1534), else null. It stays open and answerable
   * on the Ticket page, but it is not in Needs you and the end of its run does not close it.
   */
  asideAt: number | null;
}

/** An mc tool failure the operator is told of. */
export interface CrewError {
  id: number;
  agentId: AgentId;
  runId: string | null;
  text: string;
  at: number;
}

/** The seat states that still hold a run: the supervisor reattaches these after a restart. */
export const ACTIVE_SEAT_STATES: readonly SeatState[] = ["idle", "starting", "running", "parked"];

/** One held call of the test lock, as stored. */
export interface LockHoldRow {
  /** When the call joined the line; `since` when absent. Not a column of `test_lock_holds`. */
  queuedAt?: number;
  runId: string;
  toolUseId: string;
  seatId: string;
  command: string;
  since: number;
}

/** What the hub has acted on of a run's keeper: the lines of keeper `spawn` below `line`. */
export interface KeeperCursor {
  runId: string;
  spawn: string;
  line: number;
  rateLimitedUntil: number | null;
}

export const BUSY_TIMEOUT_MS = 5000;
/** Per-minute machine samples older than this (before the newest one) are deleted. */
export const MACHINE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** An ack whose key has been absent from the attention items for longer than this is deleted. */
export const ACK_ABSENT_MS = 7 * 24 * 60 * 60_000;

export type BoardMoveState = "pending" | "done" | "failed";

/** A run's fields FLIGHT's cost and wait figures read, with its digest's attempt usage. */
export interface FinancialRun
  extends Pick<Run, "id" | "agentId" | "startedAt" | "endedAt" | "status" | "costUsd"> {
  attemptUsage: { at: number | null; tokens: number }[];
}

/** One Status move of a run's card; `detail` is why it failed. */
export interface BoardMove {
  id: number;
  runId: string;
  repoId: RepoId;
  issue: number;
  column: HudColumn;
  state: BoardMoveState;
  detail: string | null;
  at: number;
}

/** One direction of a Comms link over a window, with its newest message. */
export interface CommsLinkCount {
  from: string;
  to: string;
  count: number;
  lastId: string;
  lastAt: number;
  lastText: string;
  tokens: number;
}

/** Who a seat line is from. */
/** A hand-off between agents; `from` and `to` are seat ids, COMMS_CAPCOM or COMMS_MC. */
export interface CommsRow {
  id: string;
  at: number;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
  label: CommsLabel | null;
  ref: string | null;
  replyTo: string | null;
  mentions: string[];
  senderKind: CommsSenderKind | null;
  /** `notice` for a line the hub wrote; null otherwise. */
  kind: CommsKind | null;
  /** When the recipient seat took the message; null while it is only stored. */
  deliveredAt: number | null;
  itemKey?: string;
}

/** The operator's choice on a question, as stored. */
export interface QuestionChoiceRow {
  key: string;
  briefAt: number;
  optionId: string;
  label: string;
  answer: string;
  question: string;
  ticket: string | null;
  target: string;
  targetKind: ChoiceTargetKind;
  /** The Comms message carrying the answer; null when none was stored. */
  messageId: string | null;
  /** Who chose, in words: "the operator", "FLIGHT" or "the controller". */
  chosenBy: string;
  chosenAt: number;
}

/** A slice of stored Comms: the crew channel, one pair, everything a seat sent or got, or its inbox. */
export type CommsReadScope =
  | { crew: true }
  | { pair: readonly [string, string] }
  | { agent: string }
  | { inbox: string };

export interface NewCommsRow {
  at: number;
  from: string;
  to: string;
  ticket: string | null;
  text: string;
  itemKey?: string;
  label?: CommsLabel | null;
  ref?: string | null;
  replyTo?: string | null;
  targetRunId?: string | null;
  /** The sending seat's run, stamped by the hub; not typed by the agent. */
  fromRunId?: string | null;
  /** The number of the sender's newest open PR, stamped by the hub. */
  pr?: number | null;
  mentions?: readonly string[];
  /**
   * Who sent it. The hub sets it from how the request was made, never from the text. Every send in
   * apps/server/src names it (comms-sender-kind.test.ts scans for that); only fixtures omit it.
   */
  senderKind?: CommsSenderKind;
  /** Defaults to `notice` for a hub message, so everything the hub writes is one. */
  kind?: CommsKind | null;
}

/** A FLIGHT settlement of a stale Comms question or blocker. */
export interface CommsSettlement {
  messageId: string;
  settledBy: string;
  reason: string;
  at: number;
}

/** Parse the sole external representation of a stored Comms message ID. */
export function commsMessageNumber(id: string): number | null {
  const match = /^comms:(\d+)$/.exec(id);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

export const THREAD_COMMS_LIMIT = 500;

/** The source and position of a stable Comms/transcript message ID. */
export function commsPosition(
  id: string,
): { source: string; offset: number; block: number } | null {
  const match = /^(comms):(\d+)$|^(stream:.+):(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const offset = Number(match[2] ?? match[4]);
  const block = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(block)) return null;
  const source = match[1] ?? match[3];
  return source === undefined ? null : { source, offset, block };
}

export type SeatLineOrigin = "operator" | "engine";

/** A line sent to a seat; its key is what makes sending it once-only. */
export interface SeatLine {
  runId: string;
  seatId: string;
  origin: SeatLineOrigin;
  text: string;
  at: number;
}

/** What a run's seat reported. */
export interface Evidence {
  id: number;
  runId: string;
  note: string;
  at: number;
  tests: ReportedTest[];
  testsAdded: { file: string; failedOnBase: boolean }[];
  /** The author's answer to each of the ticket's Done-when lines; empty for an older report. */
  doneWhen: DoneWhenEntry[];
}

/** One issue in a seat's queue; `takenAt` is set while the seat holds it. */
export interface QueueRow {
  seatId: string;
  pos: number;
  repoId: RepoId;
  issue: number;
  takenAt: number | null;
}

/** The attention kinds the engine raises as notes. */
export type NoteKind = Extract<
  AttentionKind,
  "blocked" | "review" | "ready" | "flag" | "ratelimit" | "question" | "approval"
>;

export interface NoteInput {
  key: string;
  kind: NoteKind;
  runId: string | null;
  seatId: string | null;
  repoId: RepoId | null;
  text: string;
  at: number;
}

export interface AttentionNote extends NoteInput {
  clearedAt: number | null;
  /** When the operator dismissed it from Needs you, else null. */
  dismissedAt: number | null;
}

/** One recorded HUD state change of an agent. */
export interface AgentEvent {
  agentId: AgentId;
  at: number;
  from: HudState;
  to: HudState;
  text: string;
}

/** A run still open (no end) this long before a query's end is an abandoned row, not live work. */
export const MAX_OPEN_RUN_AGE_MS = 30 * 24 * 60 * 60_000;
