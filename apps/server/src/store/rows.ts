import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type {
  AccountId,
  BoardItem,
  ChosenProfile,
  CiRunView,
  DefectRefs,
  DoneWhenEntry,
  Escalation,
  FlightDecision,
  FlightDecisionKind,
  GuardHit,
  GuardRule,
  LoopKind,
  ReportedTest,
  ReviewRow,
  ReviewState,
  ReviewVerdict,
  Run,
  RunLoop,
  SeatSessionRow,
  SeatState,
  TokenUsage,
  UsageSample,
} from "@mc/core";
import { FLIGHT_WAKE_STORED_BYTES } from "@mc/core";
import type { Evidence, QueueRow, SeatQuestion } from "../store.ts";

type Row = Record<string, SQLInputValue>;

export const evidenceOf = (r: Row): Evidence => ({
  id: r.id as number,
  runId: r.run_id as string,
  note: r.note as string,
  at: r.at as number,
  tests: JSON.parse(r.tests as string) as ReportedTest[],
  testsAdded: JSON.parse(r.tests_added as string) as Evidence["testsAdded"],
  doneWhen: JSON.parse(r.done_when as string) as DoneWhenEntry[],
});

export const toSample = (r: Row): UsageSample => ({
  accountId: r.account_id as string,
  window: r.window as "5h" | "7d",
  at: r.at as number,
  pct: r.pct as number,
  resetAt: r.reset_at as number,
  source: r.source as string,
});

/** A run's stored plan fact; a value that won't parse is dropped rather than failing every run read. */
export function parsePlan(raw: string): { plan?: Run["plan"] } {
  try {
    const plan = JSON.parse(raw) as Run["plan"];
    return plan !== null && typeof plan === "object" ? { plan } : {};
  } catch {
    return {};
  }
}

export const toRun = (r: Row): Run => ({
  ...(r.vendor === "codex" ? { vendor: "codex" as const } : {}),
  ...(r.latest_plan == null ? {} : { latestPlan: r.latest_plan as string }),
  // Absent, not null, on a row from before the ticket's title was stored.
  ...(r.ticket_title === null || r.ticket_title === undefined
    ? {}
    : { ticketTitle: r.ticket_title as string }),
  // Absent, not null, on a run that did not record its CLI version.
  ...(r.cli_version === null || r.cli_version === undefined
    ? {}
    : { cliVersion: r.cli_version as string }),
  ...(r.account_id == null ? {} : { accountId: r.account_id as AccountId }),
  ...(r.effort == null ? {} : { effort: r.effort as string }),
  ...(r.loop_kind == null ? {} : { loopKind: r.loop_kind as LoopKind }),
  ...(r.prompt_hash == null ? {} : { promptHash: r.prompt_hash as string }),
  // Absent, not null, on a run no loop drives or that has no recorded ender.
  ...(r.loop === null || r.loop === undefined
    ? {}
    : { loop: JSON.parse(r.loop as string) as RunLoop }),
  ...(r.plan == null ? {} : parsePlan(r.plan as string)),
  // Absent, not null, on a run that started without a profile.
  ...(r.profile === null || r.profile === undefined
    ? {}
    : {
        profile: {
          ...(JSON.parse(r.profile as string) as ChosenProfile),
          hash: r.profile_hash as string,
        },
      }),
  ...(r.ended_by === null || r.ended_by === undefined
    ? {}
    : { endedBy: r.ended_by as NonNullable<Run["endedBy"]> }),
  ...(r.no_report == null
    ? {}
    : { noReport: JSON.parse(r.no_report as string) as Run["noReport"] }),
  id: r.id as string,
  agentId: r.agent_id as string,
  repoId: r.repo_id as string,
  seq: r.seq as number,
  startedAt: r.started_at as number,
  endedAt: r.ended_at as number | null,
  status: r.status as Run["status"],
  sessionId: r.session_id as string | null,
  model: r.model as string | null,
  branch: r.branch as string | null,
  ticket: r.ticket as string | null,
  costUsd: r.cost_usd as number | null,
  tokens: r.tokens === null ? null : (JSON.parse(r.tokens as string) as TokenUsage),
  transcriptPath: r.transcript_path as string,
  prs: JSON.parse(r.prs as string) as Run["prs"],
  summary: r.summary as string | null,
  reviewId: (r.review_id ?? null) as number | null,
});

export const toBoardItem = (r: Row): BoardItem => ({
  repoId: r.repo_id as string,
  issueNumber: r.issue_number as number,
  title: r.title as string,
  status: r.status as string,
  state: r.state as BoardItem["state"],
  labels: JSON.parse(r.labels as string) as string[],
  assignees: JSON.parse(r.assignees as string) as string[],
  ...(typeof r.author === "string" ? { author: r.author } : {}),
  priority: r.priority as string | null,
  updatedAt: r.updated_at as number,
  url: r.url as string,
  stage: r.stage as BoardItem["stage"],
  owner: r.owner as BoardItem["owner"],
  parent: r.parent as number | null,
  subIssues:
    r.sub_total === null ? null : { done: r.sub_done as number, total: r.sub_total as number },
  blockedBy: JSON.parse(r.blocked_by as string) as BoardItem["blockedBy"],
  ...(typeof r.after_deps === "string"
    ? { after: JSON.parse(r.after_deps) as NonNullable<BoardItem["after"]> }
    : {}),
  ...(typeof r.defect_refs === "string"
    ? { defectRefs: JSON.parse(r.defect_refs) as DefectRefs }
    : {}),
  milestone: r.milestone as string | null,
  size: r.size as string | null,
  closed: r.closed === 1,
  prioritySource: r.priority_source as BoardItem["prioritySource"],
  createdAt: r.created_at as number,
  itemId: r.item_id as string | null,
  projectId: r.project_id as string | null,
});

export const toFlightDecision = (r: Row): FlightDecision => ({
  ...(r.order_id == null ? {} : { orderId: Number(r.order_id) }),
  ...(r.wake_id == null ? {} : { wakeId: r.wake_id as string }),
  id: r.id as number,
  at: r.at as number,
  kind: r.kind as FlightDecisionKind,
  seatId: r.seat_id as string | null,
  targetRunId: r.target_run_id as string | null,
  ref: r.ref as string | null,
  questionId: r.question_id as number | null,
  about: r.about as string,
  decision: r.decision as string,
  basis: r.basis as string,
});

export const toCiRun = (r: Row): CiRunView => ({
  repoId: r.repo_id as string,
  prNumber: r.pr_number as number,
  sha: r.sha as string,
  workflow: r.workflow as string | null,
  name: r.name as string,
  attempt: r.attempt as number,
  state: r.state as CiRunView["state"],
  conclusion: r.conclusion as string,
  url: r.url as string | null,
  firstSeenAt: r.first_seen_at as number,
  at: r.at as number,
});

export const toEscalation = (r: Row): Escalation => ({
  id: r.id as string,
  repoId: r.repo_id as string,
  issueNumber: r.issue_number as number,
  title: r.title as string,
  kind: r.kind as Escalation["kind"],
  source: r.source === "title" ? "title" : "label",
  openedAt: r.opened_at as number,
  url: r.url as string,
  question:
    r.question === null ? null : (JSON.parse(r.question as string) as Escalation["question"]),
});

export const toReview = (r: Row): ReviewRow => ({
  id: r.id as number,
  authorRunId: r.author_run_id as string,
  repoId: r.repo_id as string,
  seatId: r.seat_id as string,
  prNumber: r.pr_number as number,
  sha: r.sha as string,
  epoch: r.epoch as number,
  attempt: r.attempt as number,
  round: r.round as number,
  state: r.state as ReviewState,
  runId: r.run_id as string | null,
  verdict: r.verdict === null ? null : (JSON.parse(r.verdict as string) as ReviewVerdict),
  summary: r.summary as string | null,
  blocking: r.blocking as number,
  minor: r.minor as number,
  failure: r.failure as string | null,
  createdAt: r.created_at as number,
  startedAt: r.started_at as number | null,
  endedAt: r.ended_at as number | null,
});

export const toGuardHit = (r: Row): GuardHit => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  runId: r.run_id as string | null,
  rule: r.rule as GuardRule,
  text: r.text as string,
  at: r.at as number,
});

export const queueRow = (r: Row): QueueRow => ({
  seatId: r.seat_id as string,
  pos: r.pos as number,
  repoId: r.repo_id as string,
  issue: r.issue as number,
  takenAt: r.taken_at as number | null,
});

export const toQuestion = (r: Row): SeatQuestion => ({
  id: r.id as number,
  agentId: r.agent_id as string,
  runId: r.run_id as string,
  text: r.text as string,
  at: r.at as number,
  passedAt: r.passed_at as number | null,
  asideAt: (r.aside_at as number | null | undefined) ?? null,
});

export const seatRow = (r: Row): SeatSessionRow => ({
  ...(r.vendor === "codex" ? { vendor: "codex" as const } : {}),
  seatId: r.seat_id as string,
  runId: r.run_id as string | null,
  cliSessionId: r.cli_session_id as string | null,
  state: r.state as SeatState,
  reason: r.reason as string | null,
  ...(r.stop_by === null || r.stop_by === undefined
    ? {}
    : {
        stop: {
          by: r.stop_by as string,
          reason: r.stop_reason as string | null,
          at: r.stop_at as number,
        },
      }),
  worktree: r.worktree as string | null,
  updatedAt: r.updated_at as number,
  lastTurnEndedAt: (r.last_turn_ended_at as number | null | undefined) ?? null,
  lastTurnStartedAt: (r.last_turn_started_at as number | null | undefined) ?? null,
  quietTurns: (r.quiet_turns as number | null | undefined) ?? 0,
  ...(r.state === "error" ? { errorSince: (r.error_since ?? r.updated_at) as number } : {}),
});

/** The sha256 identifies a wake, nothing more: the hub keeps no past wake JSON to retrieve. */
export function compactFlightWake(text: string): string {
  const json = text.slice(text.lastIndexOf("\n") + 1);
  const suffix = `\nsha256:${createHash("sha256").update(json).digest("hex")}`;
  const limit = FLIGHT_WAKE_STORED_BYTES - Buffer.byteLength(suffix);
  let header = "";
  let bytes = 0;
  for (const char of text.split("\n", 1)[0] ?? "") {
    bytes += Buffer.byteLength(char);
    if (bytes > limit) break;
    header += char;
  }
  return header + suffix;
}
