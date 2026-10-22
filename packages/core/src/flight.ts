import type { HudColumn } from "./hud.ts";
import type { LoopKind, SeatState } from "./runtime.ts";
import type { LoopPhase } from "./types.ts";

// The FLIGHT seat: the head agent that runs the crew. It is the one `watch` seat, started with no
// ticket, and it keeps a log of what it decided (`flight_decisions`).

/** Every line the hub writes to FLIGHT starts with this; the dock tells them from the operator's. */
export const MC_LINE_PREFIX = "[Mission Control]";

/** The checkout name of a watch seat's detached worktree. */
export const watchCheckoutName = (seatId: string): string => `${seatId}-watch`;

export const watchStartRefusedText = (call: string): string =>
  `${call} runs the crew and is started without a ticket.`;
export const notWatchSeatText = (call: string): string => `${call} is not a watch seat.`;
export const ISSUE_REQUIRED = "issue: an issue number is required";
export const oneWatchSeatText = (first: string): string =>
  `only one seat may run the watch loop; ${first} already does`;
export const watchOnlyToolText = (t: string): string => `${t} is only for a watch role`;

export const FLIGHT_DECISION_KINDS = [
  "answer",
  "pass",
  "start",
  "message",
  "unpark",
  "note",
  "promote",
] as const;
export type FlightDecisionKind = (typeof FLIGHT_DECISION_KINDS)[number];

export interface FlightDecision {
  id: number;
  at: number;
  kind: FlightDecisionKind;
  seatId: string | null;
  targetRunId: string | null;
  ref: string | null;
  questionId: number | null;
  about: string;
  decision: string;
  basis: string;
}

/** `GET /api/flight`: the watch seat (null when none is configured) and the last day's decisions. */
export interface FlightView {
  seat: { id: string; call: string; model: string; state: SeatState | null; live: boolean } | null;
  decisions: FlightDecision[];
}

/** How far back `GET /api/flight` lists decisions, and the most it lists. */
export const FLIGHT_VIEW_MS = 24 * 60 * 60_000;
export const FLIGHT_VIEW_LIMIT = 100;
/** The most `log_decision` notes FLIGHT may log in an hour. */
export const FLIGHT_NOTES_PER_HOUR = 60;
export const FLIGHT_HOUR_MS = 60 * 60_000;

export const FLIGHT_ABOUT_MAX = 300;
export const FLIGHT_DECISION_MAX = 1000;
export const FLIGHT_BASIS_MAX = 500;

export const MC_FLIGHT_ONLY = "Not done: this tool is for the FLIGHT seat.";
export const MC_TICKET_READERS_ONLY = "Not read: this tool is for the FLIGHT and planner seats.";
export const notInSessionText = (seat: string): string =>
  `Not done: ${seat} is not a seat in your session.`;
export const capText = (what: string, n: number): string =>
  `Not done: you ${what} ${n} times in the last hour, the most allowed. Wait, or ask the operator.`;
export const FLIGHT_NOTED = "Noted in Decided without you.";

export const READY_LABEL = "ready";
export const hasPlanSection = (body: string): boolean => /^## Plan[ \t]*$/m.test(body);
/** The board columns a ticket FLIGHT starts may be in. */
export const FLIGHT_STARTABLE: readonly HudColumn[] = ["Backlog", "Refinement", "Ready"];
/** The park kinds whose lifting is FLIGHT's call. */
export const FLIGHT_UNPARK_KINDS = [
  "silent",
  "nothing",
  "stuck",
  "ci-pending",
  "no-ci",
  "refused",
  "ci",
] as const;
/** The tickets FLIGHT may start in an hour, per developer (build) seat in its session; at least this many. */
export const FLIGHT_STARTS_PER_HOUR = 4;
export const FLIGHT_TICKET_RESTART_MS = 24 * 60 * 60_000;
/** Answer, message and un-park decisions together. */
export const FLIGHT_MESSAGES_PER_HOUR = 30;
export const FLIGHT_MESSAGES_PER_SEAT_HOUR = 6;
export const FLIGHT_UNPARKS_PER_RUN = 2;
export const FLIGHT_READS_PER_HOUR = 60;

export const READ_NO_GITHUB = "Not read: GitHub could not be reached; try again in a few minutes.";
export const READ_NO_ISSUE = "Not read: there is no such issue.";
export const NOT_ON_BOARD = "not on the board";
export const ticketReadText = (
  n: number,
  title: string,
  column: string,
  body: string,
  cutNote: string | null,
): string => `#${n} ${title} [${column}]\n\n${cutNote === null ? "" : `${cutNote}\n\n`}${body}`;

export const ANSWER_ONE_OF = "give answer or pass_to_operator, not both";
export const noOpenQuestionText = (id: number): string =>
  `Not answered: there is no open question ${id}.`;
export const ANSWER_OWN_QUESTION = "Not answered: that is your own question to the operator.";
export const askerRunEndedText = (call: string): string =>
  `Not answered: the run of ${call} that asked it has ended.`;
export const PASSED_DECISION = "Passed to the operator";
export const PASSED_TEXT =
  "Passed to the operator. It is in the operator's Needs-you list now; your basis is in Decided without you.";
export const answerMessageText = (answer: string): string =>
  `FLIGHT, answering for the operator: ${answer}`;
export const notSentText = (why: string): string => `Not sent: ${why}`;
export const answeredText = (call: string): string => `Answered ${call}.`;

export const notDeveloperSeatText = (call: string): string =>
  `Not started: ${call} is not a developer seat.`;
export const startsByRuleText = (repoId: string): string =>
  `Not started: ${repoId} takes its tickets from Ready by rule.`;
export const seatHasRunText = (call: string): string => `Not started: ${call} already has a run.`;
export const accountStoppedText = (call: string, accountId: string): string =>
  `Not started: ${call}'s account ${accountId} is at its usage stop.`;
export const restartRefusedText = (ref: string): string =>
  `Not started: you started ${ref} in the last 24 hours; ask the operator before starting it again.`;
export const notOnBoardText = (ref: string): string => `Not started: ${ref} is not on the board.`;
export const wrongColumnText = (ref: string, column: string): string =>
  `Not started: ${ref} is in ${column}.`;
export const ticketHasRunText = (ref: string): string => `Not started: ${ref} already has a run.`;
export const claimedText = (ref: string, logins: readonly string[]): string =>
  `Not started: ${ref} is assigned to ${logins.join(", ")}; another hub or person has it.`;
export const waitsOnText = (ref: string, open: readonly string[]): string =>
  `Not started: ${ref} waits on ${open.join(", ")}.`;
export const START_NO_GITHUB = "Not started: GitHub could not be reached.";
export const notReadyText = (ref: string): string =>
  `Not started: ${ref} has no ## Plan section, no ready label, and is not in Ready.`;
export const wrongAreaText = (call: string, ref: string, labels: readonly string[]): string =>
  `Not started: ${ref} is in ${labels.join(", ")}, not ${call}'s area.`;
export const twoAreasText = (ref: string, labels: readonly string[]): string =>
  `Not started: ${ref} spans two areas (${labels.join(", ")}); ask the operator to split it.`;
export const START_NO_RULES = "Not started: the repo's rules could not be read.";
export const startFailedText = (why: string): string => `Not started: ${why}`;
export const START_FAILED = "Not started: the start failed.";
export const startedDecision = (call: string): string => `Started ${call}`;
export const startedText = (call: string, ref: string): string => `Started ${call} on ${ref}.`;

/** The most tickets FLIGHT may move on the board in an hour. */
export const FLIGHT_PROMOTES_PER_HOUR = 10;
/** The columns `promote` moves a card between. */
export const FLIGHT_MOVE_COLUMNS = [
  "Backlog",
  "Refinement",
  "Ready",
] as const satisfies readonly HudColumn[];
export type FlightMoveColumn = (typeof FLIGHT_MOVE_COLUMNS)[number];
export const hasDoneWhenSection = (body: string): boolean => /^## Done when[ \t]*$/m.test(body);

export const promoteDraftText = (repoId: string): string =>
  `Not moved: ${repoId} is a draft workspace, where Mission Control moves no cards.`;
export const PROMOTE_ENGINE_OFF =
  "Not moved: the loop engine is off on this server, so no card moves.";
export const PROMOTE_NO_RULES = "Not moved: the repo's rules could not be read.";
export const promoteOffText = (repoId: string): string =>
  `Not moved: ${repoId}'s rules do not let FLIGHT move tickets (promote_backlog is off); ask the operator with mc ask_operator.`;
export const moveNotOnBoardText = (ref: string): string => `Not moved: ${ref} is not on the board.`;
export const moveWrongColumnText = (ref: string, column: string): string =>
  `Not moved: ${ref} is in ${column}; promote moves Backlog to Ready or Refinement, Refinement to Ready, and back to Backlog only a ticket you moved.`;
export const moveHasRunText = (ref: string): string => `Not moved: ${ref} has a run.`;
export const PROMOTE_NO_GITHUB = "Not moved: GitHub could not be reached.";
export const missingNeedsText = (ref: string, missing: readonly string[]): string =>
  `Not moved: ${ref} has no ${missing.join(" or ")}; move it to Refinement and ask for it.`;
export const moveTwoAreasText = (ref: string, labels: readonly string[]): string =>
  `Not moved: ${ref} spans two areas (${labels.join(", ")}); ask the operator to split it.`;
export const moveNoAreaText = (ref: string): string => `Not moved: ${ref} has no area label.`;
export const moveWaitsOnText = (ref: string, open: readonly string[]): string =>
  `Not moved: ${ref} waits on ${open.join(", ")}.`;
export const moveFailedText = (reason: string): string => `Not moved: ${reason}`;
export const movedDecision = (to: string): string => `Moved to ${to}`;
export const movedText = (ref: string, to: string): string =>
  `Moved ${ref} to ${to}. Recorded in Decided without you.`;

export const OWN_SEAT_TEXT = "Not sent: that is your own seat.";
export const scratchSeatText = (call: string): string =>
  `Not sent: ${call} reviews what Mission Control hands it; it takes no messages from you.`;
export const seatMessageCapText = (call: string, n: number): string =>
  `Not sent: you sent ${call} ${n} messages in the last hour, the most allowed.`;
export const notParkedText = (call: string): string => `Not sent: ${call}'s run is not parked.`;
export const parkNotYoursText = (kind: string): string =>
  `Not sent: a ${kind} park is the operator's call; pass it to them with mc ask_operator.`;
export const unparkCapText = (n: number): string =>
  `Not sent: you have un-parked this run ${n} times; pass it to the operator with mc ask_operator.`;
export const ENGINE_OFF_TEXT =
  "Not sent: the loop engine is off on this server, so nothing can be un-parked.";
export const messageAboutText = (call: string): string => `Message to ${call}`;
export const sentText = (call: string): string => `Sent to ${call}.`;
export const sentUnparkedText = (call: string): string =>
  `Sent to ${call}, and its run is un-parked.`;

export interface FlightSeatState {
  id: string;
  call: string;
  role: string;
  loop: LoopKind;
  area: string[];
  state: SeatState | null;
  free: boolean;
  ticket: string | null;
  title: string | null;
  phase: LoopPhase | null;
  parked: { kind: string; reason: string } | null;
  stalled: boolean;
  idleMin: number | null;
  openQuestion: boolean;
  atStop: boolean;
}

/** The crew as FLIGHT reads it: in a wake line, and from the `flight_state` tool. */
export interface FlightState {
  time: string;
  repo: string;
  seats: FlightSeatState[];
  questions: { id: number; seat: string; ticket: string | null; text: string; ageMin: number }[];
  tickets: {
    ref: string;
    title: string;
    column: HudColumn;
    priority: string | null;
    labels: string[];
    ready: boolean;
    blockedBy: string[];
  }[];
  prs: { ref: string; pr: number; seat: string; ready: boolean }[];
  recent: { time: string; kind: FlightDecisionKind; about: string; decision: string }[];
  limits: { startsLeft: number; messagesLeft: number };
}

export const FLIGHT_TICKETS_LISTED = 30;
export const FLIGHT_RECENT_LISTED = 10;
/** How long Needs you holds a seat's question back while FLIGHT runs. */
export const FLIGHT_ANSWER_WAIT_MS = 20 * 60_000;
export const FLIGHT_TICK_MS = 5 * 60_000;
export const FLIGHT_DEBOUNCE_MS = 20_000;
export const FLIGHT_REWAKE_MS = 60 * 60_000;
/** Wakes of one FLIGHT run before it gets a fresh session. */
export const FLIGHT_MAX_WAKES = 40;
/** Starts of FLIGHT itself per hour, rotations not counted. */
export const FLIGHT_STARTS_MAX = 3;
export const FLIGHT_WAKE_HEAD = "[Mission Control] Wake:";
export const wakeKey = (runId: string, n: number): string => `flight:wake:${runId}:${n}`;
export const FLIGHT_NOTE_KEY = "flight:start-failed";
export const flightStartFailedText = (reason: string): string =>
  `FLIGHT could not be kept running: ${reason}. Start it again from FLIGHT's dock once that is fixed.`;
export const WAKE_ASK =
  "Act on it with your mc tools (mc flight_state reads it again), then end your turn with your summary for the operator.";

const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 questions · 1 free seat · 1 parked · 1 PR in review", with singulars; "nothing new" when all are 0. */
export function wakeSummary(s: FlightState): string {
  const free = s.seats.filter((x) => x.loop === "build" && x.free).length;
  const parked = s.seats.filter((x) => x.parked !== null).length;
  const parts = [
    s.questions.length > 0 ? counted(s.questions.length, "question", "questions") : "",
    free > 0 ? counted(free, "free seat", "free seats") : "",
    parked > 0 ? `${parked} parked` : "",
    s.prs.length > 0 ? counted(s.prs.length, "PR in review", "PRs in review") : "",
  ].filter((p) => p !== "");
  return parts.length === 0 ? "nothing new" : parts.join(" · ");
}

export function wakeLine(s: FlightState): string {
  return `${FLIGHT_WAKE_HEAD} ${wakeSummary(s)}\n${WAKE_ASK}\n${JSON.stringify(s)}`;
}
