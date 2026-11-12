import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type {
  BriefChoiceReceipt,
  ChoiceTargetKind,
  ItemChatMessage,
  ItemDiscussion,
  PersonSource,
  PromptSection,
  PromptSectionCost,
  PromptWakeCost,
  QaHistoryEntry,
  QaReport,
  RunHandoff,
  RunTokenAudit,
  TicketQuestion,
  TokenCall,
  TokenCounts,
  TokenSourceAdd,
} from "@mc/core";
import {
  type AccountId,
  type AgentId,
  ASKING_RUN_ENDED_REASON,
  type AttentionBrief,
  AUDIT_BASELINE_DAYS,
  AUDIT_CHANGE_WINDOW_MS,
  AUDIT_PR_OUTLIER_LINES,
  AUDIT_REFUSAL_SPIKE,
  AUDIT_SPEND_OUTLIER_FACTOR,
  AUDIT_TOOL_WINDOW_MS,
  type AuditChange,
  type AuditItem,
  type AuditMetrics,
  type AuditOveruseFacts,
  type AuditPrSize,
  type AuditRunKind,
  type AuditThresholds,
  type AuditTokenOveruse,
  type AuditView,
  auditTier,
  BLOCKING_SEVERITIES,
  type BoardItem,
  type BriefOption,
  CHATTER_NOTE_PREFIX,
  type CiRunView,
  CODE_HEALTH_FLIGHT_REVIEW_DAYS,
  CODE_HEALTH_FLIGHT_TIER_RULES,
  COMMS_CAPCOM,
  COMMS_CHATTER_ROUNDS,
  COMMS_CHATTER_WINDOW_MS,
  COMMS_CONTROLLER,
  COMMS_CREW,
  COMMS_MC,
  COMMS_NOTICE,
  COMMS_OPEN_PREFIX,
  COMMS_TEXT_MAX,
  type CommsKind,
  type CommsLabel,
  type CommsReaction,
  type CommsReactionKind,
  type CommsSenderKind,
  classifyOveruse,
  commsCutMarker,
  DECISION_DEFAULT_WAIT_MS,
  type DefectRefs,
  type DefectVia,
  type DoneWhenEntry,
  type Escalation,
  estimateTokens,
  type FindingResolution,
  FLIGHT_INCOMING_LIMIT,
  FLIGHT_LEDGER_OPEN,
  FLIGHT_MEMORY_FULL,
  FLIGHT_MEMORY_TOPICS_MAX,
  FLIGHT_PLAN_LIMIT,
  FLIGHT_POINTER_CHANGE_MAX,
  FLIGHT_RETROSPECTIVE_SETTING,
  FLIGHT_SIGNALS_SETTING,
  FLIGHT_WAKE_HEAD,
  FLIGHT_WAKE_STORED_BYTES,
  FLIGHT_WATCH_LIMIT,
  type FlightArrivalDisposition,
  type FlightDecision,
  type FlightDecisionKind,
  type FlightLedgerEntry,
  type FlightMemoryNote,
  type FlightMemoryTitle,
  type FlightMovedPointer,
  type FlightPlanInput,
  type FlightPlanOperation,
  type FlightPointer,
  type FlightPointerKind,
  type FlightWakeRecord,
  type FlightWatchEntry,
  type FlightWatchOperation,
  type FlowIssue,
  type FlowPr,
  GUARD_HITS_LIMIT,
  GUARD_RULES,
  type GuardHit,
  type GuardRule,
  groupOveruse,
  type HealthRow,
  type HudColumn,
  type HudState,
  inferTicket,
  isBugLabelled,
  type LoopEvent,
  type LoopKind,
  linkEscapedDefect,
  type MachineSample,
  type MergedPrFacts,
  memoryTopicKey,
  OLDER_FINDINGS_MAX,
  overusePrevention,
  PROMPT_BYTES_PER_TOKEN,
  PROMPT_SECTIONS,
  type PrCheck,
  type PrFileInput,
  type ProfileOverride,
  type PrTestsView,
  type PrTitle,
  type PullRequestView,
  prCarries,
  QA_RETENTION_DAYS,
  type QaFindingView,
  type QaFlowView,
  type QaReviewRoundView,
  type QuestionClosure,
  type QuestionClosureKind,
  type ReadRecord,
  type ReplyDraft,
  type RepoGoal,
  type RepoId,
  type ReportedTest,
  type ReviewCheck,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewRow,
  type ReviewShotView,
  type ReviewState,
  type ReviewVerdict,
  type Run,
  type RunDigest,
  type RunLoop,
  type RunStatus,
  reviewTimings,
  reworkRatios,
  type SeatSessionRow,
  type StoredFinding,
  type StrayKind,
  type Telemetry,
  type TestLockRun,
  TICKET_SIZES,
  TITLE_MARKERS,
  type TokenUsage,
  testsTouched,
  tokenBaselines,
  type UsageSample,
  validateMemoryNote,
  wakeKeyPrefix,
} from "@mc/core";
import { auditThresholds, messageImprovements, toolImprovements } from "./audit-improvements.ts";
import { CodeHealthReadError } from "./code-health/error.ts";
import {
  failGitFileSource,
  gitFileMetrics,
  gitFileSource,
  installGitFileSources,
  markGitFileChecked,
  recordGitFileSource,
} from "./code-health/git-store.ts";
import {
  installMergedReviews,
  mergedReviewRecords,
  recordMergedReviews,
} from "./code-health/merged-reviews.ts";
import {
  installRecommendations,
  linkRecommendation,
  type Mutation,
  mutateRecommendation,
  openRepeatedRoundsRows,
  RecommendationMutation,
  recommendationProposals,
  recommendationRow,
  recommendationRows,
  recommendationRowsForFiles,
  upsertRecommendation,
} from "./code-health/recommendations.ts";
import { remeasureDue } from "./code-health/remeasure.ts";
import {
  aggregateDatedRisk,
  datedPrFiles,
  installRiskMemberships,
  pruneRiskMemberships,
  recordRiskMembership,
  reviewedFileMembership,
} from "./code-health/risk.ts";
import {
  checkFileSizes,
  failFileSizes,
  fileSizeHistory,
  fileSizeSource,
  installFileSizes,
  recordFileSizes,
  sizedPaths,
} from "./code-health/size-store.ts";
import {
  codeHealthCiSource,
  codeHealthEvidenceSource,
  codeHealthReviewSource,
  codeHealthSizeSource,
  codeHealthSourceRevision,
  installCodeHealthRevisions,
} from "./code-health/source.ts";
import { installTestQa, linkTestQa, readTestQa } from "./code-health/test-qa.ts";
import {
  importTestReport,
  installTestReports,
  testAttemptSource,
  testCollectionCoverage,
} from "./code-health/test-reports.ts";
import { StandingInstructions } from "./instructions/standing.ts";
import { qaNativeIdentity } from "./qa/history-key.ts";
import { externalReviewKey } from "./review/external-key.ts";
import { openOlderFindings } from "./review/older-findings.ts";
import { strayKey } from "./store/crew-paths.ts";
import {
  compactFlightWake,
  evidenceOf,
  queueRow,
  seatRow,
  toBoardItem,
  toCiRun,
  toEscalation,
  toFlightDecision,
  toGuardHit,
  toQuestion,
  toReview,
  toRun,
  toSample,
} from "./store/rows.ts";
import {
  ACK_ABSENT_MS,
  ACTIVE_SEAT_STATES,
  type AgentEvent,
  type AttentionNote,
  AUDIT_RETENTION_DAYS,
  type BoardMove,
  type BoardMoveState,
  BUSY_TIMEOUT_MS,
  COMMS_RETENTION_DAYS,
  type CommsLinkCount,
  type CommsReadScope,
  type CommsRow,
  type CommsSettlement,
  type CrewError,
  commsMessageNumber,
  commsPosition,
  type Evidence,
  type FinancialRun,
  FLIGHT_DECISIONS_RETENTION_DAYS,
  type FlightBriefRow,
  HISTORY_BATCH_ROWS,
  HISTORY_SWEEP_MAX_BATCHES,
  type Hold,
  type KeeperCursor,
  LIVE_COMMS_LIMIT,
  LIVE_LOOP_EVENTS_LIMIT,
  type LockHoldRow,
  MACHINE_RETENTION_MS,
  MAX_OPEN_RUN_AGE_MS,
  type NewCommsRow,
  type NoteInput,
  type NoteKind,
  type NotificationRead,
  type NotificationRow,
  OPERATIONAL_RETENTION_DAYS,
  type QuestionChoiceRow,
  type QueueRow,
  type SeatLine,
  type SeatLineOrigin,
  type SeatQuestion,
  type Stray,
  THREAD_COMMS_LIMIT,
} from "./store/types.ts";
import { RERUN_REFUSED_ATTEMPT, RESUME_ATTEMPT, wasteQueries } from "./store/waste.ts";

export * from "./store/types.ts";

/** FLIGHT's answers to seats' questions, and the questions it passed on, outlive the 90-day log. */
const COMMS_QUESTION_THREAD_SQL =
  "COALESCE(label, '') = 'question' OR COALESCE(reply_to, -1) IN (SELECT q.id FROM comms q WHERE q.label = 'question')";
const DECISION_KINDS_KEPT_SQL = "'answer', 'pass'";

import { SCHEMA } from "./store/schema.ts";

type Row = Record<string, SQLInputValue>;

const DAY_MS = 86_400_000;

/** The median of the values, or null when there are none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const notificationRow = (r: Row): NotificationRow => ({
  ...(r.source_content ? JSON.parse(r.source_content as string) : {}),
  id: r.id as string,
  repoId: r.repo_id as string,
  subjectType: r.subject_type as string,
  title: r.title as string,
  number: r.number as number | null,
  reason: r.reason as string,
  url: r.url as string,
  author: r.author as string | null,
  snippet: r.snippet as string | null,
  updatedAt: r.updated_at as number,
  lastReadAt: r.last_read_at as number | null,
  unread: r.unread === 1,
  firstSeenAt: r.first_seen_at as number,
  handledAt: r.handled_at as number | null,
  handledHow: r.handled_how as NotificationRow["handledHow"],
  handledThrough: r.handled_through as number | null,
});

/** Memory in use as a percentage of the total; null when unmeasured or the total is unknown. */
const memPct = (s: MachineSample): number | null =>
  s.memUsedBytes !== null && s.memTotalBytes > 0 ? (s.memUsedBytes / s.memTotalBytes) * 100 : null;

/** `PRAGMA user_version` once the usage_samples dedupe and its unique index are in place. */
const USAGE_DEDUPE_VERSION = 1;
/**
 * A stored digest; one persisted before `background` existed has none in flight, one before
 * `compactions` existed has none counted, one before `lastText` existed has no text.
 */
const parseDigest = (json: string): RunDigest => {
  const d = { background: [], compactions: 0, lastText: null, ...JSON.parse(json) } as RunDigest;
  // One before the live tool's `detail` existed names it with nothing.
  return d.liveTool ? { ...d, liveTool: { detail: null, ...d.liveTool } } : d;
};

/**
 * The per-repo tables the GitHub collector rewrites, each with its key: the order in which
 * `changed()` reads a repo's rows, so a reordered but equal answer is not a change.
 */
const REPO_TABLES = {
  board_items: "issue_number",
  escalations: "id",
  pull_requests: "number",
} as const;
type RepoTable = keyof typeof REPO_TABLES;

/** How much of a link's newest message `commsLinkCounts` returns (the graph's hover preview). */
const COMMS_LINK_PREVIEW = 200;

function cutCommsText(text: string): string {
  const chars = Array.from(text);
  return chars.length > COMMS_TEXT_MAX
    ? `${chars.slice(0, COMMS_TEXT_MAX).join("")}${commsCutMarker(COMMS_TEXT_MAX, chars.length)}`
    : text;
}

/** Run ids per `digests()` query (well under SQLite's bound-parameter limit). */
const DIGEST_BATCH = 500;
const DIGEST_CONTEXT_WINDOW_SQL =
  "CASE WHEN json_valid(digest) THEN json_extract(digest, '$.contextWindow') END";

const toTokenCall = (r: Row): TokenCall => ({
  at: (r.at as number | null) ?? null,
  context: r.context as number,
  cacheRead: r.cache_read as number,
  cacheWrite: r.cache_write as number,
  output: r.output as number,
  added: JSON.parse(r.added as string) as TokenSourceAdd[],
});

export class Store {
  private readonly db: DatabaseSync;
  private readonly rawDb: DatabaseSync;
  /** Statements used by read-heavy views stay prepared for this Store's lifetime. */
  private readonly statements = new Map<string, StatementSync>();

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.rawDb.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** `busyTimeoutMs` is shortened only by tests that hold a lock on purpose. */
  /** The database file. */
  readonly path: string;
  readonly instructions: StandingInstructions;

  constructor(path: string, busyTimeoutMs = BUSY_TIMEOUT_MS) {
    this.path = path;
    // Wait up to the timeout for another writer's lock instead of failing at once.
    this.rawDb = new DatabaseSync(path, { timeout: busyTimeoutMs });
    // Store has many small methods. Cache every SQL text here so callers cannot accidentally
    // prepare the same statement on each HUD build.
    this.db = new Proxy(this.rawDb, {
      get: (target, property) => {
        if (property === "prepare") return (sql: string) => this.statement(sql);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.db.exec("PRAGMA journal_mode = WAL");
    const hasEpisodes = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'attention_episodes'")
      .get();
    this.db.exec(SCHEMA);
    if (!hasEpisodes)
      this.db.exec(
        "INSERT OR IGNORE INTO attention_episodes SELECT key, kind, seat_id, at, cleared_at FROM attention_notes",
      );
    this.migrate();
    this.instructions = new StandingInstructions(this.db);
    this.backfillAuditHistory();
    installRiskMemberships(this.db);
    installGitFileSources(this.db);
    installFileSizes(this.db);
    installRecommendations(this.db);
    installMergedReviews(this.db);
    installTestReports(this.db);
    installTestQa(this.db);
    installCodeHealthRevisions(this.db);
  }

  importCodeHealthTestReport(
    raw: unknown,
    actor: string,
    at: number,
    knownSecrets: readonly string[],
  ) {
    let result: ReturnType<typeof importTestReport> | undefined;
    this.transaction(() => {
      result = importTestReport(this.db, raw, actor, at, knownSecrets);
    }, true);
    if (!result) throw new Error("The test report was not stored.");
    return result;
  }
  linkCodeHealthTestQa(raw: unknown, actor: string, at: number, knownSecrets: readonly string[]) {
    let result: ReturnType<typeof linkTestQa> | undefined;
    this.transaction(() => {
      result = linkTestQa(this.db, raw, actor, at, knownSecrets);
    }, true);
    if (!result) throw new Error("The test QA proposal was not stored.");
    return result;
  }
  codeHealthTestQa(repoId: string, from: number, until: number) {
    return readTestQa(this.db, repoId, from, until);
  }
  codeHealthTestAttempts(repoId: string, from: number, until: number) {
    return testAttemptSource(this.db, repoId, from, until);
  }
  codeHealthTestCollection(repoId: string, from: number, until: number) {
    return testCollectionCoverage(this.db, repoId, from, until);
  }

  codeHealthRecommendations(repoId: string, openAt?: number) {
    return recommendationRows(this.db, repoId, openAt);
  }
  codeHealthOpenRepeatedRounds(repoId: string, at: number) {
    return openRepeatedRoundsRows(this.db, repoId, at);
  }
  codeHealthRecommendationPage(repoId: string, offset: number) {
    const rows = this.db
      .prepare(
        "SELECT id FROM code_health_recommendations WHERE repo_id=? ORDER BY created_at DESC,id LIMIT 51 OFFSET ?",
      )
      .all(repoId, offset);
    return {
      recommendations: rows
        .slice(0, 50)
        .map((row) => recommendationRow(this.db, repoId, String(row.id))),
      nextCursor: rows.length > 50 ? String(offset + 50) : null,
    };
  }
  codeHealthRecommendation(repoId: string, id: string) {
    return recommendationRow(this.db, repoId, id);
  }
  refreshCodeHealthRecommendations(repoId: string, at: number, checkout?: string) {
    this.transaction(() => {
      const proposals = recommendationProposals(this, repoId, at, checkout);
      for (const proposal of proposals) upsertRecommendation(this.db, proposal, at);
      const ids = proposals.map((row) => row.id);
      this.db
        .prepare(
          `UPDATE code_health_recommendations SET active=0,updated_at=MAX(?,updated_at+1) WHERE repo_id=? AND active=1 AND id NOT IN (${ids.map(() => "?").join(",")})`,
        )
        .run(at, repoId, ...ids);
    });
  }
  codeHealthFileRecommendations(repoId: string, paths: readonly string[], at: number) {
    return recommendationRowsForFiles(this.db, repoId, paths, at);
  }
  codeHealthDecisionRecorded(repoId: string, requestId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM code_health_recommendation_requests WHERE repo_id=? AND request_id=?",
        )
        .get(repoId, requestId) !== undefined
    );
  }
  decideCodeHealthRecommendation(
    repoId: string,
    id: string,
    request: Mutation,
    actor: string,
    at: number,
    flightId?: string,
  ) {
    let response: ReturnType<typeof mutateRecommendation> | undefined;
    this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT 1 FROM code_health_recommendation_requests WHERE repo_id=? AND request_id=?",
        )
        .get(repoId, request.requestId);
      response = mutateRecommendation(this.db, repoId, id, request, actor, at);
      if (!previous) {
        if (request.change.action === "accept" && flightId)
          this.insertComms(
            {
              at,
              from: COMMS_MC,
              senderKind: "hub",
              to: flightId,
              ticket: null,
              text: `Accepted code-health recommendation ${id} in ${repoId}. Read code_health with tab overview and recommendation ${id}, then use the existing authorised create_ticket path with recommendationId. Owner ${request.change.owner}; metric review ${new Date(request.change.reviewAt).toISOString()}. No code or rule change is approved by this action.`,
            },
            `Accepted code-health recommendation ${id} in ${repoId}. Read code_health with tab overview and recommendation ${id}, then use the existing authorised create_ticket path with recommendationId. Owner ${request.change.owner}; metric review ${new Date(request.change.reviewAt).toISOString()}. No code or rule change is approved by this action.`,
            null,
          );
        this.addFlightDecision({
          at,
          kind: "note",
          seatId: actor,
          targetRunId: null,
          ref: id,
          questionId: null,
          about: `Code health ${repoId}: ${id}`,
          decision: JSON.stringify({ actor, change: request.change, response: response.state }),
          basis: request.basis,
        });
      }
    }, true);
    if (!response) throw new Error("Recommendation transaction returned no result");
    return response;
  }
  /**
   * FLIGHT's own accept: only a FLIGHT-tier rule, with the seat as owner and the default review
   * date. The same transition, decision record and idempotency as the operator's accept.
   */
  flightAcceptCodeHealth(repoId: string, id: string, seatId: string, basis: string, at: number) {
    const row = recommendationRow(this.db, repoId, id);
    if (!row) throw new CodeHealthReadError(404, "Unknown code-health recommendation.");
    if (!CODE_HEALTH_FLIGHT_TIER_RULES.includes(row.rule))
      throw new CodeHealthReadError(
        403,
        "FLIGHT may not accept this kind of proposal; it stays with the operator.",
      );
    const request = RecommendationMutation.parse({
      requestId: randomUUID(),
      basis,
      expectedUpdatedAt: row.updatedAt,
      change: {
        action: "accept",
        owner: `FLIGHT (${seatId})`,
        reviewAt: at + CODE_HEALTH_FLIGHT_REVIEW_DAYS * DAY_MS,
      },
    });
    return this.decideCodeHealthRecommendation(repoId, id, request, seatId, at);
  }
  recordCodeHealthMergedReviews(repoId: string, at: number) {
    let changed = 0;
    this.transaction(() => {
      changed = recordMergedReviews(this.db, repoId, at);
    }, true);
    return changed;
  }
  codeHealthMergedReviews(repoId: string) {
    return mergedReviewRecords(this.db, repoId);
  }
  remeasureCodeHealth(repoId: string, at: number, checkout?: string) {
    let done: string[] = [];
    this.transaction(() => {
      done = remeasureDue(this, this.db, repoId, at, checkout);
    }, true);
    return done;
  }
  linkCodeHealthRecommendation(
    repoId: string,
    id: string,
    link: string,
    actor: string,
    at: number,
  ) {
    this.transaction(() => {
      linkRecommendation(this.db, repoId, id, link, at);
      this.addFlightDecision({
        at,
        kind: "ticket",
        seatId: actor,
        targetRunId: null,
        ref: id,
        questionId: null,
        about: `Code health ${repoId}: ${id}`,
        decision: `Linked ${link}`,
        basis: "Accepted recommendation; existing authorised FLIGHT ticket path.",
      });
    });
  }

  beginCodeHealthWork(repoId: string, id: string, fingerprint: string, at: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE code_health_recommendations SET work_attempt=? WHERE repo_id=? AND id=? AND work_attempt IS NULL AND json_extract(state,'$.kind')='accepted'",
      )
      .run(JSON.stringify({ fingerprint, at }), repoId, id);
    return Number(result.changes) === 1;
  }
  completeCodeHealthWork(repoId: string, id: string) {
    this.db
      .prepare(
        "UPDATE code_health_recommendations SET work_ready=1 WHERE repo_id=? AND id=? AND linked_work IS NOT NULL",
      )
      .run(repoId, id);
  }

  codeHealthDatedRisk(repoId: string, from: number, until: number) {
    return aggregateDatedRisk(datedPrFiles(this.db, repoId, from, until));
  }
  codeHealthGitSource(repoId: string, checkout: string) {
    return gitFileSource(this.db, repoId, checkout);
  }
  recordCodeHealthGitSource(
    repoId: string,
    checkout: string,
    source: Parameters<typeof recordGitFileSource>[3],
    at: number,
  ) {
    this.transaction(() => recordGitFileSource(this.db, repoId, checkout, source, at));
  }
  markCodeHealthGitChecked(repoId: string, checkout: string, sha: string, at: number) {
    markGitFileChecked(this.db, repoId, checkout, sha, at);
  }
  failCodeHealthGitSource(repoId: string, checkout: string, sha: string | null, at: number) {
    failGitFileSource(this.db, repoId, checkout, sha, at);
  }
  codeHealthGitMetrics(repoId: string, checkout: string, from: number, until: number, at: number) {
    return gitFileMetrics(this.db, repoId, checkout, from, until, at);
  }
  codeHealthReviewedFiles(repoId: string, from: number, until: number) {
    return reviewedFileMembership(this.db, repoId, from, until);
  }
  recordCodeHealthMembership(input: Parameters<typeof recordRiskMembership>[1]) {
    recordRiskMembership(this.db, input);
  }
  codeHealthRevision(repoId: string): string {
    return codeHealthSourceRevision(this.db, repoId);
  }

  /** A consistent, deferred read snapshot; WAL writers remain independent. */
  codeHealthSnapshot<T>(read: () => T): T {
    let result: T | undefined;
    this.transaction(() => {
      result = read();
    });
    return result as T;
  }

  codeHealthReviews(repoId: string, from: number, until: number) {
    return codeHealthReviewSource(this.db, repoId, from, until);
  }

  codeHealthCi(repoId: string, from: number, until: number) {
    return codeHealthCiSource(this.db, repoId, from, until);
  }

  codeHealthSizes(checkout: string) {
    return codeHealthSizeSource(this.db, checkout);
  }
  codeHealthSizeSnapshot(repoId: string, checkout: string) {
    return fileSizeSource(this.db, repoId, checkout);
  }
  codeHealthSizedPaths(
    repoId: string,
    checkout: string,
    sha: string,
    paths: readonly string[],
    minimum: number,
  ) {
    return sizedPaths(this.db, repoId, checkout, sha, paths, minimum);
  }
  recordCodeHealthSizeSnapshot(
    repoId: string,
    checkout: string,
    snapshot: Parameters<typeof recordFileSizes>[3],
    at: number,
  ) {
    this.transaction(() => recordFileSizes(this.db, repoId, checkout, snapshot, at));
  }
  checkCodeHealthSizes(repoId: string, checkout: string, sha: string, at: number) {
    checkFileSizes(this.db, repoId, checkout, sha, at);
  }
  failCodeHealthSizes(repoId: string, checkout: string, sha: string | null, at: number) {
    failFileSizes(this.db, repoId, checkout, sha, at);
  }
  codeHealthSizeHistory(
    repoId: string,
    checkout: string,
    paths: readonly string[],
    from: number,
    until: number,
    sha: string,
  ) {
    return fileSizeHistory(this.db, repoId, checkout, paths, from, until, sha);
  }

  codeHealthEvidence(query: Parameters<typeof codeHealthEvidenceSource>[1]) {
    return codeHealthEvidenceSource(this.db, query);
  }

  /** One-time-safe reconstruction from sources that already survived retention. */
  private backfillAuditHistory(): void {
    this.transaction(() => {
      const merged = this.pullRequestRows(
        this.db.prepare("SELECT * FROM pull_requests WHERE merged_at IS NOT NULL").all() as Row[],
      );
      const addPr = this.db.prepare(
        "INSERT OR IGNORE INTO pr_history (repo_id, number, merged_at, record) VALUES (?, ?, ?, ?)",
      );
      for (const pr of merged) addPr.run(pr.repoId, pr.number, pr.mergedAt, JSON.stringify(pr));
      const saved = this.db
        .prepare("SELECT key, value FROM settings WHERE key GLOB ?")
        .all(`${FLIGHT_RETROSPECTIVE_SETTING}:*`) as { key: string; value: string }[];
      const addReport = this.db.prepare(
        "INSERT OR IGNORE INTO retrospectives (repo_id, day, at, report) VALUES (?, ?, ?, ?)",
      );
      for (const row of saved) {
        try {
          const value = JSON.parse(row.value) as { day?: unknown; report?: { at?: unknown } };
          const repoId = row.key.slice(`${FLIGHT_RETROSPECTIVE_SETTING}:`.length);
          if (typeof value.day === "string" && typeof value.report?.at === "number")
            addReport.run(repoId, value.day, value.report.at, JSON.stringify(value.report));
        } catch {
          // A malformed settings value must not prevent the hub from opening.
        }
      }
    });
  }

  markCheckoutPending(path: string, at: number): void {
    this.db
      .prepare(
        "INSERT INTO checkouts_pending (path, at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET at = excluded.at",
      )
      .run(path, at);
  }

  checkoutPending(path: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM checkouts_pending WHERE path = ?").get(path) !== undefined
    );
  }

  clearCheckoutPending(path: string): void {
    this.db.prepare("DELETE FROM checkouts_pending WHERE path = ?").run(path);
  }

  /** Status rewrites that changed only a time, which `readVersion` does not count. */
  private timestampOnlyWrites = 0;

  /** Cache token for local writes and commits made by another SQLite connection. */
  readVersion(): string {
    return `${Number(this.db.prepare("SELECT total_changes() AS n").get()?.n) - this.timestampOnlyWrites}:${this.db.prepare("PRAGMA data_version").get()?.data_version}`;
  }

  private closed = false;

  /** Closes the database; the store is unusable after. Closing again does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  private hasColumn(table: string, column: string): boolean {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    return cols.some((c) => c.name === column);
  }

  /**
   * Runs `fn` if `table` lacks `column`. The check is made again inside a write-locked transaction
   * so a second process opening the same file waits, then finds the column added and skips it,
   * rather than failing on a duplicate ALTER.
   */
  private whenColumnMissing(table: string, column: string, fn: () => void): void {
    if (this.hasColumn(table, column)) return;
    this.transaction(() => {
      if (!this.hasColumn(table, column)) fn();
    }, true);
  }

  /** Adds `column` to `table` when it is missing. */
  private addColumn(table: string, column: string, type: string): void {
    this.whenColumnMissing(table, column, () =>
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`),
    );
  }

  /** Columns added after the first release; each runs once, on a database that lacks it. */
  private migrate(): void {
    // the forecast brake's Needs-you note is gone with the brake
    if (
      this.db.prepare("SELECT 1 FROM attention_notes WHERE key = 'budget-brake'").get() !==
      undefined
    )
      this.db.prepare("DELETE FROM attention_notes WHERE key = 'budget-brake'").run();
    // Token audit call times (#1646): audits stored before this have none until re-read.
    this.addColumn("run_token_calls", "at", "INTEGER");
    this.addColumn("run_token_audit", "timestamps_checked", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec("CREATE INDEX IF NOT EXISTS run_token_calls_at ON run_token_calls(at)");
    this.addColumn("flight_decisions", "order_id", "INTEGER");
    this.addColumn("flight_decisions", "wake_id", "TEXT");
    this.addColumn("flight_wakes", "wake_id", "TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS flight_memory_key ON flight_memory(repo_id, topic_key)",
    );
    // Flow now retains open work for the cumulative-flow chart. SQLite cannot drop NOT NULL in
    // place, so reconstruct databases created before open rows were recorded.
    const flowDone = this.db.prepare("PRAGMA table_info(flow_issues)").all() as Row[];
    if (flowDone.find((column) => column.name === "done_at")?.notnull === 1) {
      this.transaction(() => {
        const current = this.db.prepare("PRAGMA table_info(flow_issues)").all() as Row[];
        if (current.find((column) => column.name === "done_at")?.notnull !== 1) return;
        this.db.exec(`
          ALTER TABLE flow_issues RENAME TO flow_issues_before_open_work;
          CREATE TABLE flow_issues (
            repo_id TEXT NOT NULL, number INTEGER NOT NULL, size TEXT, start_at INTEGER,
            done_at INTEGER, PRIMARY KEY (repo_id, number)
          );
          INSERT INTO flow_issues (repo_id, number, size, start_at, done_at)
            SELECT repo_id, number, size, start_at, done_at FROM flow_issues_before_open_work;
          DROP TABLE flow_issues_before_open_work;
        `);
      }, true);
    }
    if (this.getSetting("flight-wake-compact-v1") === null) {
      this.transaction(() => {
        if (this.getSetting("flight-wake-compact-v1") !== null) return;
        const rows = this.db
          .prepare(
            "SELECT key, text FROM seat_lines WHERE key LIKE 'flight:wake:%' AND length(CAST(text AS BLOB)) > ?",
          )
          .all(FLIGHT_WAKE_STORED_BYTES) as { key: string; text: string }[];
        const update = this.db.prepare("UPDATE seat_lines SET text = ? WHERE key = ?");
        for (const row of rows) update.run(compactFlightWake(row.text), row.key);
        this.setSetting("flight-wake-compact-v1", "1");
      }, true);
    }
    // Discard the old later-state fallback starts; the next flow collection reads Ready history.
    if (this.getSetting("flow-ready-start-v1") === null) {
      this.transaction(() => {
        if (this.getSetting("flow-ready-start-v1") !== null) return;
        this.db.exec("DELETE FROM flow_issues");
        this.setSetting("flow-ready-start-v1", "1");
      }, true);
    }
    this.addColumn("notifications", "source_content", "TEXT");
    this.addColumn("briefs", "structured", "TEXT");
    this.addColumn("drafts", "source", "TEXT");
    this.addColumn("drafts", "metadata", "TEXT");
    this.addColumn("drafts", "completed_at", "INTEGER");
    // An ok row last succeeded when it was recorded; a failing row's last success is unknown.
    this.whenColumnMissing("collector_status", "last_ok_at", () => {
      this.db.exec("ALTER TABLE collector_status ADD COLUMN last_ok_at INTEGER");
      this.db.exec("UPDATE collector_status SET last_ok_at = at WHERE ok = 1");
    });
    // When a failing collector began failing; a row failing at upgrade takes its next poll's time.
    this.addColumn("collector_status", "failing_since", "INTEGER");
    this.whenColumnMissing("check_runs", "invoked_command", () => {
      this.db.exec("ALTER TABLE check_runs ADD COLUMN invoked_command TEXT");
      this.db.exec("UPDATE check_runs SET invoked_command = command WHERE invoked_command IS NULL");
    });
    this.addColumn("check_runs", "exit_code", "INTEGER");
    // A re-polled fallback reading has the same key every time: keep one row per reading. Once per
    // database (`PRAGMA user_version`); the unique index keeps it true afterwards. An up-to-date
    // database takes no write lock; one that is behind re-checks once it holds it.
    const userVersion = (): number =>
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version as number;
    if (userVersion() < USAGE_DEDUPE_VERSION) {
      this.transaction(() => {
        if (userVersion() >= USAGE_DEDUPE_VERSION) return;
        this.db.exec(
          `DELETE FROM usage_samples WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM usage_samples GROUP BY account_id, window, at, source
           )`,
        );
        this.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS usage_unique ON usage_samples(account_id, window, at, source)",
        );
        this.db.exec(`PRAGMA user_version = ${USAGE_DEDUPE_VERSION}`);
      }, true);
    }
    // Board columns added with the Stage/Owner/hierarchy fields; the next GitHub poll fills them.
    const boardColumns: [string, string][] = [
      ["author", "TEXT"],
      ["stage", "TEXT"],
      ["owner", "TEXT"],
      ["parent", "INTEGER"],
      ["sub_done", "INTEGER"],
      ["sub_total", "INTEGER"],
      ["blocked_by", "TEXT NOT NULL DEFAULT '[]'"],
      ["milestone", "TEXT"],
      ["size", "TEXT"],
      ["closed", "INTEGER NOT NULL DEFAULT 0"],
      ["priority_source", "TEXT"],
    ];
    for (const [column, type] of boardColumns) this.addColumn("board_items", column, type);
    // Logins assigned to the card's issue (a JSON list); the next GitHub poll fills it.
    this.addColumn("board_items", "assignees", "TEXT NOT NULL DEFAULT '[]'");
    // What the issue body waits on (`{ issues, prs }` JSON), null for none; the next poll fills it.
    this.addColumn("board_items", "after_deps", "TEXT");
    // What a bug card's body names (`{ prs, shas, paths }` JSON), null for none.
    this.addColumn("board_items", "defect_refs", "TEXT");
    // What a run was about (#26 A3). `folded`: the transcript of the ended run has been folded
    // into the row, so the backfill can skip it.
    const runColumns: [string, string][] = [
      ["vendor", "TEXT NOT NULL DEFAULT 'claude'"],
      ["latest_plan", "TEXT"],
      ["prs", "TEXT NOT NULL DEFAULT '[]'"],
      ["summary", "TEXT"],
      ["folded", "INTEGER NOT NULL DEFAULT 0"],
      // The first loop's state (JSON) and who ended the run; `upsertRun` never writes them.
      ["loop", "TEXT"],
      ["ended_by", "TEXT"],
      ["no_report", "TEXT"],
      // The ticket's title as the run started with it; null on rows from before it was stored.
      ["ticket_title", "TEXT"],
      // The review a run performs (7b-1); `upsertRun` never rewrites it.
      ["review_id", "INTEGER"],
      // The `claude` CLI version the run started on; null on rows from before it was recorded.
      ["cli_version", "TEXT"],
      // The template profile the run started with (JSON of profile and route) and its hash;
      // `upsertRun` writes them on a new row only.
      ["profile", "TEXT"],
      ["profile_hash", "TEXT"],
      // The plan at run creation; later transcript folds never rewrite it.
      ["plan", "TEXT"],
      ["account_id", "TEXT"],
      ["effort", "TEXT"],
      ["prompt_hash", "TEXT"],
      // The seat's loop kind at the start; `upsertRun` keeps the first value.
      ["loop_kind", "TEXT"],
    ];
    for (const [column, type] of runColumns) this.addColumn("runs", column, type);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS loop_events_run ON loop_events(run_id);
      CREATE INDEX IF NOT EXISTS reviews_run ON reviews(run_id);
      CREATE INDEX IF NOT EXISTS reviews_repo_pr ON reviews(repo_id, pr_number, state);
      CREATE INDEX IF NOT EXISTS board_moves_run ON board_moves(run_id);
      CREATE INDEX IF NOT EXISTS flight_decisions_target_kind ON flight_decisions(target_run_id, kind);
      CREATE INDEX IF NOT EXISTS flight_decisions_ref ON flight_decisions(ref, at);
      CREATE INDEX IF NOT EXISTS ci_runs_pr ON ci_runs(repo_id, pr_number);
      CREATE INDEX IF NOT EXISTS runs_review ON runs(review_id);
      CREATE INDEX IF NOT EXISTS runs_repo_branch ON runs(repo_id, branch);
      CREATE INDEX IF NOT EXISTS runs_repo_ticket ON runs(repo_id, ticket);
      CREATE INDEX IF NOT EXISTS runs_ended ON runs(ended_at);
      CREATE INDEX IF NOT EXISTS runs_folded ON runs(folded, started_at);
      CREATE INDEX IF NOT EXISTS runs_loop_aside ON runs(ended_at, json_extract(loop, '$.aside'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_merging ON runs(ended_at, json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_merging_started ON runs(json_extract(loop, '$.merging'), started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_agent_aside_worktree ON runs(agent_id, json_extract(loop, '$.aside.worktree'));
      CREATE INDEX IF NOT EXISTS runs_ended_started ON runs(ended_at, started_at, seq);
      CREATE INDEX IF NOT EXISTS runs_loop_pr_number ON runs(json_extract(loop, '$.prNumber'));
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_agent_recent ON runs(agent_id, started_at DESC, seq DESC, id);
      CREATE INDEX IF NOT EXISTS run_digests_context_window ON run_digests(run_id, ${DIGEST_CONTEXT_WINDOW_SQL});
      CREATE INDEX IF NOT EXISTS attention_notes_open ON attention_notes(cleared_at, at, key);
      CREATE INDEX IF NOT EXISTS attention_notes_run_open ON attention_notes(run_id, cleared_at, key);
      CREATE INDEX IF NOT EXISTS pull_requests_ticket ON pull_requests(ticket, updated_at DESC);
      CREATE INDEX IF NOT EXISTS pull_requests_branch ON pull_requests(repo_id, branch, number DESC);
      CREATE INDEX IF NOT EXISTS reviews_ended ON reviews(ended_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS attention_episodes_cleared ON attention_episodes(cleared_at);
      CREATE INDEX IF NOT EXISTS drafts_state_created ON drafts(state, created_at);
      CREATE INDEX IF NOT EXISTS crew_errors_acked_at ON crew_errors(acked, at);
      CREATE INDEX IF NOT EXISTS pr_history_at ON pr_history(merged_at);
      CREATE INDEX IF NOT EXISTS review_tests_review ON review_tests(review_id);
      CREATE INDEX IF NOT EXISTS seat_questions_answered ON seat_questions(answered_at);
      CREATE INDEX IF NOT EXISTS seat_questions_run_time ON seat_questions(run_id, at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS flight_decisions_question_answer ON flight_decisions(question_id, kind, at DESC, id DESC);
    `);
    // 0 / null: stored before the card ids were read; the next GitHub poll fills them.
    this.addColumn("board_items", "created_at", "INTEGER NOT NULL DEFAULT 0");
    // When the seat's last turn ended; the engine's quiet-seat check reads it.
    this.addColumn("seat_sessions", "last_turn_ended_at", "INTEGER");
    this.addColumn("comms", "item_key", "TEXT");
    this.addColumn("seat_sessions", "last_turn_started_at", "INTEGER");
    this.addColumn("seat_sessions", "error_since", "INTEGER");
    // Turns in a row that ended with no new commit; the resume line reads it.
    this.addColumn("seat_sessions", "quiet_turns", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("seat_sessions", "vendor", "TEXT NOT NULL DEFAULT 'claude'");
    this.addColumn("seat_sessions", "stop_by", "TEXT");
    this.addColumn("seat_sessions", "stop_reason", "TEXT");
    this.addColumn("seat_sessions", "stop_at", "INTEGER");
    this.addColumn("board_items", "item_id", "TEXT");
    this.addColumn("board_items", "project_id", "TEXT");
    // When FLIGHT passed the question to the operator (it stays open until they answer).
    this.addColumn("seat_questions", "passed_at", "INTEGER");
    // When the operator set the question aside with Not now; it stays open, out of Needs you.
    this.addColumn("seat_questions", "aside_at", "INTEGER");
    // When the operator dismissed the note from Needs you; a re-raised note is shown again.
    this.addColumn("attention_notes", "dismissed_at", "INTEGER");
    // A PR snapshot's `polledAt` is `read_at` (our clock, written with every upsert); there is no
    // separate column. `mergeable` UNKNOWN means GitHub has not computed it yet: poll again.
    this.addColumn("holds", "told_state", "TEXT");
    this.addColumn("decision_defaults", "target", "TEXT");
    this.addColumn("decision_defaults", "answer", "TEXT");
    this.addColumn("decision_defaults", "delivered_at", "INTEGER");
    this.addColumn("decision_defaults", "binding", "TEXT");
    this.addColumn("decision_defaults", "delivery_state", "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumn("decision_defaults", "delivery_note", "TEXT");
    this.addColumn("pull_requests", "head_sha", "TEXT");
    this.addColumn("pull_requests", "merge_commit_sha", "TEXT");
    this.addColumn("pull_requests", "mergeable", "TEXT");
    // Who opened the PR and who is assigned: a PR run by another hub's login is that lane's.
    this.addColumn("pull_requests", "author", "TEXT");
    this.addColumn("pull_requests", "assignees", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("pull_requests", "checks", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "tests", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "tests_added", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("run_evidence", "done_when", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("reviews", "changed_since", "TEXT");
    this.addColumn("review_findings", "late", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("review_findings", "category", "TEXT");
    this.addColumn("review_findings", "resolution", "TEXT");
    this.addColumn("review_findings", "resolved_review_id", "INTEGER");
    // Old PRs keep []: followPrs falls back to their ticket, even without another GitHub poll.
    this.addColumn("pull_requests", "closing_issues", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("pull_requests", "additions", "INTEGER");
    this.addColumn("pull_requests", "deletions", "INTEGER");
    this.addColumn("pull_requests", "changed_files", "INTEGER");
    // The branch the PR merges into: another open PR's branch means it is stacked on that PR.
    this.addColumn("pull_requests", "base", "TEXT");
    // On every start: a row whose branch names a ticket the pattern did not know when the row was
    // stored (`docs/` branches) gets it now. A row's ticket is never replaced.
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id, repo_id, branch FROM runs WHERE branch IS NOT NULL AND ticket IS NULL")
        .all() as { id: string; repo_id: string; branch: string }[];
      const set = this.db.prepare("UPDATE runs SET ticket = ? WHERE id = ?");
      for (const r of rows) {
        const ticket = inferTicket(r.branch, r.repo_id);
        if (ticket !== null) set.run(ticket, r.id);
      }
    });
    // When we read the row from GitHub, by our own clock (GitHub's updatedAt does not move when a
    // PR's CI finishes). 0: stored before it existed, older than any read.
    this.addColumn("pull_requests", "read_at", "INTEGER NOT NULL DEFAULT 0");
    // 1 while the latest poll failed to read the repo's PRs: the row is the last good read.
    this.addColumn("pull_requests", "stale", "INTEGER NOT NULL DEFAULT 0");
    // Machine samples' CPU and memory shares, extracted once so the telemetry ranges average
    // columns rather than parsing every sample's JSON.
    this.whenColumnMissing("machine_samples", "cpu_pct", () => {
      this.db.exec("ALTER TABLE machine_samples ADD COLUMN cpu_pct REAL");
      this.db.exec("ALTER TABLE machine_samples ADD COLUMN mem_pct REAL");
      // The same arithmetic as memPct, so a backfilled row equals a freshly stored one.
      this.db.exec(
        `UPDATE machine_samples SET
           cpu_pct = json_extract(sample, '$.cpuPct'),
           mem_pct = CASE WHEN json_extract(sample, '$.memTotalBytes') > 0
             THEN json_extract(sample, '$.memUsedBytes') * 1.0
               / json_extract(sample, '$.memTotalBytes') * 100 END`,
      );
    });
    // Rows from before `source`: a title marker (as the GitHub collector matches it) means
    // `title`. The next GitHub poll rewrites every row anyway.
    this.whenColumnMissing("escalations", "source", () => {
      this.db.exec("ALTER TABLE escalations ADD COLUMN source TEXT NOT NULL DEFAULT 'label'");
      this.db.exec(
        `UPDATE escalations SET source = 'title' WHERE ${TITLE_MARKERS.map(
          (m) => `ltrim(title) LIKE '[${m}]%'`,
        ).join(" OR ")}`,
      );
    });
    // Stored Comms v2 is deliberately additive: hubs can open databases written by older hubs.
    this.addColumn(
      "comms",
      "label",
      "TEXT CHECK (label IS NULL OR label IN ('question','handoff','blocker','none'))",
    );
    this.addColumn("comms", "ref", "TEXT");
    this.addColumn("comms", "reply_to", "INTEGER");
    this.addColumn("comms", "target_run_id", "TEXT");
    // The hub stamps a seat's message with the run that sent it and that run's newest open PR.
    this.addColumn("comms", "from_run_id", "TEXT");
    this.addColumn("comms", "pr", "INTEGER");
    // Set when waking the recipient failed, so an identical retry wakes them instead of being skipped.
    this.addColumn("comms", "wake_failed_at", "INTEGER");
    this.addColumn("comms", "delivered_at", "INTEGER");
    this.addColumn("question_choices", "chosen_by", "TEXT");
    // Who sent it, set by the hub; NULL on rows stored before this column.
    this.addColumn("comms", "sender_kind", "TEXT");
    // `notice` on a line the hub wrote; NULL on any other message.
    this.addColumn("comms", "kind", "TEXT");
    // An up-to-date reader must not take a write lock merely to open the store.
    if (
      this.db
        .prepare("SELECT 1 FROM comms WHERE sender_kind = ? AND kind IS NULL LIMIT 1")
        .get("hub")
    )
      this.db
        .prepare("UPDATE comms SET kind = ? WHERE sender_kind = ? AND kind IS NULL")
        .run(COMMS_NOTICE, "hub");
    this.migrateCommsLabels();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS comms_target_run ON comms(target_run_id, at, id);
      CREATE INDEX IF NOT EXISTS comms_ticket ON comms(ticket, at, id);
      CREATE INDEX IF NOT EXISTS comms_ref ON comms(ref, at, id);
      CREATE INDEX IF NOT EXISTS comms_ticket_count_refs ON comms(ticket, ref, from_id);
      -- Preserve reference totals when retention removes bodies. Null flags avoid sentinel collisions.
      CREATE TABLE IF NOT EXISTS comms_ticket_archived_counts (
        ticket TEXT NOT NULL, ref TEXT NOT NULL, from_id TEXT NOT NULL,
        ticket_null INTEGER NOT NULL, ref_null INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (ticket, ref, from_id, ticket_null, ref_null)
      );
      CREATE TRIGGER IF NOT EXISTS comms_archive_ticket_count BEFORE DELETE ON comms
      WHEN OLD.ticket IS NOT NULL OR OLD.ref IS NOT NULL
      BEGIN
        INSERT INTO comms_ticket_archived_counts (ticket, ref, from_id, ticket_null, ref_null, count)
        VALUES (COALESCE(OLD.ticket, ''), COALESCE(OLD.ref, ''), OLD.from_id,
          OLD.ticket IS NULL, OLD.ref IS NULL, 1)
        ON CONFLICT(ticket, ref, from_id, ticket_null, ref_null)
        DO UPDATE SET count = comms_ticket_archived_counts.count + 1;
      END;
      CREATE INDEX IF NOT EXISTS comms_reply_to ON comms(reply_to);
      CREATE TABLE IF NOT EXISTS comms_mentions (
        message_id INTEGER NOT NULL, mentioned_id TEXT NOT NULL, seen_at INTEGER,
        PRIMARY KEY (message_id, mentioned_id)
      );
      CREATE INDEX IF NOT EXISTS comms_mentions_target ON comms_mentions(mentioned_id, seen_at, message_id);
      CREATE TABLE IF NOT EXISTS comms_reactions (
        message_id INTEGER NOT NULL, actor_id TEXT NOT NULL, reaction TEXT NOT NULL
          CHECK (reaction IN ('seen','on_it','done','cant')),
        reason TEXT, at INTEGER NOT NULL,
        CHECK ((reaction = 'cant' AND length(trim(reason)) BETWEEN 1 AND 80)
          OR (reaction != 'cant' AND reason IS NULL)),
        PRIMARY KEY (message_id, actor_id)
      );
      CREATE INDEX IF NOT EXISTS comms_reactions_message ON comms_reactions(message_id);
      CREATE TABLE IF NOT EXISTS comms_settlements (
        message_id INTEGER PRIMARY KEY, settled_by TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comms_pins (
        message_id INTEGER PRIMARY KEY, pinned_by TEXT NOT NULL, pinned_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comms_inbox_reads (
        seat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
        PRIMARY KEY (seat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS comms_inbox_reads_message ON comms_inbox_reads(message_id);
      CREATE TRIGGER IF NOT EXISTS comms_reactions_valid_insert
      BEFORE INSERT ON comms_reactions
      WHEN (NEW.reaction = 'cant' AND (NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 1 AND 80))
        OR (NEW.reaction != 'cant' AND NEW.reason IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid Comms reaction reason'); END;
      CREATE TRIGGER IF NOT EXISTS comms_reactions_valid_update
      BEFORE UPDATE OF reaction, reason ON comms_reactions
      WHEN (NEW.reaction = 'cant' AND (NEW.reason IS NULL OR length(trim(NEW.reason)) NOT BETWEEN 1 AND 80))
        OR (NEW.reaction != 'cant' AND NEW.reason IS NOT NULL)
      BEGIN SELECT RAISE(ABORT, 'invalid Comms reaction reason'); END;
    `);
  }

  /** Adds the explicit `none` label to databases created before Comms recorded it. */
  private migrateCommsLabels(): void {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comms'")
      .get() as { sql?: string } | undefined;
    if (schema?.sql?.includes("'none'")) {
      if (this.db.prepare("SELECT 1 FROM comms WHERE label IS NULL LIMIT 1").get())
        this.db.prepare("UPDATE comms SET label = 'none' WHERE label IS NULL").run();
      return;
    }
    this.transaction(() => {
      this.db.exec(`
        ALTER TABLE comms RENAME TO comms_before_none_label;
        CREATE TABLE comms (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, from_id TEXT NOT NULL,
          to_id TEXT NOT NULL, ticket TEXT, text TEXT NOT NULL,
          label TEXT NOT NULL CHECK (label IN ('question','handoff','blocker','none')),
          ref TEXT, reply_to INTEGER, target_run_id TEXT, from_run_id TEXT, pr INTEGER,
          wake_failed_at INTEGER, delivered_at INTEGER, sender_kind TEXT, item_key TEXT
        );
        INSERT INTO comms (id, at, from_id, to_id, ticket, text, label, ref, reply_to,
          target_run_id, from_run_id, pr, wake_failed_at, delivered_at, sender_kind, item_key)
        SELECT id, at, from_id, to_id, ticket, text, COALESCE(label, 'none'), ref, reply_to,
          target_run_id, from_run_id, pr, wake_failed_at, delivered_at, sender_kind, item_key
        FROM comms_before_none_label;
        DROP TABLE comms_before_none_label;
        CREATE INDEX comms_at ON comms(at);
        CREATE INDEX comms_from_id ON comms(from_id, id);
        CREATE INDEX comms_to_id ON comms(to_id, id);
      `);
    }, true);
  }

  /** Runs `fn` in a transaction; `writeLock` takes the write lock first (BEGIN IMMEDIATE). */
  private transaction(fn: () => void, writeLock = false): void {
    this.db.exec(writeLock ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * A repo's rows in `table`, as one string (two reads are equal when no row changed). A pull
   * request's `read_at` is bookkeeping, not data: a re-read of the same answer is no change.
   */
  private repoRows(table: RepoTable, repoId: RepoId): string {
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE repo_id = ? ORDER BY ${REPO_TABLES[table]}`)
      .all(repoId)
      .map(({ read_at: _readAt, ...data }) => data);
    return JSON.stringify(rows);
  }

  /** Runs `write` in one transaction; true when it changed any of the repo's rows in `table`. */
  private changed(table: RepoTable, repoId: RepoId, write: () => void): boolean {
    let changed = false;
    this.transaction(() => {
      const before = this.repoRows(table, repoId);
      write();
      changed = this.repoRows(table, repoId) !== before;
    });
    return changed;
  }

  /** Ordered snapshots: later observations never rewrite an earlier attempt. */
  runAttempts(
    runId: string,
  ): { id: number; runId: string; kind: string; at: number; data: Record<string, unknown> }[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM run_attempts WHERE run_id = ? OR run_id IN (SELECT run_id FROM reviews WHERE author_run_id = ?) ORDER BY id",
        )
        .all(runId, runId) as Row[]
    ).map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      kind: r.kind as string,
      at: r.at as number,
      data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }

  /** The waste checks' queries and the alarms table (spend/waste.ts). */
  get waste(): ReturnType<typeof wasteQueries> {
    return wasteQueries(this.db);
  }

  /** A check call the hook refused as an unchanged rerun (same run, command and commit). */
  addRerunRefusal(runId: string, command: string, sha: string, at: number): void {
    this.appendAttempt(runId, RERUN_REFUSED_ATTEMPT, at, { command, sha, at });
  }

  /** A run resumed with the hub's "carry on" line (kind `resume`), counted by the retry-loop check. */
  addResumeAttempt(runId: string, at: number): void {
    this.appendAttempt(runId, RESUME_ATTEMPT, at, { at });
  }

  private appendAttempt(runId: string, kind: string, at: number, data: object): void {
    const encoded = JSON.stringify(data);
    const previous = this.db
      .prepare(
        "SELECT data, at FROM run_attempts WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
      )
      .get(runId, kind) as Row | undefined;
    // Wait completions are events: equal durations at different times are distinct waits.
    if (previous?.data === encoded && (kind !== "wait-end" || previous.at === at)) return;
    this.db
      .prepare("INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, ?, ?, ?)")
      .run(runId, kind, at, encoded);
  }

  /**
   * `folded`: the caller folded the run's transcript into `r`. The row is marked folded once that
   * happens to an ended run, and the mark is never cleared. A new row takes `r.loop`; an existing
   * row's loop is never rewritten here (`setRunLoop`).
   */
  upsertRun(r: Run, folded = false): void {
    this.appendAttempt(r.id, "run", r.endedAt ?? r.startedAt, {
      model: r.model,
      profile: r.profile ?? null,
      reviewId: r.reviewId ?? null,
      tokens: r.tokens,
      costUsd: r.costUsd,
      status: r.status,
    });
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, session_id,
           model, branch, ticket, cost_usd, tokens, transcript_path, prs, summary, folded, loop,
           ticket_title, review_id, cli_version, profile, profile_hash, plan, vendor, latest_plan,
           account_id, effort, prompt_hash, loop_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id, repo_id = excluded.repo_id, seq = excluded.seq,
           started_at = excluded.started_at, ended_at = excluded.ended_at, status = excluded.status,
           session_id = excluded.session_id, model = excluded.model, branch = excluded.branch,
           ticket = excluded.ticket, cost_usd = excluded.cost_usd, tokens = excluded.tokens,
           transcript_path = excluded.transcript_path, prs = excluded.prs,
           summary = excluded.summary, folded = MAX(folded, excluded.folded),
           ticket_title = COALESCE(excluded.ticket_title, ticket_title),
           cli_version = COALESCE(excluded.cli_version, cli_version),
           latest_plan = COALESCE(excluded.latest_plan, latest_plan),
           account_id = COALESCE(account_id, excluded.account_id),
           effort = COALESCE(effort, excluded.effort),
           prompt_hash = COALESCE(prompt_hash, excluded.prompt_hash),
           loop_kind = COALESCE(loop_kind, excluded.loop_kind)`,
      )
      .run(
        r.id,
        r.agentId,
        r.repoId,
        r.seq,
        r.startedAt,
        r.endedAt,
        r.status,
        r.sessionId,
        r.model,
        r.branch,
        r.ticket,
        r.costUsd,
        r.tokens === null ? null : JSON.stringify(r.tokens),
        r.transcriptPath,
        JSON.stringify(r.prs),
        r.summary,
        folded && r.endedAt !== null ? 1 : 0,
        r.loop === null || r.loop === undefined ? null : JSON.stringify(r.loop),
        r.ticketTitle ?? null,
        r.reviewId ?? null,
        r.cliVersion ?? null,
        r.profile ? JSON.stringify({ profile: r.profile.profile, route: r.profile.route }) : null,
        r.profile?.hash ?? null,
        r.plan === undefined ? null : JSON.stringify(r.plan),
        r.vendor ?? "claude",
        r.latestPlan ?? null,
        r.accountId ?? null,
        r.effort ?? null,
        r.promptHash ?? null,
        r.loopKind ?? null,
      );
  }

  /**
   * Gives runs stored before `loop_kind` existed the loop kind of their seat as configured now, so
   * a seat removed later still shows as a build seat in Audit. A run that has one keeps it.
   * Returns how many rows it set.
   */
  backfillRunLoopKinds(kinds: ReadonlyMap<string, LoopKind>): number {
    const set = this.db.prepare(
      "UPDATE runs SET loop_kind = ? WHERE agent_id = ? AND loop_kind IS NULL AND review_id IS NULL",
    );
    let n = 0;
    for (const [agentId, kind] of kinds) n += Number(set.run(kind, agentId).changes);
    return n;
  }

  /** A prepared first brief may be replaced at final delivery, only while its exact hash still matches. */
  setRunPromptVersion(
    runId: string,
    hash: string,
    path: string,
    at: number,
    preparedHash?: string,
  ): void {
    if (preparedHash === undefined) {
      this.db
        .prepare("UPDATE runs SET prompt_hash = COALESCE(prompt_hash, ?) WHERE id = ?")
        .run(hash, runId);
    } else {
      const changed = this.db
        .prepare(
          `UPDATE runs SET prompt_hash = ? WHERE id = ? AND prompt_hash = ?
           AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ?)`,
        )
        .run(hash, runId, preparedHash, `instruction.delivered:${runId}`);
      if (changed.changes !== 1)
        throw new Error("Prepared prompt identity changed before delivery");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO prompt_versions (hash, path, first_seen) VALUES (?, ?, ?)")
      .run(hash, path, at);
  }

  /** What one prompt took, by section; a wake recorded twice keeps its first rows. */
  recordPromptSections(
    runId: string,
    wake: number,
    at: number,
    sections: readonly PromptSectionCost[],
  ): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO prompt_sections (run_id, wake, section, bytes, tokens, at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const s of sections) insert.run(runId, wake, s.section, s.bytes, s.tokens, at);
  }

  /** Records one finished mc tool call. */
  recordToolCall(c: {
    at: number;
    runId: string;
    tool: string;
    written: number;
    returned: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO mcp_tool_calls (at, run_id, tool, written, returned) VALUES (?, ?, ?, ?, ?)",
      )
      .run(c.at, c.runId, c.tool, c.written, c.returned);
  }

  /** Calls and characters (sent plus returned) per mc tool, for calls made in `[from, to]`. */
  toolUsage(from: number, to: number): Map<string, { calls: number; chars: number }> {
    return new Map(
      (
        this.db
          .prepare(
            `SELECT tool, COUNT(*) AS calls, SUM(written + returned) AS chars FROM mcp_tool_calls
             WHERE at >= ? AND at <= ? GROUP BY tool`,
          )
          .all(from, to) as { tool: string; calls: number; chars: number }[]
      ).map((r) => [r.tool, { calls: r.calls, chars: r.chars }]),
    );
  }

  /** Stores a run's token audit and its calls; a run audited twice keeps the later read. */
  saveRunTokenAudit(
    runId: string,
    at: number,
    audit: RunTokenAudit,
    calls: readonly TokenCall[],
  ): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM run_token_calls WHERE run_id = ?").run(runId);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO run_token_audit (run_id, at, calls, peak_context, median_context,
             cache_read, cache_write, output, rewrites, rewrite_tokens, read_after_report,
             by_source, by_command, timestamps_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          runId,
          at,
          audit.calls,
          audit.peakContext,
          audit.medianContext,
          audit.cacheRead,
          audit.cacheWrite,
          audit.output,
          audit.rewrites,
          audit.rewriteTokens,
          audit.readAfterReport,
          JSON.stringify(audit.bySource),
          JSON.stringify(audit.byCommand),
        );
      const insert = this.db.prepare(
        `INSERT INTO run_token_calls (run_id, idx, context, cache_read, cache_write, output, added, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [i, c] of calls.entries()) {
        insert.run(
          runId,
          i,
          c.context,
          c.cacheRead,
          c.cacheWrite,
          c.output,
          JSON.stringify(c.added),
          c.at ?? null,
        );
      }
    });
  }

  /** A run's stored calls, in order. */
  runTokenCalls(runId: string): TokenCall[] {
    return (
      this.db
        .prepare("SELECT * FROM run_token_calls WHERE run_id = ? ORDER BY idx")
        .all(runId) as Row[]
    ).map(toTokenCall);
  }

  /** Audited runs with calls whose call times were never looked for, oldest first (the back-fill). */
  runsToRetimeTokens(limit: number): Run[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM run_token_audit a JOIN runs r ON r.id = a.run_id
           WHERE a.timestamps_checked = 0 AND a.calls > 0 ORDER BY r.started_at DESC, r.seq DESC LIMIT ?`,
        )
        .all(limit) as Row[]
    ).map(toRun);
  }

  /** Records that a run's transcript could not give call times, so it is not tried again. */
  markTokenTimesChecked(runId: string): void {
    this.db
      .prepare("UPDATE run_token_audit SET timestamps_checked = 1 WHERE run_id = ?")
      .run(runId);
  }

  /**
   * Every stored call of each run that made a call in `(from, to]`, in order, so a window can read
   * the calls before it (the context a call grew from) and after it (what re-read an addition).
   */
  tokenCallsOfRunsActiveIn(from: number, to: number): { run: Run; calls: TokenCall[] }[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, c.context AS c_context, c.cache_read AS c_cache_read, c.cache_write AS c_cache_write,
           c.output AS c_output, c.added AS c_added, c.at AS c_at
         FROM run_token_calls c JOIN runs r ON r.id = c.run_id
         WHERE c.run_id IN (SELECT run_id FROM run_token_calls WHERE at > ? AND at <= ?)
         ORDER BY r.started_at DESC, r.seq DESC, c.run_id, c.idx`,
      )
      .all(from, to) as Row[];
    const out: { run: Run; calls: TokenCall[] }[] = [];
    for (const r of rows) {
      let last = out.at(-1);
      if (last === undefined || last.run.id !== (r.id as string)) {
        last = { run: toRun(r), calls: [] };
        out.push(last);
      }
      last.calls.push({
        at: (r.c_at as number | null) ?? null,
        context: r.c_context as number,
        cacheRead: r.c_cache_read as number,
        cacheWrite: r.c_cache_write as number,
        output: r.c_output as number,
        added: JSON.parse(r.c_added as string) as TokenSourceAdd[],
      });
    }
    return out;
  }

  /**
   * For each run overlapping `[from, to]`: whether its token audit is stored, whether it has calls,
   * and whether any call has no time. What an event window can and cannot say.
   */
  tokenAuditStates(
    from: number,
    to: number,
  ): { runId: string; stored: boolean; calls: number; untimed: boolean }[] {
    const ids = this.overlappingRuns("id", from, to + 1).map((r) => r.id as string);
    const state = this.db.prepare(
      `SELECT a.calls AS calls, (SELECT COUNT(*) FROM run_token_calls c WHERE c.run_id = ? AND c.at IS NULL) AS untimed
       FROM run_token_audit a WHERE a.run_id = ?`,
    );
    return ids.map((runId) => {
      const row = state.get(runId, runId) as { calls: number; untimed: number } | undefined;
      return {
        runId,
        stored: row !== undefined,
        calls: row?.calls ?? 0,
        untimed: (row?.untimed ?? 0) > 0,
      };
    });
  }

  /** Ended runs started since `since` with no token audit yet, newest first. */
  runsToAuditTokens(since: number, limit: number): Run[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE ended_at IS NOT NULL AND started_at >= ?
             AND id NOT IN (SELECT run_id FROM run_token_audit)
           ORDER BY started_at DESC, seq DESC LIMIT ?`,
        )
        .all(since, limit) as Row[]
    ).map(toRun);
  }

  /** The stored token audits of runs that started since `since`, with the run each belongs to. */
  runTokenAudits(since: number): { run: Run; audit: RunTokenAudit }[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, a.calls AS a_calls, a.peak_context AS a_peak, a.median_context AS a_median,
           a.cache_read AS a_cache_read, a.cache_write AS a_cache_write, a.output AS a_output,
           a.rewrites AS a_rewrites, a.rewrite_tokens AS a_rewrite_tokens,
           a.read_after_report AS a_after, a.by_source AS a_by_source, a.by_command AS a_by_command
         FROM run_token_audit a JOIN runs r ON r.id = a.run_id
         WHERE r.started_at >= ? AND a.calls > 0 ORDER BY r.started_at DESC, r.seq DESC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      run: toRun(r),
      audit: {
        calls: r.a_calls as number,
        peakContext: r.a_peak as number,
        medianContext: r.a_median as number,
        cacheRead: r.a_cache_read as number,
        cacheWrite: r.a_cache_write as number,
        output: r.a_output as number,
        rewrites: r.a_rewrites as number,
        rewriteTokens: r.a_rewrite_tokens as number,
        readAfterReport: r.a_after as number | null,
        bySource: JSON.parse(r.a_by_source as string) as Record<string, TokenCounts>,
        byCommand: JSON.parse(r.a_by_command as string) as Record<string, TokenCounts>,
      },
    }));
  }

  /** Context size of every stored model call of runs that started since `since`. */
  runCallContexts(since: number): { runId: string; context: number }[] {
    return this.db
      .prepare(
        `SELECT c.run_id AS runId, c.context AS context FROM run_token_calls c
         JOIN runs r ON r.id = c.run_id WHERE r.started_at >= ?`,
      )
      .all(since) as { runId: string; context: number }[];
  }

  /** Review runs that started since `since` on a ticket, oldest first. */
  reviewRunsSince(since: number): Run[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE review_id IS NOT NULL AND ticket IS NOT NULL AND started_at >= ?
           ORDER BY started_at, seq`,
        )
        .all(since) as Row[]
    ).map(toRun);
  }

  /** PRs merged in `[from, to]`, and every run on a ticket one of them closed. */
  mergedTicketRuns(from: number, to: number): { mergedPrs: number; runs: Run[] } {
    const merged = this.db
      .prepare("SELECT COUNT(*) AS n FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .get(from, to) as { n: number };
    const runs = (
      this.db
        .prepare(
          `WITH merged_tickets AS (
             SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
             WHERE merged_at >= ? AND merged_at <= ?
           ) SELECT r.* FROM runs r JOIN merged_tickets t ON r.repo_id = t.repo_id AND r.ticket = t.ticket
           ORDER BY r.started_at, r.seq`,
        )
        .all(from, to) as Row[]
    ).map(toRun);
    return { mergedPrs: merged.n, runs };
  }

  /** For each prompt section recorded since `since`, the run that sent the most of it. */
  promptSectionTopRuns(since: number): {
    section: PromptSection;
    runId: string;
    agentId: string;
    ticket: string | null;
    tokens: number;
  }[] {
    return this.db
      .prepare(
        `SELECT section, runId, agentId, ticket, tokens FROM (
           SELECT p.section AS section, p.run_id AS runId, r.agent_id AS agentId, r.ticket AS ticket,
             SUM(p.tokens) AS tokens,
             ROW_NUMBER() OVER (PARTITION BY p.section ORDER BY SUM(p.tokens) DESC, p.run_id) AS n
           FROM prompt_sections p JOIN runs r ON r.id = p.run_id WHERE p.at >= ?
           GROUP BY p.section, p.run_id)
         WHERE n = 1`,
      )
      .all(since) as never;
  }

  /** Prompt-section tokens by section for prompts recorded since `since`. */
  promptSectionTotals(since: number): { section: PromptSection; tokens: number }[] {
    return this.db
      .prepare(
        "SELECT section, SUM(tokens) AS tokens FROM prompt_sections WHERE at >= ? GROUP BY section",
      )
      .all(since) as { section: PromptSection; tokens: number }[];
  }

  /**
   * Stores controller messages' usage numbers (never text). A message id seen again, in a resumed
   * session's copy of its history or a subagent file, counts once; the larger output is kept.
   */
  saveControllerMessages(
    sessionId: string,
    messages: readonly {
      id: string;
      at: number;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
    }[],
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO controller_messages (message_id, session_id, at, input, cache_read, cache_write, output)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET output = MAX(output, excluded.output)`,
    );
    this.transaction(() => {
      for (const m of messages) {
        insert.run(m.id, sessionId, m.at, m.input, m.cacheRead, m.cacheWrite, m.output);
      }
    });
  }

  /** Controller usage by message time since `since`: distinct sessions, distinct messages and token sums. */
  controllerUsageSince(since: number): {
    sessions: number;
    calls: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  } {
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS calls,
           COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cache_read), 0) AS cacheRead,
           COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(output), 0) AS output
         FROM controller_messages WHERE at >= ?`,
      )
      .get(since) as never;
  }

  /** The mtime a controller file was last read at, or null when it has not been read. */
  controllerFileMtime(path: string): number | null {
    const r = this.db.prepare("SELECT mtime FROM controller_files WHERE path = ?").get(path) as
      | { mtime: number }
      | undefined;
    return r?.mtime ?? null;
  }

  markControllerFile(path: string, mtime: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO controller_files (path, mtime) VALUES (?, ?)")
      .run(path, mtime);
  }

  /** Adds tool-result bytes to the run's latest wake (wake 0 when none is recorded). */
  addToolResultBytes(runId: string, bytes: number, at: number): void {
    const last = this.db
      .prepare(
        `SELECT wake, MIN(at) AS at FROM prompt_sections WHERE run_id = ?
         AND wake = (SELECT MAX(wake) FROM prompt_sections WHERE run_id = ?)`,
      )
      .get(runId, runId) as { wake: number | null; at: number | null };
    const wake = last.wake ?? 0;
    const section: PromptSection = "tool_results";
    this.db
      .prepare(
        `INSERT INTO prompt_sections (run_id, wake, section, bytes, tokens, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, wake, section) DO UPDATE SET bytes = bytes + excluded.bytes,
           tokens = CAST(ROUND((bytes + excluded.bytes) / ${PROMPT_BYTES_PER_TOKEN}.0) AS INTEGER)`,
      )
      .run(runId, wake, section, bytes, estimateTokens(bytes), last.at ?? at);
  }

  private wakesOf(
    rows: {
      run_id: string;
      wake: number;
      section: PromptSection;
      bytes: number;
      tokens: number;
      at: number;
    }[],
  ): PromptWakeCost[] {
    const wakes = new Map<string, PromptWakeCost>();
    for (const r of rows) {
      const key = `${r.run_id}\0${r.wake}`;
      let w = wakes.get(key);
      if (w === undefined) {
        w = { runId: r.run_id, wake: r.wake, at: r.at, sections: [] };
        wakes.set(key, w);
      }
      w.at = Math.min(w.at, r.at);
      w.sections.push({ section: r.section, bytes: r.bytes, tokens: r.tokens });
    }
    for (const w of wakes.values()) {
      w.sections.sort(
        (a, b) => PROMPT_SECTIONS.indexOf(a.section) - PROMPT_SECTIONS.indexOf(b.section),
      );
    }
    return [...wakes.values()];
  }

  /** A run's prompts by section, oldest first. */
  promptWakes(runId: string): PromptWakeCost[] {
    return this.wakesOf(
      this.db
        .prepare("SELECT * FROM prompt_sections WHERE run_id = ? ORDER BY wake")
        .all(runId) as never,
    );
  }

  /** Only the latest prompt for the Agent summary; history stays on demand. */
  latestPromptWake(runId: string): PromptWakeCost | null {
    const rows = this.db
      .prepare(`SELECT * FROM prompt_sections WHERE run_id = ?
      AND wake = (SELECT MAX(wake) FROM prompt_sections WHERE run_id = ?)`)
      .all(runId, runId);
    return this.wakesOf(rows as never)[0] ?? null;
  }

  /** An agent's prompts since `since`, newest first, at most `limit` wakes. */
  agentPromptWakes(agentId: string, since: number, limit: number): PromptWakeCost[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM prompt_sections p JOIN runs r ON r.id = p.run_id
         WHERE r.agent_id = ? AND p.at >= ?`,
      )
      .all(agentId, since) as never;
    return this.wakesOf(rows)
      .sort((a, b) => b.at - a.at || b.wake - a.wake)
      .slice(0, limit);
  }

  /** Records a running Codex CLI's version without allowing a stale launch to revive its run. */
  setRunCliVersionIfLive(runId: string, cliVersion: string): boolean {
    return (
      this.db
        .prepare("UPDATE runs SET cli_version = ? WHERE id = ? AND ended_at IS NULL")
        .run(cliVersion, runId).changes === 1
    );
  }

  /** Records the template profile chosen for a ticket; a later choice replaces it. */
  setProfileOverride(repoId: RepoId, issue: number, o: ProfileOverride, at: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO profile_overrides (repo_id, issue, profile, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(repoId, issue, o.profile, o.reason, o.by, at);
  }

  profileOverride(repoId: RepoId, issue: number): ProfileOverride | null {
    const r = this.db
      .prepare("SELECT profile, reason, by FROM profile_overrides WHERE repo_id = ? AND issue = ?")
      .get(repoId, issue) as Row | undefined;
    return r
      ? {
          profile: r.profile as string,
          reason: r.reason as string,
          by: r.by as ProfileOverride["by"],
        }
      : null;
  }

  run(id: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : null;
  }

  runs(agentId: AgentId, limit: number): Run[] {
    const rows = this.statement(
      "SELECT * FROM runs WHERE agent_id = ? ORDER BY started_at DESC, seq DESC LIMIT ?",
    ).all(agentId, limit) as Row[];
    return rows.map(toRun);
  }

  /** Indexed recent-run bounds for each HUD agent, with older held runs retained. */
  runsForAgents(
    agentIds: readonly AgentId[],
    limit: number,
    heldRunIds: readonly string[] = [],
  ): Map<AgentId, Run[]> {
    const out = new Map<AgentId, Run[]>();
    if (agentIds.length === 0) return out;
    for (const agentId of agentIds) out.set(agentId, []);
    const seen = new Set<string>();
    const take = (row: Row) => {
      if (seen.has(row.id as string)) return;
      seen.add(row.id as string);
      const run = toRun(row);
      const runs = out.get(run.agentId) ?? [];
      runs.push(run);
      out.set(run.agentId, runs);
    };
    const recent = this.statement(`SELECT * FROM runs WHERE agent_id = ?
      ORDER BY started_at DESC, seq DESC
      LIMIT CASE WHEN ? > 0 THEN CAST(? AS INTEGER) ELSE 0 END`);
    for (const agentId of out.keys()) {
      for (const row of recent.all(agentId, limit, limit) as Row[]) take(row);
    }
    const held = [...new Set(heldRunIds)];
    if (held.length > 0)
      for (const row of this.statement(
        `SELECT * FROM runs WHERE id IN (${held.map(() => "?").join(", ")})
        ORDER BY agent_id, started_at DESC, seq DESC`,
      ).all(...held) as Row[])
        take(row);
    for (const runs of out.values())
      runs.sort((a, b) => b.startedAt - a.startedAt || b.seq - a.seq);
    return out;
  }

  /** Set-aside runs retain their unmerged map scope after a seat takes another ticket. */
  mapAsideRuns(agentId: AgentId): Run[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM runs WHERE agent_id = ? AND json_extract(loop, '$.aside.worktree') > ''",
        )
        .all(agentId) as Row[]
    ).map(toRun);
  }

  /** The branches this hub's own work runs (not review runs) worked on in a repo, ended or not. */
  runBranches(repoId: RepoId): Set<string> {
    const rows = this.statement(
      "SELECT DISTINCT branch FROM runs WHERE repo_id = ? AND review_id IS NULL AND branch IS NOT NULL",
    ).all(repoId) as { branch: string }[];
    return new Set(rows.map((r) => r.branch));
  }

  /** Runs still open or ended at or after `since`, across seats and repos. */
  runsActiveSince(since: number): Run[] {
    const rows = this.db
      .prepare(`SELECT * FROM (
        SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at IS NULL
        UNION ALL
        SELECT * FROM runs INDEXED BY runs_ended_started WHERE ended_at >= ?
      ) ORDER BY started_at, seq`)
      .all(since) as Row[];
    return rows.map(toRun);
  }

  /** Complete author bindings for flow reads, plus active runs needed for seat queue order. */
  prFlowRuns(
    repoId: RepoId,
    prs: readonly Pick<PullRequestView, "number" | "branch" | "ticket">[],
  ): Run[] {
    const numbers = JSON.stringify(prs.map((p) => p.number));
    return (
      this.statement(`SELECT * FROM runs WHERE repo_id = ? AND review_id IS NULL AND (
      ended_at IS NULL OR branch IN (SELECT json_extract(value, '$.branch') FROM json_each(?))
      OR ticket IN (SELECT json_extract(value, '$.ticket') FROM json_each(?))
      OR json_extract(loop, '$.prNumber') IN (SELECT value FROM json_each(?))
      OR EXISTS (SELECT 1 FROM json_each(prs) p WHERE json_extract(p.value, '$.number') IN (SELECT value FROM json_each(?)))
    ) ORDER BY started_at, seq`).all(
        repoId,
        JSON.stringify(prs),
        JSON.stringify(prs),
        numbers,
        numbers,
      ) as Row[]
    ).map(toRun);
  }

  /** Every recorded run on a branch; review ordering needs merged predecessors too. */
  runsOnBranch(repoId: RepoId, branch: string): Run[] {
    return (
      this.db
        .prepare("SELECT * FROM runs WHERE repo_id = ? AND branch = ? ORDER BY started_at, seq")
        .all(repoId, branch) as Row[]
    ).map(toRun);
  }

  /**
   * The merge hold on the branch's latest build run, ended or not. A hold outlives its run until
   * someone releases it. A follow-on run gets a copy (run/handoffs.ts), so only the latest one counts.
   */
  branchMergeHold(repoId: RepoId, branch: string): NonNullable<Run["loop"]>["mergeHold"] | null {
    const latest = this.runsOnBranch(repoId, branch).findLast((run) => run.reviewId == null);
    return latest?.loop?.mergeHold ?? null;
  }

  /**
   * Distinct tickets that a run by one of `seatIds` first started on since `since`. Review runs,
   * observed loops' runs and tickets already started before `since` (then handed on) do not count.
   */
  ticketsStartedSince(since: number, seatIds: readonly string[]): number {
    if (seatIds.length === 0) return 0;
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT r.ticket) AS n FROM runs r
         WHERE r.started_at >= ? AND r.ticket IS NOT NULL AND r.review_id IS NULL
           AND r.agent_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (
             SELECT 1 FROM runs p
             WHERE p.ticket = r.ticket AND p.review_id IS NULL AND p.started_at < ?
           )`,
      )
      .get(since, JSON.stringify(seatIds), since) as { n: number };
    return row.n;
  }

  /** Outstanding runs and ended runs with recorded PR merge steps for the away digest. */
  runsForAwayDigest(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM runs WHERE ended_at IS NULL
           UNION ALL
           SELECT * FROM runs INDEXED BY runs_merging_started
             WHERE json_extract(loop, '$.merging') > '' AND ended_at IS NOT NULL
         ) ORDER BY started_at, seq`,
      )
      .all() as Row[];
    return rows.map(toRun);
  }

  /**
   * The run the HUD shows for an agent: the one its seat holds when that is set and not ended
   * (a run woken from aside can be older than a run that ended meanwhile), else the newest.
   */
  seatRun(agentId: AgentId): Run | undefined {
    const heldId = this.seatSession(agentId)?.runId ?? null;
    if (heldId !== null) {
      const held = this.run(heldId);
      if (held !== null && held.endedAt === null && held.agentId === agentId) return held;
    }
    return this.runs(agentId, 1)[0];
  }

  /**
   * The runs a loop drives that may still need the engine: every one not yet ended, and those
   * that ended at or after `endedSince` with a loop that is not done, or is done with merge steps
   * recorded (the last of them may be owed). Oldest first.
   */
  loopRuns(endedSince: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM runs WHERE loop IS NOT NULL AND ended_at IS NULL
           UNION ALL
           SELECT * FROM runs INDEXED BY runs_ended_started WHERE loop IS NOT NULL AND ended_at >= ?
             AND (json_extract(loop, '$.phase') != 'done'
               OR json_extract(loop, '$.merging') > '')
         ) ORDER BY started_at, seq`,
      )
      .all(endedSince) as Row[];
    return rows.map(toRun);
  }

  /** Live acceptance metadata never needs to decode ended loop history. */
  activeLoopRuns(repoId: RepoId): Run[] {
    const rows = this.statement(
      "SELECT * FROM runs WHERE repo_id = ? AND ended_at IS NULL AND loop IS NOT NULL ORDER BY started_at, seq",
    ).all(repoId) as Row[];
    return rows.map(toRun);
  }

  /** The runs that have not ended and are off their seat in review, oldest first. */
  asideRuns(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ended_at IS NULL AND loop IS NOT NULL
           AND json_extract(loop, '$.aside') IS NOT NULL
         ORDER BY started_at, seq`,
      )
      .all() as Row[];
    return rows.map(toRun);
  }

  /** The tickets (`repo#n`) of the runs that have not ended. */
  activeTickets(): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT ticket FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND review_id IS NULL",
      )
      .all() as Row[];
    return new Set(rows.map((r) => r.ticket as string));
  }

  /**
   * True while crew work stands at the machine guard or has just passed it: a queued ticket, a
   * queued review, or a ticket run (a review's included) that has not ended and is not set aside.
   */
  hasPendingStart(): boolean {
    const found = (sql: string, ...params: string[]): boolean =>
      this.db.prepare(sql).get(...params) !== undefined;
    return (
      found("SELECT 1 FROM queues WHERE taken_at IS NULL LIMIT 1") ||
      found("SELECT 1 FROM reviews WHERE state = ? LIMIT 1", "queued") ||
      found(
        "SELECT 1 FROM runs WHERE ended_at IS NULL AND ticket IS NOT NULL AND (loop IS NULL OR json_extract(loop, '$.aside') IS NULL) LIMIT 1",
      )
    );
  }

  /** True while a run has not ended and is not set aside (waiting on a review, CI or a merge). */
  /**
   * True when one of these agents has an open run that is not set aside and started at or after
   * `since`: a run left open for longer is a dead row, not work in progress.
   */
  hasActiveRunOf(agentIds: readonly string[], since: number): boolean {
    if (agentIds.length === 0) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE ended_at IS NULL AND started_at >= ? AND agent_id IN (${agentIds.map(() => "?").join(",")})
             AND (loop IS NULL OR json_extract(loop, '$.aside') IS NULL) LIMIT 1`,
        )
        .get(since, ...agentIds) !== undefined
    );
  }

  hasActiveRun(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE ended_at IS NULL AND (loop IS NULL OR json_extract(loop, '$.aside') IS NULL) LIMIT 1",
        )
        .get() !== undefined
    );
  }

  /**
   * The newest run (ended or not, not a review) on `branch`, which owns that branch's ticket:
   * `agentId`'s own run first, any seat's otherwise.
   */
  latestRunOnBranch(repoId: RepoId, branch: string, agentId?: AgentId): Run | null {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL
         ORDER BY (agent_id = ?) DESC, started_at DESC, id DESC LIMIT 1`,
      )
      .get(repoId, branch, agentId ?? "") as Row | undefined;
    return row ? toRun(row) : null;
  }

  /** Whether this hub has a run (ended or not) on `branch`. */
  hasRunOnBranch(repoId: RepoId, branch: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE repo_id = ? AND branch = ? AND review_id IS NULL LIMIT 1",
        )
        .get(repoId, branch) !== undefined
    );
  }

  /** Every run on the ticket, ended ones too; review runs do not count. */
  runsOnTicket(repoId: RepoId, ticket: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE repo_id = ? AND ticket = ? AND review_id IS NULL")
      .all(repoId, ticket) as Row[];
    return rows.map(toRun);
  }

  /** Whether a run is still going on the ticket (`repo#number`); a review run does not count. */
  hasLiveRunOnTicket(repoId: RepoId, ticket: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND status = 'running'
             AND ended_at IS NULL AND review_id IS NULL LIMIT 1`,
        )
        .get(repoId, ticket) !== undefined
    );
  }

  /** Whether another run on the same ticket started after this one. */
  hasNewerRunOnTicket(run: Run): boolean {
    if (run.ticket === null) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM runs WHERE repo_id = ? AND ticket = ? AND started_at > ? AND id != ?
             AND review_id IS NULL`,
        )
        .get(run.repoId, run.ticket, run.startedAt, run.id) !== undefined
    );
  }

  /**
   * Every agent's runs that overlap [sinceMs, untilMs): started before `untilMs` and ended after
   * `sinceMs`, or with no end. A run with no end counts as lasting until now only while `running`,
   * and only when it started within MAX_OPEN_RUN_AGE_MS of `untilMs` (older ones are abandoned
   * rows; a run left `running` for longer than that also drops out of `pruneFoldState`'s keep-set);
   * otherwise (`unknown`) it lasts an instant and overlaps only if it started at or after
   * `sinceMs`. Newest first.
   */
  runsOverlapping(sinceMs: number, untilMs: number): Run[] {
    return this.overlappingRuns("*", sinceMs, untilMs).map(toRun);
  }

  private overlappingRuns(columns: string, sinceMs: number, untilMs: number): Row[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM runs WHERE started_at < ?
           AND (ended_at > ?
             OR (ended_at IS NULL AND status = ? AND started_at > ?)
             OR (ended_at IS NULL AND started_at >= ?))
         ORDER BY started_at DESC, seq DESC`,
      )
      .all(
        untilMs,
        sinceMs,
        "running" satisfies RunStatus,
        untilMs - MAX_OPEN_RUN_AGE_MS,
        sinceMs,
      ) as Row[];
  }

  /**
   * The run and attempt-usage fields FLIGHT's cost and wait figures read, for `agentIds`' runs
   * overlapping [since, until) (same rule and order as `runsOverlapping`). Reads only the scalar
   * columns and each digest's usage timestamps and tokens, never the whole digest or run row.
   */
  financialRuns(sinceMs: number, untilMs: number, agentIds: ReadonlySet<string>): FinancialRun[] {
    const runs = this.overlappingRuns(
      "id, agent_id, started_at, ended_at, status, cost_usd",
      sinceMs,
      untilMs,
    )
      .filter((r) => agentIds.has(r.agent_id as string))
      .map(
        (r): FinancialRun => ({
          id: r.id as string,
          agentId: r.agent_id as string,
          startedAt: r.started_at as number,
          endedAt: r.ended_at as number | null,
          status: r.status as Run["status"],
          costUsd: r.cost_usd as number | null,
          attemptUsage: [],
        }),
      );
    const byId = new Map(runs.map((r) => [r.id, r]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += DIGEST_BATCH) {
      const batch = ids.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, json_extract(digest, '$.attemptUsage') AS usage
         FROM run_digests WHERE run_id IN (${batch.map(() => "?").join(", ")})`,
      ).all(...batch) as { run_id: string; usage: string | null }[];
      for (const r of rows) {
        if (r.usage === null) continue;
        const run = byId.get(r.run_id);
        if (run === undefined) continue;
        for (const u of JSON.parse(r.usage) as { at: number | null; tokens: number }[])
          run.attemptUsage.push({ at: u.at, tokens: u.tokens });
      }
    }
    return runs;
  }

  /**
   * Ended runs started before `startedBefore` whose transcript has not been folded, newest first
   * (the backfill's queue).
   */
  runsToFold(limit: number, startedBefore: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?
         ORDER BY started_at DESC, seq DESC LIMIT ?`,
      )
      .all(startedBefore, limit) as Row[];
    return rows.map(toRun);
  }

  /**
   * Ended runs of `agentIds`, newest first, strictly after `after` in that order (null: from the
   * newest); the summary rewrite's queue. Ordered by start, then id.
   */
  endedRunsPage(
    agentIds: string[],
    after: { startedAt: number; id: string } | null,
    limit: number,
  ): Run[] {
    if (agentIds.length === 0) return [];
    const agents = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ended_at IS NOT NULL AND agent_id IN (${agents})
           AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?))
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...agentIds,
        after === null ? null : 1,
        after?.startedAt ?? 0,
        after?.startedAt ?? 0,
        after?.id ?? "",
        limit,
      ) as Row[];
    return rows.map(toRun);
  }

  /**
   * Runs of `agentIds` with a ticket and no stored title, newest first, strictly after `after` in
   * that order (null: from the newest); the title fill's queue.
   */
  untitledRunsPage(
    agentIds: string[],
    after: { startedAt: number; id: string } | null,
    limit: number,
  ): Run[] {
    if (agentIds.length === 0) return [];
    const agents = agentIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE ticket IS NOT NULL AND ticket_title IS NULL
           AND agent_id IN (${agents})
           AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?))
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...agentIds,
        after === null ? null : 1,
        after?.startedAt ?? 0,
        after?.startedAt ?? 0,
        after?.id ?? "",
        limit,
      ) as Row[];
    return rows.map(toRun);
  }

  /** Sets the title of every run of `ticket` in `repoId` that has none; returns how many it set. */
  setTicketTitle(repoId: string, ticket: string, title: string): number {
    const r = this.db
      .prepare(
        "UPDATE runs SET ticket_title = ? WHERE repo_id = ? AND ticket = ? AND ticket_title IS NULL",
      )
      .run(title, repoId, ticket);
    return Number(r.changes);
  }

  /** Rewrites only a run's summary (nothing else on its row). */
  setRunSummary(runId: string, summary: string): void {
    this.db.prepare("UPDATE runs SET summary = ? WHERE id = ?").run(summary, runId);
  }

  /** How many runs `runsToFold` has left before `startedBefore`. */
  countToFold(startedBefore: number): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE folded = 0 AND ended_at IS NOT NULL AND started_at < ?",
      )
      .get(startedBefore) as { n: number };
    return row.n;
  }

  setDigest(runId: string, d: RunDigest): void {
    this.db
      .prepare(
        `INSERT INTO run_digests (run_id, digest) VALUES (?, ?)
         ON CONFLICT(run_id) DO UPDATE SET digest = excluded.digest`,
      )
      .run(runId, JSON.stringify(d));
  }

  mapCacheGet(kind: string, scope: string, key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM map_cache WHERE kind = ? AND scope = ? AND key = ?")
      .get(kind, scope, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Stores a map cache row; `exclusive` drops the kind and scope's other rows (superseded keys). */
  mapCachePut(kind: string, scope: string, key: string, value: string, exclusive: boolean): void {
    this.transaction(() => {
      if (exclusive)
        this.db
          .prepare("DELETE FROM map_cache WHERE kind = ? AND scope = ? AND key <> ?")
          .run(kind, scope, key);
      this.db
        .prepare(
          `INSERT INTO map_cache (kind, scope, key, value) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, scope, key) DO UPDATE SET value = excluded.value`,
        )
        .run(kind, scope, key, value);
    });
  }

  digest(runId: string): RunDigest | null {
    const row = this.db.prepare("SELECT digest FROM run_digests WHERE run_id = ?").get(runId) as
      | { digest: string }
      | undefined;
    if (!row) return null;
    return this.withRereads(parseDigest(row.digest), this.rereads([runId]).get(runId));
  }

  private withRereads(d: RunDigest, r: RunDigest["rereads"]): RunDigest {
    return r ? { ...d, rereads: r } : d;
  }

  /** Refused re-reads per run (those with any): how many, and the tokens they are estimated to have saved. */
  private rereads(runIds: string[]): Map<string, NonNullable<RunDigest["rereads"]>> {
    const out = new Map<string, NonNullable<RunDigest["rereads"]>>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, count, tokens_saved FROM run_rereads WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
      ).all(...ids) as { run_id: string; count: number; tokens_saved: number }[];
      for (const r of rows) out.set(r.run_id, { count: r.count, tokensSaved: r.tokens_saved });
    }
    return out;
  }

  /** The run's earlier whole read of `path` by `agentId` ('' is the seat), if it made one. */
  runRead(runId: string, agentId: string, path: string): ReadRecord | undefined {
    const r = this.db
      .prepare(
        "SELECT size, mtime_ms, compactions, tool_use_id, at FROM run_reads WHERE run_id = ? AND agent_id = ? AND path = ?",
      )
      .get(runId, agentId, path) as
      | { size: number; mtime_ms: number; compactions: number; tool_use_id: string; at: number }
      | undefined;
    return (
      r && {
        size: r.size,
        mtimeMs: r.mtime_ms,
        compactions: r.compactions,
        toolUseId: r.tool_use_id,
        at: r.at,
      }
    );
  }

  /** Remembers the run's whole read of `path`, replacing an earlier one. */
  setRunRead(runId: string, agentId: string, path: string, r: ReadRecord): void {
    this.db
      .prepare(
        `INSERT INTO run_reads (run_id, agent_id, path, size, mtime_ms, compactions, tool_use_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, agent_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           compactions = excluded.compactions, tool_use_id = excluded.tool_use_id, at = excluded.at`,
      )
      .run(runId, agentId, path, r.size, r.mtimeMs, r.compactions, r.toolUseId, r.at);
  }

  /** Forgets the whole read made by tool call `toolUseId`, as when that call failed. */
  forgetRunRead(runId: string, toolUseId: string): void {
    this.db
      .prepare("DELETE FROM run_reads WHERE run_id = ? AND tool_use_id = ?")
      .run(runId, toolUseId);
  }

  /** Counts one refused re-read that saved about `tokens`. */
  addReread(runId: string, tokens: number): void {
    this.db
      .prepare(
        `INSERT INTO run_rereads (run_id, count, tokens_saved) VALUES (?, 1, ?)
         ON CONFLICT(run_id) DO UPDATE SET count = count + 1, tokens_saved = tokens_saved + excluded.tokens_saved`,
      )
      .run(runId, tokens);
  }

  digests(runIds: string[]): Map<string, RunDigest> {
    const out = new Map<string, RunDigest>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(
        `SELECT run_id, digest FROM run_digests WHERE run_id IN (${ids.map(() => "?").join(", ")})`,
      ).all(...ids) as { run_id: string; digest: string }[];
      for (const r of rows) out.set(r.run_id, parseDigest(r.digest));
    }
    for (const [id, r] of this.rereads(runIds)) {
      const d = out.get(id);
      if (d) out.set(id, this.withRereads(d, r));
    }
    return out;
  }

  /** Historical window provenance for crew rows, without decoding old event and token arrays. */
  digestContextWindows(runIds: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (let i = 0; i < runIds.length; i += DIGEST_BATCH) {
      const ids = runIds.slice(i, i + DIGEST_BATCH);
      const rows = this.statement(`SELECT run_id, ${DIGEST_CONTEXT_WINDOW_SQL} AS context_window
        FROM run_digests INDEXED BY run_digests_context_window
        WHERE run_id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as {
        run_id: string;
        context_window: number | null;
      }[];
      for (const row of rows)
        if (row.context_window !== null) out.set(row.run_id, row.context_window);
    }
    return out;
  }

  /** Deletes the digests of runs that started before `olderThan` (the runs stay). */
  pruneDigests(olderThan: number): void {
    this.db
      .prepare("DELETE FROM run_digests WHERE run_id IN (SELECT id FROM runs WHERE started_at < ?)")
      .run(olderThan);
  }

  /** Records a state change; a second change of one agent in the same millisecond is dropped. */
  addAgentEvent(e: AgentEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_events (agent_id, at, from_state, to_state, text) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.agentId, e.at, e.from, e.to, e.text);
  }

  /** State changes at or after `since`, oldest first. */
  agentEvents(since: number): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_events WHERE at >= ? ORDER BY at, agent_id")
      .all(since) as Row[];
    return rows.map((r) => ({
      agentId: r.agent_id as AgentId,
      at: r.at as number,
      from: r.from_state as HudState,
      to: r.to_state as HudState,
      text: r.text as string,
    }));
  }

  /** Timeline sources include work already in progress at the window's left edge. */
  timelineSources(from: number, to: number) {
    const events = this.db
      .prepare(`SELECT agent_id, at, from_state, to_state FROM agent_events e WHERE at <= ?
      AND (at >= ? OR at = (SELECT MAX(at) FROM agent_events
        WHERE agent_id = e.agent_id AND at < ?)) ORDER BY at, agent_id`)
      .all(to, from, from) as Row[];
    const runs = this.db
      .prepare(`SELECT * FROM runs WHERE started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, seq`)
      .all(to, from) as Row[];
    const holds = this.db
      .prepare(`SELECT seat_id, started_at, ended_at FROM test_lock_runs
      WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`)
      .all(to, from) as { seat_id: string; started_at: number; ended_at: number | null }[];
    const reviews = this.db
      .prepare(`SELECT * FROM reviews WHERE started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at, id`)
      .all(to, from) as Row[];
    return {
      events: events.map(
        (r): Omit<AgentEvent, "text"> => ({
          agentId: r.agent_id as string,
          at: r.at as number,
          from: r.from_state as HudState,
          to: r.to_state as HudState,
        }),
      ),
      runs: runs.map(toRun),
      holds: holds.map((r) => ({ agentId: r.seat_id, from: r.started_at, to: r.ended_at })),
      reviews: reviews.map(toReview),
    };
  }

  latestMachineSample(until: number): MachineSample | null {
    const row = this.db
      .prepare("SELECT sample FROM machine_samples WHERE at <= ? ORDER BY at DESC LIMIT 1")
      .get(until) as { sample: string } | undefined;
    return row ? (JSON.parse(row.sample) as MachineSample) : null;
  }

  /** Records a card move; returns its id. */
  addBoardMove(m: Omit<BoardMove, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO board_moves (run_id, repo_id, issue, board_column, state, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.runId, m.repoId, m.issue, m.column, m.state, m.detail, m.at);
    return Number(r.lastInsertRowid);
  }

  /** Settles a pending move as done or failed. */
  finishBoardMove(id: number, state: "done" | "failed", detail: string | null, at: number): void {
    this.db
      .prepare("UPDATE board_moves SET state = ?, detail = ?, at = ? WHERE id = ?")
      .run(state, detail, at, id);
  }

  /** The moves settled at or after `since` (a pending one is not yet news), oldest first. */
  boardMoves(since: number): BoardMove[] {
    const rows = this.db
      .prepare("SELECT * FROM board_moves WHERE at >= ? AND state != 'pending' ORDER BY at, id")
      .all(since) as Row[];
    return rows.map((r) => this.boardMoveOf(r));
  }

  /**
   * Settled-done moves at or after `since`, plus each card's latest done move before it (what a
   * card's column was at `since`), oldest first.
   */
  doneBoardMovesFrom(since: number): BoardMove[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.run_id, m.repo_id, m.issue, m.board_column, m.state, m.detail, m.at
           FROM board_moves m
           JOIN (SELECT repo_id, issue, MAX(at) AS at FROM board_moves
                  WHERE state = 'done' AND at < ? GROUP BY repo_id, issue) last
             ON m.repo_id = last.repo_id AND m.issue = last.issue AND m.at = last.at
          WHERE m.state = 'done'
         UNION ALL
         SELECT id, run_id, repo_id, issue, board_column, state, detail, at
           FROM board_moves WHERE state = 'done' AND at >= ?
         ORDER BY at, id`,
      )
      .all(since, since) as Row[];
    return rows.map((r) => this.boardMoveOf(r));
  }

  /**
   * Whether a real run in this store moved the issue's card to a column (done). Rows under
   * `pr:` and `dep:` ids have no run, so another hub's moves never count.
   */
  runMovedCard(repoId: RepoId, issue: number): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM board_moves m JOIN runs r ON r.id = m.run_id
           WHERE m.repo_id = ? AND m.issue = ? AND m.state = 'done' LIMIT 1`,
        )
        .get(repoId, issue) !== undefined
    );
  }

  /** Every move of the run's card, oldest first, pending ones too. */
  boardMovesOfRun(runId: string): BoardMove[] {
    const rows = this.db
      .prepare("SELECT * FROM board_moves WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map((r) => this.boardMoveOf(r));
  }

  private boardMoveOf(r: Row): BoardMove {
    return {
      id: r.id as number,
      runId: r.run_id as string,
      repoId: r.repo_id as RepoId,
      issue: r.issue as number,
      column: r.board_column as HudColumn,
      state: r.state as BoardMoveState,
      detail: r.detail as string | null,
      at: r.at as number,
    };
  }

  /** Each agent's state after its latest recorded change. */
  latestAgentStates(): Map<AgentId, HudState> {
    const rows = this.statement(
      `SELECT agent_id, to_state FROM agent_events e
         WHERE at = (SELECT MAX(at) FROM agent_events WHERE agent_id = e.agent_id)`,
    ).all() as Row[];
    return new Map(rows.map((r) => [r.agent_id as AgentId, r.to_state as HudState]));
  }

  private historyNextTable = 0;
  private operationalHistoryNextTable = 0;
  private riskMembershipPruneCursor = { at: -1, id: 0 };

  /** Retain live work; expiry starts at completion, with bounded transactions and sweep cost. */
  async pruneHistory(now: number): Promise<void> {
    this.riskMembershipPruneCursor = pruneRiskMemberships(
      this.db,
      now,
      this.riskMembershipPruneCursor,
    );
    const day = 24 * 60 * 60_000;
    this.db.prepare("DELETE FROM ci_runs WHERE at < ?").run(now - QA_RETENTION_DAYS * day);
    this.db
      .prepare("DELETE FROM escaped_defects WHERE merged_at < ?")
      .run(now - QA_RETENTION_DAYS * day);
    this.db
      .prepare(
        `DELETE FROM pr_files WHERE NOT EXISTS (
           SELECT 1 FROM pull_requests p WHERE p.repo_id = pr_files.repo_id AND p.number = pr_files.pr_number)
         AND NOT EXISTS (
           SELECT 1 FROM pr_history h WHERE h.repo_id = pr_files.repo_id AND h.number = pr_files.pr_number
             AND h.merged_at >= ?)`,
      )
      .run(now - QA_RETENTION_DAYS * day);
    let batches = 0;
    // These rows are operational traces, not durable Audit and QA records. One bounded batch per
    // table keeps an upgrade's first maintenance pass within the same sweep budget as run history.
    const operationalTables = [
      ["attention_notes", "cleared_at IS NOT NULL AND cleared_at < ?", OPERATIONAL_RETENTION_DAYS],
      [
        "attention_episodes",
        "cleared_at IS NOT NULL AND cleared_at < ?",
        OPERATIONAL_RETENTION_DAYS,
      ],
      [
        "board_moves",
        `at < ? AND state IN ('done', 'failed') AND EXISTS (
          SELECT 1 FROM runs r WHERE r.id = board_moves.run_id AND r.ended_at IS NOT NULL)`,
        OPERATIONAL_RETENTION_DAYS,
      ],
      ["guard_hits", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["hub_events", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["flight_wakes", "at < ?", OPERATIONAL_RETENTION_DAYS],
      // A seat's question to FLIGHT and FLIGHT's answer to it are kept as long as a run.
      ["seat_questions", "answered_at IS NOT NULL AND answered_at < ?", AUDIT_RETENTION_DAYS],
      ["flight_decisions", `at < ? AND kind IN (${DECISION_KINDS_KEPT_SQL})`, AUDIT_RETENTION_DAYS],
      ["comms_repeats", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["mcp_tool_calls", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["question_choices", "chosen_at < ?", AUDIT_RETENTION_DAYS],
      // a question message and the replies to it outlive the 90-day message log
      ["comms", `at < ? AND (${COMMS_QUESTION_THREAD_SQL})`, AUDIT_RETENTION_DAYS],
      ["question_closures", "at < ?", OPERATIONAL_RETENTION_DAYS],
      ["drafts", "created_at < ? AND state != 'pending'", OPERATIONAL_RETENTION_DAYS],
      ["crew_errors", "acked = 1 AND at < ?", OPERATIONAL_RETENTION_DAYS],
      [
        "briefs",
        `at < ? AND NOT (
          id = (SELECT MAX(current.id) FROM briefs current WHERE current.key = briefs.key)
          AND EXISTS (SELECT 1 FROM attention_notes n WHERE n.key = briefs.key AND n.cleared_at IS NULL)
        )`,
        OPERATIONAL_RETENTION_DAYS,
      ],
      [
        "reviews",
        `ended_at IS NOT NULL AND ended_at < ? AND state IN ('reported', 'failed', 'superseded')
         AND NOT (state = 'reported' AND EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = reviews.repo_id AND p.number = reviews.pr_number AND p.state = 'open'
         ))`,
        AUDIT_RETENTION_DAYS,
      ],
      [
        "runs",
        `ended_at IS NOT NULL AND ended_at < ? AND NOT EXISTS (
          SELECT 1 FROM reviews v WHERE v.author_run_id = runs.id OR v.run_id = runs.id
        )`,
        AUDIT_RETENTION_DAYS,
      ],
      ["pr_history", "merged_at < ?", AUDIT_RETENTION_DAYS],
    ] as const;
    const operationalIndex = this.operationalHistoryNextTable % operationalTables.length;
    const [table, condition, retentionDays] = operationalTables[operationalIndex];
    this.operationalHistoryNextTable = (operationalIndex + 1) % operationalTables.length;
    if (batches < HISTORY_SWEEP_MAX_BATCHES) {
      const ids = this.db
        .prepare(`SELECT rowid AS id FROM ${table} WHERE ${condition} ORDER BY rowid LIMIT ?`)
        .all(now - retentionDays * day, HISTORY_BATCH_ROWS) as { id: number }[];
      if (ids.length > 0) {
        this.transaction(() => {
          if (table === "comms") {
            const marks = ids.map(() => "?").join(",");
            for (const child of [
              "comms_mentions",
              "comms_reactions",
              "comms_settlements",
              "comms_pins",
            ])
              this.db
                .prepare(`DELETE FROM ${child} WHERE message_id IN (${marks})`)
                .run(...ids.map(({ id }) => id));
          }
          if (table === "reviews") {
            const marks = ids.map(() => "?").join(",");
            this.db
              .prepare(`DELETE FROM review_checks WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_tests WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_shots WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_resolutions WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
            this.db
              .prepare(`DELETE FROM review_findings WHERE review_id IN (${marks})`)
              .run(...ids.map(({ id }) => id));
          }
          if (table === "runs") {
            const marks = ids.map(() => "?").join(",");
            const runIds = this.db
              .prepare(`SELECT id FROM runs WHERE rowid IN (${marks})`)
              .all(...ids.map(({ id }) => id)) as { id: string }[];
            const values = runIds.map(({ id }) => id);
            if (values.length > 0) {
              const runMarks = values.map(() => "?").join(",");
              for (const child of [
                "run_commits",
                "run_pushes",
                "run_attempts",
                "run_digests",
                "run_reads",
                "run_rereads",
              ])
                this.db
                  .prepare(`DELETE FROM ${child} WHERE run_id IN (${runMarks})`)
                  .run(...values);
            }
          }
          this.db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (${ids.map(() => "?").join(",")})`)
            .run(...ids.map(({ id }) => id));
        });
        batches++;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const endedRun = `r.ended_at IS NOT NULL
      AND COALESCE(json_extract(r.loop, '$.phase'), '') != 'parked'
      AND json_extract(r.loop, '$.aside') IS NULL
      AND NOT EXISTS (SELECT 1 FROM reviews v
        WHERE (v.author_run_id = r.id OR v.run_id = r.id)
          AND (v.ended_at IS NULL OR v.state IN ('queued', 'starting', 'running')))`;
    // Engine lines are claim keys. All runs remain, so their plan events remain too.
    const tables = [
      ["seat_lines", 7, "AND origin != 'engine'"],
      ["loop_events", 30, "AND key NOT LIKE '%:plan'"],
      ["run_evidence", 30, ""],
      ["check_runs", 30, ""],
      ["review_findings", QA_RETENTION_DAYS, ""],
      ["comms", COMMS_RETENTION_DAYS, ""],
      ["flight_decisions", FLIGHT_DECISIONS_RETENTION_DAYS, ""],
    ] as const;
    const start = this.historyNextTable;
    for (let offset = 0; offset < tables.length; offset++) {
      const index = (start + offset) % tables.length;
      const [table, days, extra] = tables[index];
      // Let other tables go first next time if this table consumes the sweep budget.
      this.historyNextTable = (index + 1) % tables.length;
      const findings = table === "review_findings";
      const condition =
        table === "comms"
          ? `at < ? AND NOT (${COMMS_QUESTION_THREAD_SQL})`
          : table === "flight_decisions"
            ? `at < ? AND kind NOT IN (${DECISION_KINDS_KEPT_SQL})`
            : findings
              ? `EXISTS (SELECT 1 FROM reviews v WHERE v.id = review_findings.review_id
            AND v.ended_at < ? AND v.state IN ('reported', 'failed', 'superseded')
            AND (v.run_id IS NULL OR EXISTS
              (SELECT 1 FROM runs r WHERE r.id = v.run_id AND ${endedRun})))
          AND EXISTS (SELECT 1 FROM runs r
            WHERE r.id = review_findings.author_run_id AND r.ended_at < ? AND ${endedRun})
          AND NOT (review_findings.resolution IS NULL AND EXISTS (
            SELECT 1 FROM reviews v JOIN pull_requests p
              ON p.repo_id = v.repo_id AND p.number = v.pr_number
            WHERE v.id = review_findings.review_id AND p.state = 'open'
          ))`
              : `EXISTS (SELECT 1 FROM runs r WHERE r.id = ${table}.run_id
            AND r.ended_at < ? AND ${endedRun}) ${extra}`;
      const select = this.db.prepare(
        `SELECT rowid AS id FROM ${table} WHERE rowid > ? AND ${condition}
         ORDER BY rowid LIMIT ?`,
      );
      let lastId = 0;
      while (batches < HISTORY_SWEEP_MAX_BATCHES) {
        let ids: { id: number }[] = [];
        const cutoff = now - days * day;
        // A finding ages from both its review's end and its author run's end.
        const cutoffs = findings ? [cutoff, cutoff] : [cutoff];
        this.transaction(() => {
          ids = select.all(lastId, ...cutoffs, HISTORY_BATCH_ROWS) as { id: number }[];
          if (ids.length === 0) return;
          if (table === "comms") {
            const marks = ids.map(() => "?").join(",");
            const values = ids.map(({ id }) => id);
            this.db
              .prepare(`DELETE FROM comms_mentions WHERE message_id IN (${marks})`)
              .run(...values);
            this.db
              .prepare(`DELETE FROM comms_reactions WHERE message_id IN (${marks})`)
              .run(...values);
            this.db
              .prepare(`DELETE FROM comms_settlements WHERE message_id IN (${marks})`)
              .run(...values);
            this.db.prepare(`DELETE FROM comms_pins WHERE message_id IN (${marks})`).run(...values);
          }
          this.db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (${ids.map(() => "?").join(",")})`)
            .run(...ids.map(({ id }) => id));
        });
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1].id;
        batches++;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (batches === HISTORY_SWEEP_MAX_BATCHES) break;
    }
  }

  /** Deletes the state changes recorded before `olderThan`. */
  pruneAgentEvents(olderThan: number): void {
    this.db.prepare("DELETE FROM agent_events WHERE at < ?").run(olderThan);
  }

  addUsage(s: UsageSample): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO usage_samples (account_id, window, at, pct, reset_at, source) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(s.accountId, s.window, s.at, s.pct, s.resetAt, s.source);
  }

  usage(accountId: AccountId, window: "5h" | "7d", sinceMs: number): UsageSample[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? AND at >= ? ORDER BY at ASC",
      )
      .all(accountId, window, sinceMs) as Row[];
    return rows.map(toSample);
  }

  /** The newest sample for an account and window, or null when there is none. */
  latestUsage(accountId: AccountId, window: "5h" | "7d"): UsageSample | null {
    const row = this.db
      .prepare(
        "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? ORDER BY at DESC LIMIT 1",
      )
      .get(accountId, window) as Row | undefined;
    return row ? toSample(row) : null;
  }

  /** True when any stored row changed. */
  replaceEscalations(repoId: RepoId, e: Escalation[]): boolean {
    return this.changed("escalations", repoId, () => {
      this.db.prepare("DELETE FROM escalations WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO escalations (id, repo_id, issue_number, title, kind, source, opened_at, url, question)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id, issue_number = excluded.issue_number,
           title = excluded.title, kind = excluded.kind, source = excluded.source,
           opened_at = excluded.opened_at, url = excluded.url, question = excluded.question`,
      );
      for (const x of e) {
        ins.run(
          x.id,
          repoId,
          x.issueNumber,
          x.title,
          x.kind,
          x.source,
          x.openedAt,
          x.url,
          x.question === null ? null : JSON.stringify(x.question),
        );
      }
    });
  }

  escalations(): Escalation[] {
    const rows = this.db
      .prepare("SELECT * FROM escalations ORDER BY opened_at ASC, id ASC")
      .all() as Row[];
    return rows.map(toEscalation);
  }

  /** Indexed canonical source lookup; freshness reads never mutate the escalation set. */
  escalation(id: string): Escalation | null {
    const row = this.db.prepare("SELECT * FROM escalations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toEscalation(row) : null;
  }

  /** True when any stored row changed. */
  replaceBoard(repoId: RepoId, items: BoardItem[]): boolean {
    return this.changed("board_items", repoId, () => {
      this.boardViews.delete(repoId);
      const before = new Map(
        (
          this.db
            .prepare("SELECT issue_number, status, closed FROM board_items WHERE repo_id = ?")
            .all(repoId) as Row[]
        ).map((r) => [r.issue_number as number, r]),
      );
      this.db.prepare("DELETE FROM board_items WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO board_items (repo_id, issue_number, title, status, state, labels, priority,
           updated_at, url, stage, owner, parent, sub_done, sub_total, blocked_by, milestone, size,
           closed, priority_source, created_at, item_id, project_id, assignees, author, after_deps,
           defect_refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, issue_number) DO UPDATE SET title = excluded.title,
           status = excluded.status, state = excluded.state, labels = excluded.labels,
           priority = excluded.priority, updated_at = excluded.updated_at, url = excluded.url,
           stage = excluded.stage, owner = excluded.owner, parent = excluded.parent,
           sub_done = excluded.sub_done, sub_total = excluded.sub_total,
           blocked_by = excluded.blocked_by, milestone = excluded.milestone,
           size = excluded.size, closed = excluded.closed,
           priority_source = excluded.priority_source, created_at = excluded.created_at,
           item_id = excluded.item_id, project_id = excluded.project_id,
           assignees = excluded.assignees, author = excluded.author,
           after_deps = excluded.after_deps, defect_refs = excluded.defect_refs`,
      );
      for (const i of items) {
        const old = before.get(i.issueNumber);
        if (old !== undefined && (old.status !== i.status || Boolean(old.closed) !== i.closed))
          this.markFlightPointers(
            "ticket",
            `${repoId}#${i.issueNumber}`,
            i.closed ? "closed" : `moved to ${i.status}`,
            Date.now(),
          );
        ins.run(
          repoId,
          i.issueNumber,
          i.title,
          i.status,
          i.state,
          JSON.stringify(i.labels),
          i.priority,
          i.updatedAt,
          i.url,
          i.stage,
          i.owner,
          i.parent,
          i.subIssues?.done ?? null,
          i.subIssues?.total ?? null,
          JSON.stringify(i.blockedBy),
          i.milestone,
          i.size,
          i.closed ? 1 : 0,
          i.prioritySource,
          i.createdAt,
          i.itemId,
          i.projectId,
          JSON.stringify(i.assignees ?? []),
          i.author ?? null,
          i.after && (i.after.issues.length > 0 || i.after.prs.length > 0)
            ? JSON.stringify(i.after)
            : null,
          i.defectRefs ? JSON.stringify(i.defectRefs) : null,
        );
      }
      this.captureEscapedDefects(repoId);
    });
  }

  board(repoId: RepoId): BoardItem[] {
    const rows = this.db
      .prepare("SELECT * FROM board_items WHERE repo_id = ? ORDER BY issue_number ASC")
      .all(repoId) as Row[];
    return rows.map(toBoardItem);
  }

  /**
   * The board for a caller that only reads it: the same cards as `board`, read once and kept
   * (frozen) until the board is replaced or another connection commits, so a page that reads the
   * board every few seconds does not rebuild every card each time.
   */
  boardView(repoId: RepoId): readonly Readonly<BoardItem>[] {
    const version = String(this.db.prepare("PRAGMA data_version").get()?.data_version);
    const kept = this.boardViews.get(repoId);
    if (kept && kept.version === version) return kept.cards;
    const cards = this.board(repoId).map((card) => Object.freeze(card));
    Object.freeze(cards);
    this.boardViews.set(repoId, { version, cards });
    return cards;
  }
  private boardViews = new Map<
    RepoId,
    { version: string; cards: readonly Readonly<BoardItem>[] }
  >();

  /** One board card from the last read, else null. */
  boardItem(repoId: RepoId, issueNumber: number): BoardItem | null {
    const row = this.db
      .prepare("SELECT * FROM board_items WHERE repo_id = ? AND issue_number = ?")
      .get(repoId, issueNumber) as Row | undefined;
    return row === undefined ? null : toBoardItem(row);
  }

  /**
   * Merges `prs` into the repo's rows (insert or update by number); nothing is deleted. True when
   * any stored row changed. `readAt` is when GitHub was read (our clock).
   */
  upsertPullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => this.writePullRequests(repoId, prs, readAt));
  }

  /** Replaces the repo's rows with `prs`. True when any stored row changed. */
  replacePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => {
      this.db.prepare("DELETE FROM pull_requests WHERE repo_id = ?").run(repoId);
      this.writePullRequests(repoId, prs, readAt);
    });
  }

  /**
   * Replaces the repo's rows with a sweep's read, which began at `readAt` (our clock). A stored
   * row read after that (a poll got there while the sweep was still paging) is newer than the
   * sweep's copy and is kept, as is a row the sweep did not see that was read at or after it; GitHub's
   * `updatedAt` cannot tell, as it does not move when a PR's CI finishes. True when any stored
   * row changed.
   */
  sweepPullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): boolean {
    return this.changed("pull_requests", repoId, () => {
      const readAtOf = new Map(
        (
          this.db
            .prepare("SELECT number, read_at FROM pull_requests WHERE repo_id = ?")
            .all(repoId) as { number: number; read_at: number }[]
        ).map((r) => [r.number, r.read_at]),
      );
      const seen = new Set(prs.map((p) => p.number));
      const kept = this.namedPullRequests(repoId);
      const del = this.db.prepare("DELETE FROM pull_requests WHERE repo_id = ? AND number = ?");
      for (const [number, at] of readAtOf) {
        if (!seen.has(number) && !kept.has(number) && at < readAt) del.run(repoId, number);
      }
      this.writePullRequests(
        repoId,
        prs.filter((p) => (readAtOf.get(p.number) ?? 0) <= readAt),
        readAt,
      );
    });
  }

  /**
   * The PRs an open card waits on by name (`After PR N`) or through the issue they carry
   * (`Depends on`): the sweep keeps them, or the wait would flicker each time it dropped one.
   */
  private namedPullRequests(repoId: RepoId): Set<number> {
    const open = this.board(repoId).filter((c) => !c.closed);
    const issues = new Set(open.flatMap((c) => c.after?.issues ?? []));
    const named = new Set(open.flatMap((c) => c.after?.prs ?? []));
    if (issues.size === 0) return named;
    for (const p of this.pullRequests(repoId)) {
      if ([...issues].some((n) => prCarries(p, repoId, n))) named.add(p.number);
    }
    return named;
  }

  /** Marks the ledger pointers on a PR whose state, head, CI, review or draft flag differ from the stored row. */
  private markMovedPullRequest(repoId: RepoId, p: PullRequestView, at: number): void {
    const old = this.db
      .prepare(
        "SELECT state, head_sha, ci, review, is_draft FROM pull_requests WHERE repo_id = ? AND number = ?",
      )
      .get(repoId, p.number) as Row | undefined;
    const change =
      old === undefined
        ? "opened"
        : old.state !== p.state
          ? p.state
          : (old.head_sha ?? null) !== (p.headSha ?? null)
            ? "new commit"
            : old.ci !== p.ci
              ? `CI ${p.ci}`
              : (old.review ?? null) !== (p.review ?? null)
                ? `review ${p.review ?? "cleared"}`
                : Boolean(old.is_draft) !== p.isDraft
                  ? p.isDraft
                    ? "back to draft"
                    : "ready for review"
                  : null;
    if (change !== null) this.markFlightPointers("pr", `${repoId}#${p.number}`, change, at);
  }

  private writePullRequests(repoId: RepoId, prs: PullRequestView[], readAt: number): void {
    const ins = this.db.prepare(
      `INSERT INTO pull_requests (repo_id, number, title, url, branch, ticket, state, is_draft,
         review, ci, created_at, updated_at, merged_at, read_at, head_sha, mergeable, author,
         assignees, checks, closing_issues, merge_commit_sha, additions, deletions, changed_files,
         base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, url = excluded.url,
         branch = excluded.branch, ticket = excluded.ticket, state = excluded.state,
         is_draft = excluded.is_draft, review = excluded.review, ci = excluded.ci,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         merged_at = excluded.merged_at, read_at = excluded.read_at,
         head_sha = excluded.head_sha, mergeable = excluded.mergeable, author = excluded.author,
         assignees = excluded.assignees, checks = excluded.checks,
         closing_issues = excluded.closing_issues, merge_commit_sha = excluded.merge_commit_sha,
         additions = excluded.additions, deletions = excluded.deletions,
         changed_files = excluded.changed_files, base = excluded.base, stale = 0`,
    );
    const deleteFiles = this.db.prepare("DELETE FROM pr_files WHERE repo_id = ? AND pr_number = ?");
    const addFile = this.db.prepare(
      "INSERT OR REPLACE INTO pr_files (repo_id, pr_number, path, change_type) VALUES (?, ?, ?, ?)",
    );
    const addHistory = this.db.prepare(
      "INSERT OR IGNORE INTO pr_history (repo_id, number, merged_at, record) VALUES (?, ?, ?, ?)",
    );
    const fillHistorySizes = this.db.prepare(
      `UPDATE pr_history SET record = json_set(record,
         '$.additions', COALESCE(json_extract(record, '$.additions'), ?),
         '$.deletions', COALESCE(json_extract(record, '$.deletions'), ?),
         '$.changedFiles', COALESCE(json_extract(record, '$.changedFiles'), ?))
       WHERE repo_id = ? AND number = ? AND (
         (json_extract(record, '$.additions') IS NULL AND ? IS NOT NULL) OR
         (json_extract(record, '$.deletions') IS NULL AND ? IS NOT NULL) OR
         (json_extract(record, '$.changedFiles') IS NULL AND ? IS NOT NULL))`,
    );
    const addCiRun = this.db.prepare(
      `INSERT INTO ci_runs (repo_id, run_key, sha, name, attempt, pr_number, workflow, state,
         conclusion, url, first_seen_at, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, run_key) DO UPDATE SET pr_number = excluded.pr_number,
         workflow = excluded.workflow, state = excluded.state, conclusion = excluded.conclusion,
         url = excluded.url, at = excluded.at`,
    );
    for (const p of prs) {
      if (p.headSha)
        for (const c of p.checks ?? [])
          addCiRun.run(
            repoId,
            // a check run is its GraphQL id; a status (or a row stored without one) is told apart
            // by what names it on this commit
            c.id !== undefined
              ? `run:${c.id}`
              : [c.kind, p.headSha, c.workflow ?? "", c.name, c.attempt ?? 0].join(":"),
            p.headSha,
            c.name,
            c.attempt ?? 0,
            p.number,
            c.workflow ?? null,
            c.state,
            c.conclusion,
            c.url,
            readAt,
            readAt,
          );
      const runs = this.db
        .prepare(
          `SELECT id FROM runs INDEXED BY runs_loop_pr_number
             WHERE json_extract(loop, '$.prNumber') = ?
           UNION
           SELECT author_run_id FROM reviews WHERE repo_id = ? AND pr_number = ?`,
        )
        .all(p.number, repoId, p.number) as Row[];
      for (const run of runs) {
        this.appendAttempt(run.id as string, "ci", readAt, {
          sha: p.headSha,
          state: p.ci,
          checks: p.checks ?? [],
        });
        if (p.mergedAt !== null)
          this.appendAttempt(run.id as string, "merge", p.mergedAt, {
            sha: p.headSha,
            mergeCommitSha: p.mergeCommitSha ?? null,
          });
      }
      if (p.files !== undefined) {
        deleteFiles.run(repoId, p.number);
        for (const f of p.files) addFile.run(repoId, p.number, f.path, f.changeType);
        if (p.headSha) {
          try {
            recordRiskMembership(this.db, {
              repoId,
              pr: p.number,
              sha: p.headSha,
              kind: "github-head",
              files: p.files.map((file) => file.path),
              declaredFiles: p.changedFiles ?? null,
              at: readAt,
            });
          } catch {
            this.db
              .prepare(
                "DELETE FROM code_health_file_memberships WHERE repo_id=? AND pr_number=? AND sha=? AND kind='github-head'",
              )
              .run(repoId, p.number, p.headSha);
          }
        }
      }
      this.markMovedPullRequest(repoId, p, readAt);
      ins.run(
        repoId,
        p.number,
        p.title,
        p.url,
        p.branch,
        p.ticket,
        p.state,
        p.isDraft ? 1 : 0,
        p.review,
        p.ci,
        p.createdAt,
        p.updatedAt,
        p.mergedAt,
        readAt,
        p.headSha,
        p.mergeable,
        p.author ?? null,
        JSON.stringify(p.assignees ?? []),
        JSON.stringify(p.checks ?? []),
        JSON.stringify(p.closingIssues ?? []),
        p.mergeCommitSha ?? null,
        p.additions ?? null,
        p.deletions ?? null,
        p.changedFiles ?? null,
        p.base ?? null,
      );
      if (p.mergedAt !== null) {
        const { files: _files, escapedDefects: _defects, ...record } = p;
        addHistory.run(repoId, p.number, p.mergedAt, JSON.stringify(record));
        const additions = p.additions ?? null;
        const deletions = p.deletions ?? null;
        const changedFiles = p.changedFiles ?? null;
        fillHistorySizes.run(
          additions,
          deletions,
          changedFiles,
          repoId,
          p.number,
          additions,
          deletions,
          changedFiles,
        );
      }
    }
    this.captureEscapedDefects(repoId);
  }

  /**
   * Records each bug card against the PRs merged within QA_RETENTION_DAYS before it was filed that
   * it names (see linkEscapedDefect). Rerun on every board and PR write, so a bug read before its
   * PR's diff still links on the next poll; a recorded link is never rewritten.
   */
  private captureEscapedDefects(repoId: RepoId): void {
    const bugs = (
      this.db
        .prepare(
          "SELECT issue_number, labels, created_at, defect_refs FROM board_items WHERE repo_id = ? AND defect_refs IS NOT NULL",
        )
        .all(repoId) as Row[]
    ).filter((b) => isBugLabelled(JSON.parse(b.labels as string) as string[]));
    if (bugs.length === 0) return;
    const newest = Math.max(...bugs.map((b) => b.created_at as number));
    const oldest = Math.min(...bugs.map((b) => b.created_at as number));
    const merged = this.db
      .prepare(
        `SELECT h.number, h.merged_at, json_extract(h.record, '$.branch') AS branch,
           COALESCE(p.head_sha, json_extract(h.record, '$.headSha')) AS head_sha,
           COALESCE(p.merge_commit_sha, json_extract(h.record, '$.mergeCommitSha')) AS merge_sha
         FROM pr_history h LEFT JOIN pull_requests p ON p.repo_id = h.repo_id AND p.number = h.number
         WHERE h.repo_id = ? AND h.merged_at >= ? AND h.merged_at <= ?`,
      )
      .all(repoId, oldest - QA_RETENTION_DAYS * DAY_MS, newest) as Row[];
    if (merged.length === 0) return;
    const filesOf = this.db.prepare(
      "SELECT path FROM pr_files WHERE repo_id = ? AND pr_number = ?",
    );
    const commitsOf = this.db.prepare(
      "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ?",
    );
    const facts = new Map<number, MergedPrFacts & { branch: string }>();
    for (const m of merged) {
      const branch = (m.branch as string | null) ?? "";
      facts.set(m.number as number, {
        number: m.number as number,
        mergedAt: m.merged_at as number,
        branch,
        shas: [
          ...[m.head_sha, m.merge_sha].filter((x): x is string => typeof x === "string"),
          ...(commitsOf.all(repoId, branch) as Row[]).map((c) => c.sha as string),
        ],
        files: (filesOf.all(repoId, m.number) as Row[]).map((f) => f.path as string),
      });
    }
    const authorOf = this.db.prepare(
      `SELECT agent_id, model FROM runs WHERE repo_id = ? AND branch = ? AND id NOT IN (
         SELECT run_id FROM reviews WHERE run_id IS NOT NULL) ORDER BY started_at DESC LIMIT 1`,
    );
    const add = this.db.prepare(
      `INSERT OR IGNORE INTO escaped_defects
         (repo_id, issue_number, pr_number, via, filed_at, merged_at, seat, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of bugs) {
      const filedAt = b.created_at as number;
      const window = [...facts.values()].filter(
        (f) => f.mergedAt >= filedAt - QA_RETENTION_DAYS * DAY_MS,
      );
      const refs = JSON.parse(b.defect_refs as string) as DefectRefs;
      for (const link of linkEscapedDefect({ createdAt: filedAt, refs }, window)) {
        const f = facts.get(link.prNumber);
        if (f === undefined) continue;
        const author = authorOf.get(repoId, f.branch) as Row | undefined;
        add.run(
          repoId,
          b.issue_number as number,
          f.number,
          link.via,
          filedAt,
          f.mergedAt,
          (author?.agent_id as string | undefined) ?? null,
          (author?.model as string | undefined) ?? null,
        );
      }
    }
  }

  /**
   * The QA board's workflow figures for work that ended or merged at or after `since`: escaped
   * defects, review wait and time per head, rework ratio per seat and model, tests per PR.
   */
  qaFlow(since: number): Omit<QaFlowView, "days" | "since" | "metrics"> {
    const escapedDefects = (
      this.db
        .prepare(
          "SELECT * FROM escaped_defects WHERE merged_at >= ? ORDER BY filed_at DESC, issue_number DESC, pr_number",
        )
        .all(since) as Row[]
    ).map((r) => ({
      repoId: r.repo_id as string,
      issueNumber: r.issue_number as number,
      prNumber: r.pr_number as number,
      via: r.via as DefectVia,
      filedAt: r.filed_at as number,
      mergedAt: r.merged_at as number,
      seat: r.seat as string | null,
      model: r.model as string | null,
    }));
    const reviews = this.db
      .prepare(
        `SELECT v.id, v.repo_id, v.pr_number, v.sha, v.created_at, v.started_at, v.ended_at,
           v.blocking, r.agent_id, r.model FROM reviews v LEFT JOIN runs r ON r.id = v.author_run_id
         WHERE v.state = 'reported' AND v.ended_at >= ? ORDER BY v.ended_at DESC, v.id DESC`,
      )
      .all(since) as Row[];
    const timings = reviewTimings(
      reviews.map((v) => ({
        reviewId: v.id as number,
        createdAt: v.created_at as number,
        startedAt: v.started_at as number | null,
        endedAt: v.ended_at as number | null,
      })),
    );
    const reviewOf = new Map(reviews.map((v) => [v.id as number, v]));
    const heads = timings.heads.map((h) => {
      const v = reviewOf.get(h.reviewId);
      return {
        ...h,
        repoId: v?.repo_id as string,
        prNumber: v?.pr_number as number,
        sha: v?.sha as string,
      };
    });
    const files = this.db
      .prepare(
        `SELECT h.repo_id, h.number, h.merged_at, f.path, f.change_type FROM pr_history h
         JOIN pr_files f ON f.repo_id = h.repo_id AND f.pr_number = h.number
         WHERE h.merged_at >= ? ORDER BY h.merged_at DESC, h.repo_id, h.number`,
      )
      .all(since) as Row[];
    const byPr = new Map<string, PrTestsView & { files: PrFileInput[] }>();
    for (const f of files) {
      const key = `${f.repo_id}#${f.number}`;
      const row = byPr.get(key) ?? {
        repoId: f.repo_id as string,
        prNumber: f.number as number,
        mergedAt: f.merged_at as number,
        added: 0,
        changed: 0,
        files: [],
      };
      row.files.push({ path: f.path as string, changeType: f.change_type as string });
      byPr.set(key, row);
    }
    return {
      escapedDefects,
      reviewTimings: { ...timings, heads },
      rework: reworkRatios(
        reviews.map((v) => ({
          seat: (v.agent_id as string | null) ?? "unknown",
          model: (v.model as string | null) ?? "unknown",
          blocking: v.blocking as number,
        })),
      ),
      testsPerPr: [...byPr.values()].map(({ files: diff, ...pr }) => ({
        ...pr,
        ...testsTouched(diff),
      })),
    };
  }

  /** Merged PR snapshots are immutable once any size fields missing at migration are filled. */
  prHistory(repoId: RepoId, since = 0, until = Number.MAX_SAFE_INTEGER): PullRequestView[] {
    return (
      this.db
        .prepare(
          "SELECT record FROM pr_history WHERE repo_id = ? AND merged_at >= ? AND merged_at <= ? ORDER BY merged_at DESC",
        )
        .all(repoId, since, until) as { record: string }[]
    ).map((r) => JSON.parse(r.record) as PullRequestView);
  }

  recordRetrospective(repoId: RepoId, day: string, at: number, report: unknown): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO retrospectives (repo_id, day, at, report) VALUES (?, ?, ?, ?)",
      )
      .run(repoId, day, at, JSON.stringify(report));
  }

  retrospectives(repoId: RepoId, since = 0, until = Number.MAX_SAFE_INTEGER): unknown[] {
    return (
      this.db
        .prepare(
          "SELECT report FROM retrospectives WHERE repo_id = ? AND at >= ? AND at <= ? ORDER BY at DESC",
        )
        .all(repoId, since, until) as { report: string }[]
    ).map((r) => JSON.parse(r.report));
  }

  /** Range-bounded, durable audit aggregates.  Inputs are timestamps already validated at HTTP. */
  audit(
    since: number,
    until: number,
    kinds: ReadonlyMap<string, AuditRunKind> = new Map(),
    thresholds?: Partial<AuditThresholds>,
  ): AuditView {
    const rows = (sql: string, ...args: SQLInputValue[]) =>
      this.db.prepare(sql).all(...args) as Row[];
    const prs = this.auditPrSizes(since, until);
    const spend = rows(
      `SELECT id AS runId, agent_id AS agentId, ticket, cost_usd AS costUsd FROM runs
       WHERE started_at >= ? AND started_at <= ? AND cost_usd IS NOT NULL
       ORDER BY cost_usd DESC, id`,
      since,
      until,
    ) as unknown as AuditView["spendOutliers"];
    const medianSpend = median(spend.map((r) => r.costUsd));
    return {
      range: { since, until },
      longRunners: (
        rows(
          `SELECT id AS runId, agent_id AS agentId, ticket, started_at AS startedAt, ended_at AS endedAt,
            EXISTS (SELECT 1 FROM seat_sessions s WHERE s.run_id = runs.id) AS held,
            COALESCE(ended_at, ?) - started_at AS durationMs FROM runs
           WHERE started_at <= ? AND COALESCE(ended_at, ?) >= ? ORDER BY durationMs DESC LIMIT 100`,
          until,
          until,
          until,
          since,
        ) as unknown as (Omit<AuditView["longRunners"][number], "kind" | "actionable"> & {
          agentId: string;
          held: number;
        })[]
      ).map(({ held, ...r }) => {
        const kind = kinds.get(r.agentId) ?? null;
        const actionable =
          kind !== "observed" && kind !== "watch" && (r.endedAt !== null || held === 1);
        return { ...r, kind, actionable };
      }),
      deathLoops: rows(
        `SELECT a.run_id AS runId, (SELECT agent_id FROM runs WHERE id = a.run_id) AS agentId,
          COUNT(*) AS parks FROM run_attempts a
         WHERE a.kind = 'loop' AND a.at >= ? AND a.at <= ?
           AND json_extract(a.data, '$.parked') IS NOT NULL GROUP BY a.run_id ORDER BY parks DESC`,
        since,
        until,
      ) as unknown as AuditView["deathLoops"],
      reworkRounds: rows(
        `SELECT author_run_id AS runId, (SELECT agent_id FROM runs WHERE id = author_run_id) AS agentId,
          MAX(0, MAX(round) - 1) AS rounds, MAX(round) AS maxRound FROM reviews
         WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?
         GROUP BY author_run_id ORDER BY rounds DESC, runId`,
        since,
        until,
      ) as unknown as AuditView["reworkRounds"],
      reviewRounds: {
        prs: rows(
          `SELECT rounds, COUNT(*) AS count FROM (
             SELECT MAX(round) AS rounds FROM reviews
             WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?
             GROUP BY author_run_id, pr_number
           ) GROUP BY rounds ORDER BY rounds`,
          since,
          until,
        ) as unknown as { rounds: number; count: number }[],
        late: rows(
          `SELECT v.seat_id AS seatId, r.model AS model, COUNT(*) AS findings, SUM(f.late) AS late
           FROM review_findings f JOIN reviews v ON v.id = f.review_id
           LEFT JOIN runs r ON r.id = v.run_id
           WHERE v.state = 'reported' AND v.ended_at >= ? AND v.ended_at <= ?
             AND f.severity IN (${BLOCKING_SEVERITIES.map(() => "?").join(", ")})
           GROUP BY v.seat_id, r.model ORDER BY late DESC, v.seat_id, r.model`,
          since,
          until,
          ...BLOCKING_SEVERITIES,
        ) as unknown as { seatId: string; model: string | null; findings: number; late: number }[],
      },
      refusalsByRule: rows(
        `SELECT rule, COUNT(*) AS count FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY rule ORDER BY count DESC, rule`,
        since,
        until,
      ) as unknown as AuditView["refusalsByRule"],
      refusals: rows(
        `SELECT agent_id AS agentId, run_id AS runId, rule, COUNT(*) AS count FROM guard_hits
         WHERE at >= ? AND at <= ? GROUP BY agent_id, run_id, rule
         ORDER BY count DESC, agent_id, run_id, rule`,
        since,
        until,
      ) as unknown as AuditView["refusals"],
      refusalSpikes: rows(
        `SELECT agent_id AS agentId, (at / ${DAY_MS}) * ${DAY_MS} AS day, COUNT(*) AS count
         FROM guard_hits WHERE at >= ? AND at <= ? GROUP BY agent_id, day HAVING count >= ?
         ORDER BY count DESC, day, agent_id`,
        since,
        until,
        AUDIT_REFUSAL_SPIKE,
      ) as unknown as AuditView["refusalSpikes"],
      spendOutliers:
        medianSpend === null
          ? []
          : spend.filter(
              (r) => r.costUsd > 0 && r.costUsd >= medianSpend * AUDIT_SPEND_OUTLIER_FACTOR,
            ),
      questions: (rows(
        `SELECT COUNT(*) AS asked, COALESCE(SUM(answered_at IS NOT NULL), 0) AS answered,
          AVG(CASE WHEN answered_at IS NULL THEN NULL ELSE answered_at - at END) AS answerMs
         FROM seat_questions WHERE at >= ? AND at <= ?`,
        since,
        until,
      )[0] ?? { asked: 0, answered: 0, answerMs: null }) as unknown as AuditView["questions"],
      costPerMergedTicket: rows(
        `WITH merged_tickets AS (
           SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
           WHERE merged_at >= ? AND merged_at <= ?
         ) SELECT t.ticket, SUM(r.cost_usd) AS costUsd FROM merged_tickets t
         LEFT JOIN runs r ON r.repo_id = t.repo_id AND r.ticket = t.ticket
         GROUP BY t.repo_id, t.ticket ORDER BY t.ticket`,
        since,
        until,
      ) as unknown as AuditView["costPerMergedTicket"],
      modelPromptTimeline: rows(
        `SELECT started_at AS at, model, account_id AS accountId, effort, prompt_hash AS promptHash
         FROM runs WHERE started_at >= ? AND started_at <= ? ORDER BY started_at`,
        since,
        until,
      ) as unknown as AuditView["modelPromptTimeline"],
      prSizes: {
        prs,
        outliers: prs.filter((p) => p.additions + p.deletions >= AUDIT_PR_OUTLIER_LINES),
      },
      chatter: this.commsChatter(since, until),
      flakes: this.auditFlakes(since, until),
      changes: this.auditChanges(since, until),
      tokenOveruse: this.auditTokenOveruse(since, until, kinds),
      items: this.auditItems(since, until),
      improvements: [
        ...toolImprovements(this.toolUsage(until - AUDIT_TOOL_WINDOW_MS, until), until),
        ...messageImprovements(
          this.db,
          since,
          until,
          auditThresholds(thresholds),
          this.commsChatter(since, until),
        ),
      ],
      surgeonProposals: [],
    };
  }

  /**
   * Records an Audit item once per kind and subject; its tier comes from the kind (unknown kinds
   * are Go-ahead). A repeat leaves the item as it was, except that an open item may become done.
   */
  recordAuditItem(i: {
    kind: string;
    subject: string;
    state: AuditItem["state"];
    detail: string;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO audit_items (kind, subject, tier, state, detail, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, subject) DO UPDATE SET state = excluded.state, detail = excluded.detail
         WHERE audit_items.state = 'open' AND excluded.state = 'done'`,
      )
      .run(i.kind, i.subject, auditTier(i.kind), i.state, i.detail, i.at);
  }

  /** Items recorded in range, newest first. */
  private auditItems(since: number, until: number): AuditItem[] {
    return this.db
      .prepare(
        `SELECT id, kind, subject, tier, state, detail, at FROM audit_items
         WHERE at >= ? AND at <= ? ORDER BY at DESC, id DESC`,
      )
      .all(since, until) as unknown as AuditItem[];
  }

  /** Merged PRs in range that have a recorded size, largest first. */
  private auditPrSizes(since: number, until: number): AuditPrSize[] {
    const sized: AuditPrSize[] = [];
    for (const row of this.db
      .prepare("SELECT repo_id, record FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .all(since, until) as { repo_id: string; record: string }[]) {
      const pr = JSON.parse(row.record) as PullRequestView;
      if (pr.additions == null || pr.deletions == null || pr.changedFiles == null) continue;
      sized.push({
        repoId: row.repo_id,
        number: pr.number,
        ticket: pr.ticket,
        mergedAt: pr.mergedAt ?? 0,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
      });
    }
    return sized.sort(
      (a, b) =>
        b.additions + b.deletions - (a.additions + a.deletions) ||
        a.repoId.localeCompare(b.repoId) ||
        a.number - b.number,
    );
  }

  /** Failed-then-passed-on-same-head observations FLIGHT kept per repo, grouped by check. */
  private auditFlakes(since: number, until: number): AuditView["flakes"] {
    const byKey = new Map<string, { count: number; lastAt: number }>();
    const prefix = `${FLIGHT_SIGNALS_SETTING}:`;
    const stored = this.db
      .prepare("SELECT value FROM settings WHERE substr(key, 1, ?) = ?")
      .all(prefix.length, prefix) as { value: string }[];
    for (const { value } of stored) {
      let flakes: Record<string, { key?: unknown; at?: unknown }> = {};
      try {
        flakes = JSON.parse(value)?.flakes ?? {};
      } catch {}
      for (const flake of Object.values(flakes ?? {})) {
        if (typeof flake?.key !== "string" || typeof flake.at !== "number") continue;
        if (flake.at < since || flake.at > until) continue;
        const entry = byKey.get(flake.key) ?? { count: 0, lastAt: 0 };
        entry.count += 1;
        entry.lastAt = Math.max(entry.lastAt, flake.at);
        byKey.set(flake.key, entry);
      }
    }
    return [...byKey]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** Each seat's first run on a new prompt or model in range, with metrics either side of it. */
  private auditChanges(since: number, until: number): AuditChange[] {
    const runs = this.db
      .prepare(
        `SELECT agent_id, started_at, model, prompt_hash FROM runs
         WHERE started_at <= ? ORDER BY agent_id, started_at, id`,
      )
      .all(until) as {
      agent_id: string;
      started_at: number;
      model: string | null;
      prompt_hash: string | null;
    }[];
    const changes: AuditChange[] = [];
    const previous = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      const last = previous.get(run.agent_id);
      previous.set(run.agent_id, run);
      if (!last || run.started_at < since) continue;
      for (const [kind, from, to] of [
        ["prompt", last.prompt_hash, run.prompt_hash],
        ["model", last.model, run.model],
      ] as const) {
        if (to === null || to === from) continue;
        const windowMs = Math.min(
          AUDIT_CHANGE_WINDOW_MS,
          run.started_at - since,
          until - run.started_at,
        );
        changes.push({
          kind,
          agentId: run.agent_id,
          at: run.started_at,
          from,
          to,
          windowMs,
          before: this.auditMetrics(run.started_at - windowMs, run.started_at - 1),
          after: this.auditMetrics(run.started_at, run.started_at + windowMs - 1),
        });
      }
    }
    return changes.sort((a, b) => a.at - b.at || a.agentId.localeCompare(b.agentId));
  }

  /**
   * Runs started in range whose input + output tokens pass their size's expected use (see
   * `tokenBaselines`, built from build runs of the last `AUDIT_BASELINE_DAYS` days), largest first.
   * Only runs of agents `kinds` marks as build count: watch, plan and review seats and observed
   * loops have other shapes of use.
   * A finding only: it reads the run, never changes it.
   */
  private auditTokenOveruse(
    since: number,
    until: number,
    kinds: ReadonlyMap<string, AuditRunKind>,
  ): AuditView["tokenOveruse"] {
    const runRows = (sql: string, ...args: SQLInputValue[]) =>
      this.db.prepare(sql).all(...args) as Row[];
    // the board's Size of the run's ticket ("repo#12" is repo, issue 12)
    const from = `FROM runs r LEFT JOIN board_items b
         ON b.repo_id = r.repo_id AND r.ticket = b.repo_id || '#' || b.issue_number
       WHERE r.review_id IS NULL AND r.tokens IS NOT NULL`;
    // the loop kind stored at the run's start; a seat since removed still counts, and a row from
    // before it was stored falls back to the seat's kind now
    const isBuild = (r: Row): boolean => (r.loopKind ?? kinds.get(r.agentId as string)) === "build";
    const usage = (r: Row): TokenUsage => JSON.parse(r.tokens as string) as TokenUsage;
    const baselines = tokenBaselines(
      runRows(
        `SELECT r.agent_id AS agentId, r.loop_kind AS loopKind, b.size AS size, r.tokens AS tokens ${from}
           AND r.ended_at IS NOT NULL AND r.started_at >= ? AND r.started_at <= ?`,
        until - AUDIT_BASELINE_DAYS * DAY_MS,
        until,
      )
        .filter(isBuild)
        .map((r) => ({
          size: r.size as string | null,
          tokens: usage(r).input + usage(r).output,
        })),
    );
    const blocking = BLOCKING_SEVERITIES.map(() => "?").join(", ");
    const runs: AuditTokenOveruse[] = [];
    for (const r of runRows(
      `SELECT r.id AS id, r.agent_id AS agentId, r.ticket AS ticket, r.started_at AS startedAt,
         r.ended_at AS endedAt, r.loop_kind AS loopKind, r.tokens AS tokens, b.size AS size ${from}
         AND r.started_at >= ? AND r.started_at <= ? ORDER BY r.started_at DESC`,
      since,
      until,
    )) {
      if (!isBuild(r)) continue;
      const tokens = usage(r);
      const total = tokens.input + tokens.output;
      const size = r.size as string | null;
      const expected = baselines.expected(size);
      if (total <= expected) continue;
      const id = r.id as string;
      const rounds = this.db
        .prepare("SELECT COUNT(*) AS n FROM reviews WHERE author_run_id = ? AND state = 'reported'")
        .get(id) as { n: number };
      const byCategory: AuditOveruseFacts["blockingByCategory"] = {};
      let blockingTotal = 0;
      for (const f of this.db
        .prepare(
          `SELECT COALESCE(category, 'uncategorised') AS category, COUNT(*) AS n FROM review_findings
           WHERE author_run_id = ? AND severity IN (${blocking}) GROUP BY category`,
        )
        .all(id, ...BLOCKING_SEVERITIES) as { category: keyof typeof byCategory; n: number }[]) {
        byCategory[f.category] = f.n;
        blockingTotal += f.n;
      }
      const digest = this.db
        .prepare(
          "SELECT json_extract(digest, '$.turns') AS turns FROM run_digests WHERE run_id = ?",
        )
        .get(id) as { turns: number | null } | undefined;
      const facts: AuditOveruseFacts = {
        size,
        reviewRounds: rounds.n,
        blocking: blockingTotal,
        blockingByCategory: byCategory,
        turns: digest?.turns ?? null,
      };
      const cause = classifyOveruse(facts);
      runs.push({
        runId: id,
        agentId: r.agentId as string,
        ticket: r.ticket as string | null,
        startedAt: r.startedAt as number,
        ended: r.endedAt !== null,
        tokens: total,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheCreate: tokens.cacheCreate,
        expected,
        ...facts,
        cause,
        prevention: overusePrevention(cause),
      });
    }
    runs.sort((a, b) => b.tokens - a.tokens || a.runId.localeCompare(b.runId));
    return {
      runs,
      groups: groupOveruse(runs),
      expected: [...TICKET_SIZES, null].map((size) => ({
        size,
        tokens: baselines.expected(size),
        measured: baselines.bySize.has(size ?? ""),
      })),
    };
  }

  /** Crew-wide metrics over one window, both ends inclusive. */
  private auditMetrics(from: number, to: number): AuditMetrics {
    const merged = this.db
      .prepare("SELECT COUNT(*) AS n FROM pr_history WHERE merged_at >= ? AND merged_at <= ?")
      .get(from, to) as { n: number };
    const reviews = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(blocking > 0), 0) AS failed FROM reviews
         WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ?`,
      )
      .get(from, to) as { n: number; failed: number };
    const costs = this.db
      .prepare(
        `WITH merged_tickets AS (
           SELECT DISTINCT repo_id, json_extract(record, '$.ticket') AS ticket FROM pr_history
           WHERE merged_at >= ? AND merged_at <= ?
         ) SELECT SUM(r.cost_usd) AS costUsd FROM merged_tickets t
         JOIN runs r ON r.repo_id = t.repo_id AND r.ticket = t.ticket
         GROUP BY t.repo_id, t.ticket HAVING costUsd IS NOT NULL`,
      )
      .all(from, to) as { costUsd: number }[];
    const rework = this.db
      .prepare(
        `SELECT COALESCE(SUM(rounds), 0) AS n FROM (
           SELECT MAX(0, MAX(round) - 1) AS rounds FROM reviews
           WHERE state = 'reported' AND ended_at >= ? AND ended_at <= ? GROUP BY author_run_id)`,
      )
      .get(from, to) as { n: number };
    return {
      merged: merged.n,
      reviewFailRate: reviews.n === 0 ? null : reviews.failed / reviews.n,
      medianCostPerMergedTicket: median(costs.map((c) => c.costUsd)),
      reworkRounds: rework.n,
    };
  }

  pullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC",
    ).all(repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** The newest PR of a branch, as its number and state: one narrow row, for the design previews. */
  pullRequestOfBranch(
    repoId: RepoId,
    branch: string,
    createdSince?: number,
  ): { number: number; state: PullRequestView["state"] } | null {
    const statement = this.statement(
      createdSince === undefined
        ? "SELECT number, state FROM pull_requests WHERE repo_id = ? AND branch = ? ORDER BY number DESC LIMIT 1"
        : "SELECT number, state FROM pull_requests WHERE repo_id = ? AND branch = ? AND created_at >= ? ORDER BY number DESC LIMIT 1",
    );
    const row = statement.get(
      repoId,
      branch,
      ...(createdSince === undefined ? [] : [createdSince]),
    ) as { number: number; state: PullRequestView["state"] } | undefined;
    return row ?? null;
  }

  /** A pinned link needs no historical checks, review metadata or escaped-defect hydration. */
  pullRequestLink(
    repoId: RepoId,
    ref: { number: number } | { ticket: string },
  ): Pick<PullRequestView, "repoId" | "number" | "title" | "url"> | null {
    const row =
      "number" in ref
        ? this.statement(
            "SELECT number, title, url FROM pull_requests WHERE repo_id = ? AND number = ?",
          ).get(repoId, ref.number)
        : this.statement(
            "SELECT number, title, url FROM pull_requests WHERE repo_id = ? AND ticket = ? AND state = 'open' ORDER BY number DESC LIMIT 1",
          ).get(repoId, ref.ticket);
    return row === undefined
      ? null
      : { repoId, ...(row as { number: number; title: string; url: string }) };
  }

  /** The queue needs only open PRs, without decoding historical checks and bodies. */
  openPullRequests(repoId: RepoId): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE repo_id = ? AND state = 'open' ORDER BY created_at, number",
    ).all(repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** The repo's open PRs and those updated at or after `since` (all of them when null), newest number first. */
  pullRequestsSince(repoId: RepoId, since: number | null): PullRequestView[] {
    const rows =
      since === null
        ? (this.statement("SELECT * FROM pull_requests WHERE repo_id = ? ORDER BY number DESC").all(
            repoId,
          ) as Row[])
        : (this.statement(
            "SELECT * FROM pull_requests WHERE repo_id = ? AND (state = 'open' OR updated_at >= ? OR merged_at >= ?) ORDER BY number DESC",
          ).all(repoId, since, since) as Row[]);
    return this.pullRequestRows(rows);
  }

  /** The repo's cached PRs that belong to the ticket (`repo#number`), newest number first. */
  pullRequestsOnTicket(repoId: RepoId, ticket: string): PullRequestView[] {
    const rows = this.statement(
      "SELECT * FROM pull_requests WHERE ticket = ? AND repo_id = ? ORDER BY number DESC",
    ).all(ticket, repoId) as Row[];
    return this.pullRequestRows(rows);
  }

  /** PRs that name this ticket directly or in closingIssues, without decoding unrelated histories. */
  pullRequestsClosingTicket(repoId: RepoId, issue: number): PullRequestView[] {
    const rows = this.statement(`SELECT * FROM pull_requests WHERE repo_id = ?
      AND (ticket = ? OR EXISTS (SELECT 1 FROM json_each(closing_issues) WHERE value = ?))
      ORDER BY number DESC`).all(repoId, `${repoId}#${issue}`, issue) as Row[];
    return this.pullRequestRows(rows);
  }

  /** Every review of a PR, oldest first. */
  reviewsOfPr(repoId: RepoId, prNumber: number): ReviewRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ? ORDER BY id")
      .all(repoId, prNumber) as Row[];
    return rows.map(toReview);
  }

  /** Every check run read for a PR's heads, newest first. */
  ciRunsOfPr(repoId: RepoId, prNumber: number): CiRunView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM ci_runs WHERE repo_id = ? AND pr_number = ? ORDER BY at DESC, name, attempt DESC",
      )
      .all(repoId, prNumber) as Row[];
    return rows.map(toCiRun);
  }

  /**
   * The newest `limit` comms messages that name the ticket: by its qualified `repo#n` (set by the
   * hub), by the short `#n` a seat's or the operator's message carries, or by `PR n` for one of its
   * PRs. Short forms carry no repo, so the caller keeps only those that belong to this one.
   */
  commsOnTicket(
    ticket: string,
    shortRef: string,
    prRefs: readonly string[],
    limit: number,
  ): CommsRow[] {
    const marks = prRefs.map((_, i) => `?${i + 4}`).join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM comms WHERE ticket = ?1 OR ticket = ?2 OR ref = ?2 OR ref = ?1
           ${prRefs.length > 0 ? `OR ticket IN (${marks}) OR ref IN (${marks})` : ""}
         ORDER BY at DESC, id DESC LIMIT ?3`,
      )
      .all(ticket, shortRef, limit, ...prRefs) as Row[];
    return rows.map((r) => this.commsRow(r));
  }

  /** Counts retained and retired reference metadata; never reads text or limits by time. */
  commsTicketReferenceCounts(): {
    ticket: string | null;
    ref: string | null;
    from: string;
    count: number;
  }[] {
    return (
      this.statement(`SELECT ticket, ref, sender, SUM(count) AS count FROM (
        SELECT ticket, ref, from_id AS sender, COUNT(*) AS count
        FROM comms WHERE ticket IS NOT NULL OR ref IS NOT NULL
        GROUP BY ticket, ref, from_id
        UNION ALL
        SELECT CASE WHEN ticket_null THEN NULL ELSE ticket END,
          CASE WHEN ref_null THEN NULL ELSE ref END, from_id AS sender, count
        FROM comms_ticket_archived_counts
      ) GROUP BY ticket, ref, sender`).all() as Row[]
    ).map((r) => ({
      ticket: r.ticket as string | null,
      ref: r.ref as string | null,
      from: r.sender as string,
      count: r.count as number,
    }));
  }

  /** Lightweight links for referenced PR numbers, without parsing unrelated checks or history. */
  commsPrTicketLinks(
    numbers: readonly number[],
  ): { repoId: string; number: number; ticket: string | null; closingIssues: number[] }[] {
    const rows: Row[] = [];
    const unique = [...new Set(numbers)];
    for (let start = 0; start < unique.length; start += 400) {
      const batch = unique.slice(start, start + 400);
      rows.push(
        ...(this.statement(`SELECT repo_id, number, ticket, closing_issues FROM pull_requests
        WHERE number IN (${batch.map(() => "?").join(",")})`).all(...batch) as Row[]),
      );
    }
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      ticket: r.ticket as string | null,
      closingIssues: JSON.parse(r.closing_issues as string) as number[],
    }));
  }

  /** A separate indexed question page; ending a run alone does not provide answer text. */
  ticketQuestions(
    repoId: string,
    ticket: string,
    limit: number,
    before: { at: number; id: number } | null = null,
  ): TicketQuestion[] {
    const rows =
      this.statement(`SELECT q.*, d.decision AS answer, d.at AS answer_at, d.basis AS answer_basis,
        (SELECT x.item_key FROM item_discussions x WHERE x.item_key = 'ask:' || q.id LIMIT 1)
          AS discussion_key
      FROM seat_questions q JOIN runs r ON r.id = q.run_id
      LEFT JOIN flight_decisions d ON d.id = (SELECT a.id FROM flight_decisions a
        WHERE a.question_id = q.id AND a.kind = 'answer' ORDER BY a.at DESC, a.id DESC LIMIT 1)
      WHERE r.repo_id = ? AND r.ticket = ?
      ${before === null ? "" : "AND (q.at < ? OR (q.at = ? AND q.id < ?))"}
      ORDER BY q.at DESC, q.id DESC LIMIT ?`).all(
        repoId,
        ticket,
        ...(before === null ? [] : [before.at, before.at, before.id]),
        limit,
      ) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      seat: r.agent_id as string,
      text: r.text as string,
      discussionKey: r.discussion_key as string | null,
      at: r.at as number,
      passedAt: r.passed_at as number | null,
      asideAt: r.aside_at as number | null,
      closedAt: r.answered_at as number | null,
      answer: r.answer as string | null,
      answerAt: r.answer_at as number | null,
      answerBasis: r.answer_basis as string | null,
    }));
  }

  /** The newest `limit` FLIGHT decisions that name the ticket by ref or target one of its runs. */
  flightDecisionsOnTicket(ref: string, runIds: readonly string[], limit: number): FlightDecision[] {
    const byRef = this.db
      .prepare("SELECT * FROM flight_decisions WHERE ref = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(ref, limit) as Row[];
    const byRun = this.statement(
      "SELECT * FROM flight_decisions WHERE target_run_id = ? ORDER BY at DESC, id DESC LIMIT ?",
    );
    const seen = new Set<number>();
    const out: FlightDecision[] = [];
    for (const r of [...byRef, ...runIds.flatMap((id) => byRun.all(id, limit) as Row[])]) {
      if (seen.has(r.id as number)) continue;
      seen.add(r.id as number);
      out.push(toFlightDecision(r));
    }
    return out.sort((a, b) => b.at - a.at || b.id - a.id).slice(0, limit);
  }

  /** The stored PRs among `numbers`, as number and title, lowest number first; never parses a row's checks. */
  pullRequestTitles(repoId: RepoId, numbers: readonly number[]): PrTitle[] {
    if (numbers.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT number, title FROM pull_requests WHERE repo_id = ? AND number IN (${numbers.map(() => "?").join(", ")}) ORDER BY number ASC`,
      )
      .all(repoId, ...numbers) as { number: number; title: string }[];
    return rows.map((r) => ({ number: r.number, title: r.title }));
  }

  pullRequest(repoId: RepoId, number: number): PullRequestView | null {
    const row = this.statement("SELECT * FROM pull_requests WHERE repo_id = ? AND number = ?").get(
      repoId,
      number,
    ) as Row | undefined;
    return row === undefined ? null : (this.pullRequestRows([row])[0] ?? null);
  }

  /** Pull requests for configured repos, indexed after one table read for the HUD. */
  pullRequestsForRepos(repoIds: readonly RepoId[]): Map<RepoId, PullRequestView[]> {
    const out = new Map<RepoId, PullRequestView[]>();
    if (repoIds.length === 0) return out;
    const rows = this.statement(
      `SELECT * FROM pull_requests WHERE repo_id IN (${repoIds.map(() => "?").join(", ")}) ORDER BY number DESC`,
    ).all(...repoIds) as Row[];
    for (const pr of this.pullRequestRows(rows)) {
      const prs = out.get(pr.repoId) ?? [];
      prs.push(pr);
      out.set(pr.repoId, prs);
    }
    return out;
  }

  /** The HUD retains every open PR and the historical PRs its displayed runs actually name. */
  openAndReferencedPullRequests(
    repoIds: readonly RepoId[],
    referenced: readonly Pick<PullRequestView, "repoId" | "number">[],
  ): Map<RepoId, PullRequestView[]> {
    const out = new Map<RepoId, PullRequestView[]>(repoIds.map((repoId) => [repoId, []]));
    if (repoIds.length === 0) return out;
    const rows = this.statement(`WITH referenced AS (
      SELECT json_extract(value, '$.repoId') AS repo_id, json_extract(value, '$.number') AS number
      FROM json_each(?)
    ) SELECT p.* FROM pull_requests p
      WHERE p.repo_id IN (${repoIds.map(() => "?").join(", ")})
      AND (p.state = 'open' OR (p.repo_id, p.number) IN (
        SELECT repo_id, number FROM referenced
      )) ORDER BY p.number DESC`).all(JSON.stringify(referenced), ...repoIds) as Row[];
    for (const pr of this.pullRequestRows(rows)) out.get(pr.repoId)?.push(pr);
    return out;
  }

  overviewPullRequests(repoId: RepoId, since: number): PullRequestView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM pull_requests WHERE repo_id = ? AND (state = 'open' OR merged_at >= ?) ORDER BY number DESC",
      )
      .all(repoId, since) as Row[];
    return this.pullRequestRows(rows);
  }

  /** Latest successful move into Ready, including moves before today's window. */
  overviewReadyMoves(repoId: RepoId): Map<number, number> {
    const rows = this.db
      .prepare(
        "SELECT issue, MAX(at) AS at FROM board_moves WHERE repo_id = ? AND board_column = 'Ready' AND state = 'done' GROUP BY issue",
      )
      .all(repoId) as { issue: number; at: number }[];
    return new Map(rows.map((r) => [r.issue, r.at]));
  }

  private pullRequestRows(rows: Row[]): PullRequestView[] {
    const defects = new Map<string, NonNullable<PullRequestView["escapedDefects"]>>();
    for (const d of this.statement(
      "SELECT repo_id, pr_number, issue_number, via, filed_at FROM escaped_defects ORDER BY filed_at",
    ).all() as Row[]) {
      const key = `${d.repo_id}#${d.pr_number}`;
      defects.set(key, [
        ...(defects.get(key) ?? []),
        {
          issueNumber: d.issue_number as number,
          via: d.via as DefectVia,
          filedAt: d.filed_at as number,
        },
      ]);
    }
    return rows.map((r) => ({
      ...(defects.has(`${r.repo_id}#${r.number}`)
        ? { escapedDefects: defects.get(`${r.repo_id}#${r.number}`) }
        : {}),
      repoId: r.repo_id as string,
      number: r.number as number,
      title: r.title as string,
      url: r.url as string,
      branch: r.branch as string,
      ticket: r.ticket as string | null,
      state: r.state as PullRequestView["state"],
      isDraft: r.is_draft === 1,
      review: r.review as PullRequestView["review"],
      ci: r.ci as PullRequestView["ci"],
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      mergedAt: r.merged_at as number | null,
      headSha: r.head_sha as string | null,
      mergeCommitSha: r.merge_commit_sha as string | null,
      mergeable: r.mergeable as PullRequestView["mergeable"],
      author: (r.author as string | null) ?? null,
      assignees: JSON.parse(r.assignees as string) as string[],
      checks: JSON.parse(r.checks as string) as PrCheck[],
      closingIssues: JSON.parse(r.closing_issues as string) as number[],
      ...(r.additions == null ? {} : { additions: r.additions as number }),
      ...(r.deletions == null ? {} : { deletions: r.deletions as number }),
      ...(r.changed_files == null ? {} : { changedFiles: r.changed_files as number }),
      ...(r.base == null ? {} : { base: r.base as string }),
    }));
  }

  /** Marks the repo's stored PRs stale: a poll could not read them, so each row is its last good read. */
  markPullRequestsStale(repoId: RepoId): void {
    this.db.prepare("UPDATE pull_requests SET stale = 1 WHERE repo_id = ?").run(repoId);
  }

  /** The numbers of the repo's PRs whose latest read failed. */
  stalePullRequests(repoId: RepoId): Set<number> {
    const rows = this.db
      .prepare("SELECT number FROM pull_requests WHERE repo_id = ? AND stale = 1")
      .all(repoId) as { number: number }[];
    return new Set(rows.map((r) => r.number));
  }

  /** When the poll last read the PR (our clock), else null. */
  pullRequestReadAt(repoId: RepoId, number: number): number | null {
    const r = this.db
      .prepare("SELECT read_at FROM pull_requests WHERE repo_id = ? AND number = ?")
      .get(repoId, number) as { read_at: number } | undefined;
    return r ? r.read_at : null;
  }

  /** Replaces the repo's finished and open flow rows. */
  replaceFlow(repoId: RepoId, issues: FlowIssue[], prs: FlowPr[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM flow_issues WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM flow_prs WHERE repo_id = ?").run(repoId);
      const insIssue = this.db.prepare(
        "INSERT INTO flow_issues (repo_id, number, size, start_at, done_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const i of issues) insIssue.run(repoId, i.number, i.size, i.startAt, i.doneAt);
      const insPr = this.db.prepare(
        "INSERT INTO flow_prs (repo_id, number, merged_at, first_push_ci) VALUES (?, ?, ?, ?)",
      );
      for (const p of prs) insPr.run(repoId, p.number, p.mergedAt, p.firstPushCi);
    });
  }

  /** Issues done at or after `sinceMs`, plus every open flow issue, oldest first. */
  flowIssues(sinceMs: number): FlowIssue[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM flow_issues
         WHERE done_at >= ? OR done_at IS NULL
         ORDER BY COALESCE(done_at, start_at, 0) ASC, repo_id, number`,
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      size: r.size as string | null,
      startAt: r.start_at as number | null,
      doneAt: r.done_at as number | null,
    }));
  }

  /** The first recorded crew run for a ticket, including one before a telemetry chart's range. */
  ticketStartedAt(ticket: string): number | null {
    const row = this.db
      .prepare("SELECT MIN(started_at) AS at FROM runs WHERE ticket = ?")
      .get(ticket) as { at: number | null };
    return row.at;
  }

  /** PRs merged at or after `sinceMs`, across repos, oldest first. */
  flowPrs(sinceMs: number): FlowPr[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM flow_prs WHERE merged_at >= ? ORDER BY merged_at ASC, repo_id, number",
      )
      .all(sinceMs) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as string,
      number: r.number as number,
      mergedAt: r.merged_at as number,
      firstPushCi: r.first_push_ci as FlowPr["firstPushCi"],
    }));
  }

  /** Stores one machine sample and deletes those older than `MACHINE_RETENTION_MS` before it. */
  addMachineSample(s: MachineSample): void {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO machine_samples (at, sample, cpu_pct, mem_pct) VALUES (?, ?, ?, ?)",
        )
        .run(s.at, JSON.stringify(s), s.cpuPct, memPct(s));
      this.db.prepare("DELETE FROM machine_samples WHERE at < ?").run(s.at - MACHINE_RETENTION_MS);
    });
  }

  /** Stored machine samples with `at >= sinceMs`, oldest first. */
  machineSamples(sinceMs: number): MachineSample[] {
    const rows = this.db
      .prepare("SELECT sample FROM machine_samples WHERE at >= ? ORDER BY at ASC")
      .all(sinceMs) as { sample: string }[];
    return rows.map((r) => JSON.parse(r.sample) as MachineSample);
  }

  /**
   * Machine samples in [sinceMs, untilMs] averaged into at most `points` buckets of `bucketMs`
   * counted from `sinceMs` (the last bucket takes any remainder), oldest first. `at` is the
   * bucket's latest sample; a mean is null when no sample in the bucket measured it. The
   * aggregation runs in SQL over the cpu_pct and mem_pct columns, so a 7-day range returns
   * `points` rows and parses no JSON.
   */
  machineBuckets(
    sinceMs: number,
    untilMs: number,
    bucketMs: number,
    points: number,
  ): Telemetry["machine"] {
    const rows = this.db
      .prepare(
        `SELECT MAX(at) AS at, AVG(cpu_pct) AS cpu, AVG(mem_pct) AS mem FROM machine_samples
         WHERE at >= ? AND at <= ?
         GROUP BY MIN(?, CAST((at - ?) / ? AS INTEGER)) ORDER BY 1 ASC`,
      )
      .all(sinceMs, untilMs, points - 1, sinceMs, bucketMs) as {
      at: number;
      cpu: number | null;
      mem: number | null;
    }[];
    return rows.map((r) => ({ at: r.at, cpuPct: r.cpu, memPct: r.mem }));
  }

  /** Acknowledges attention item keys at `at` (a re-ack moves the time; absence is kept). */
  ack(keys: string[], at: number): void {
    this.transaction(() => {
      const briefs = this.briefs();
      const ins = this.db.prepare(
        `INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
      );
      for (const k of keys) {
        ins.run(k, at);
        const epoch = briefs.get(k)?.binding?.epoch;
        if (epoch) {
          this.setSetting(`brief-ack:${k}`, epoch);
          this.setSetting(`brief-default-cancel:${epoch}`, String(at));
        }
      }
    });
  }

  claimDecisionDefault(
    d: {
      key: string;
      briefAt: number;
      optionId: string | null;
      label: string;
      dueAt: number;
      target: string | null;
      answer: string;
      choice?: { epoch: string; requestKey: string; fingerprint: string; record: string };
      binding?: string;
    },
    message: NewCommsRow,
    at: number,
  ): boolean {
    let claimed = false;
    this.transaction(() => {
      if (d.choice && this.getSetting(`brief-choice:${d.choice.epoch}`)) return;
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO decision_defaults (key, brief_at, option_id, label, due_at, applied_at, target, answer, delivered_at, binding, delivery_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.key,
          d.briefAt,
          d.optionId,
          d.label,
          d.dueAt,
          at,
          d.target,
          d.answer,
          d.target === null ? at : null,
          d.binding ?? null,
          d.binding ? "pending" : "legacy",
        );
      if (r.changes === 0) return;
      if (d.choice) {
        this.setSetting(`brief-choice:${d.choice.epoch}`, d.choice.record);
        this.setSetting(d.choice.requestKey, d.choice.fingerprint);
        this.setSetting(`${d.choice.requestKey}:epoch`, d.choice.epoch);
        this.setSetting(`brief-ack:${d.key}`, d.choice.epoch);
      }
      this.insertComms(message, cutCommsText(message.text), null);
      this.db
        .prepare(
          `INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
           ON CONFLICT(key) DO UPDATE SET at = excluded.at`,
        )
        .run(d.key, at);
      claimed = true;
    }, true);
    return claimed;
  }

  /** One local choice per semantic epoch, serialized across Store handles by SQLite. */
  claimBriefChoice(
    epoch: string,
    requestKey: string,
    fingerprint: string,
    record: string,
  ): boolean {
    let claimed = false;
    this.transaction(() => {
      if (this.getSetting(`brief-choice:${epoch}`)) return;
      const prior = this.getSetting(requestKey);
      if (prior && prior !== fingerprint) return;
      this.setSetting(requestKey, fingerprint);
      this.setSetting(`${requestKey}:epoch`, epoch);
      this.setSetting(`brief-choice:${epoch}`, record);
      claimed = true;
    }, true);
    return claimed;
  }

  /** A confirmed authentication refusal performed no action and cannot consume the operator's decision. */
  refuseBriefChoice(epoch: string, requestKey: string, fingerprint: string, record: string): void {
    this.transaction(() => {
      const raw = this.getSetting(`brief-choice:${epoch}`);
      if (!raw || (JSON.parse(raw) as { fingerprint: string }).fingerprint !== fingerprint) return;
      this.setSetting(`${requestKey}:receipt`, record);
      this.setSetting(`brief-last-choice:${epoch}`, record);
      this.deleteSetting(`brief-choice:${epoch}`);
    }, true);
  }

  pendingDecisionDeliveries(): {
    key: string;
    briefAt: number;
    target: string;
    answer: string;
    binding?: string;
  }[] {
    return (
      this.db
        .prepare(`SELECT key, brief_at, target, answer, binding FROM decision_defaults d
      WHERE delivered_at IS NULL AND target IS NOT NULL AND delivery_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM question_closures c WHERE c.key = d.key AND c.kind = 'cleared' AND c.at >= d.applied_at)
      ORDER BY applied_at, key`)
        .all() as Row[]
    ).map((r) => ({
      key: r.key as string,
      briefAt: r.brief_at as number,
      target: r.target as string,
      answer: r.answer as string,
      ...(r.binding === null ? {} : { binding: r.binding as string }),
    }));
  }

  markDecisionDeliveryDone(key: string, briefAt: number, at: number): void {
    this.db
      .prepare(
        "UPDATE decision_defaults SET delivered_at = ?, delivery_state = 'delivered' WHERE key = ? AND brief_at = ?",
      )
      .run(at, key, briefAt);
  }

  stopDecisionDelivery(
    key: string,
    briefAt: number,
    state: "canceled" | "unknown",
    reason: string,
  ): void {
    this.db
      .prepare(
        "UPDATE decision_defaults SET delivery_state = ?, delivery_note = ? WHERE key = ? AND brief_at = ? AND delivered_at IS NULL",
      )
      .run(state, reason, key, briefAt);
  }

  briefChoice(epoch: string): BriefChoiceReceipt | null {
    const raw =
      this.getSetting(`brief-choice:${epoch}`) ?? this.getSetting(`brief-last-choice:${epoch}`);
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { receipt: BriefChoiceReceipt }).receipt;
    } catch {
      return null;
    }
  }

  /** Retained delivery outcomes include legacy/unverifiable rows; none is silently rebound. */
  decisionDeliveryState(
    key: string,
    briefAt: number,
  ): { state: string; deliveredAt: number | null; note: string | null } | null {
    const row = this.db
      .prepare(
        "SELECT delivery_state, delivered_at, delivery_note FROM decision_defaults WHERE key = ? AND brief_at = ?",
      )
      .get(key, briefAt) as Row | undefined;
    return row
      ? {
          state: row.delivery_state as string,
          deliveredAt: row.delivered_at as number | null,
          note: row.delivery_note as string | null,
        }
      : null;
  }

  /** Every ack: key → when it was acknowledged. */
  acks(): Map<string, number> {
    const rows = this.db.prepare("SELECT key, at FROM acks").all() as { key: string; at: number }[];
    return new Map(rows.map((r) => [r.key, r.at]));
  }

  /**
   * `present`: the keys of every current attention item. Present keys lose their absence, newly
   * absent ones are marked absent since `now`, and acks absent since before `now - ACK_ABSENT_MS`
   * are deleted. An ack's own age never matters. Called by the scheduler, never from a GET.
   */
  sweepAcks(present: Set<string>, now: number): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT key, absent_since FROM acks").all() as {
        key: string;
        absent_since: number | null;
      }[];
      const clear = this.db.prepare("UPDATE acks SET absent_since = NULL WHERE key = ?");
      const mark = this.db.prepare("UPDATE acks SET absent_since = ? WHERE key = ?");
      const del = this.db.prepare("DELETE FROM acks WHERE key = ?");
      for (const r of rows) {
        if (present.has(r.key)) {
          if (r.absent_since !== null) clear.run(r.key);
        } else if (r.absent_since === null) {
          mark.run(now, r.key);
        } else if (r.absent_since < now - ACK_ABSENT_MS) {
          del.run(r.key);
        }
      }
    });
  }

  /**
   * Merges the unread threads `rows` into the table: a new row is first seen `now`; an existing one
   * is unread again, keeping `first_seen_at` and its handled fields. `complete` (`rows` is the whole
   * unread list): every other unread row is read on GitHub, and closes as `read` if it was open.
   * With a source, completeness applies only to that source. True when any row changed.
   */
  upsertNotifications(
    rows: NotificationRead[],
    complete: boolean,
    now: number,
    source?: "github" | "teams",
  ): boolean {
    let changed = false;
    this.transaction(() => {
      const before = this.notificationsJson();
      const ins = this.db.prepare(
        `INSERT INTO notifications (id, repo_id, subject_type, title, number, reason, url, author,
           snippet, updated_at, last_read_at, unread, first_seen_at, source_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id,
           subject_type = excluded.subject_type, title = excluded.title, number = excluded.number,
           reason = excluded.reason, url = excluded.url, author = excluded.author,
           snippet = excluded.snippet, updated_at = excluded.updated_at,
           last_read_at = excluded.last_read_at, unread = 1, source_content = excluded.source_content`,
      );
      for (const n of rows) {
        ins.run(
          n.id,
          n.repoId,
          n.subjectType,
          n.title,
          n.number,
          n.reason,
          n.url,
          n.author,
          n.snippet,
          n.updatedAt,
          n.lastReadAt,
          now,
          JSON.stringify({ message: n.message, history: n.history }),
        );
      }
      if (complete) {
        const seen = new Set(rows.map((n) => n.id));
        const close = this.db.prepare(
          `UPDATE notifications SET unread = 0,
             handled_at = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN ? ELSE handled_at END,
             handled_how = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN 'read' ELSE handled_how END,
             handled_through = CASE WHEN handled_through IS NULL OR updated_at > handled_through THEN updated_at ELSE handled_through END
           WHERE id = ?`,
        );
        const unread = this.db.prepare("SELECT id FROM notifications WHERE unread = 1").all() as {
          id: string;
        }[];
        for (const { id } of unread)
          if (
            !seen.has(id) &&
            (source === undefined ||
              (this.notification(id)?.message?.source.kind ?? "github") === source)
          )
            close.run(now, id);
      }
      changed = this.notificationsJson() !== before;
    });
    return changed;
  }

  private notificationsJson(): string {
    return JSON.stringify(this.db.prepare("SELECT * FROM notifications ORDER BY id").all());
  }

  /** Every stored thread, newest first. */
  notifications(): NotificationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications ORDER BY updated_at DESC, id DESC")
      .all() as Row[];
    return rows.map(notificationRow);
  }

  notification(id: string): NotificationRow | null {
    const r = this.db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r === undefined ? null : notificationRow(r);
  }

  /**
   * Closes the thread as handled at `at`, when it is open and still at `updatedAt` (a newer comment
   * is never hidden by an old key). `handled_through` records the version handled, so a comment
   * that lands before `at` but after `updatedAt` still reopens it. True when it did.
   */
  markNotificationHandled(
    id: string,
    updatedAt: number,
    how: Exclude<NotificationRow["handledHow"], null>,
    at: number,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE notifications SET handled_at = ?, handled_how = ?, handled_through = ?
         WHERE id = ? AND updated_at = ? AND unread = 1
           AND (handled_through IS NULL OR updated_at > handled_through)`,
      )
      .run(at, how, updatedAt, id, updatedAt);
    return Number(r.changes) > 0;
  }

  /**
   * Deletes the threads closed before `before` that GitHub no longer lists as unread. A thread
   * handled here but still unread on GitHub stays, or the next read would bring it back.
   */
  pruneNotifications(before: number): void {
    this.db
      .prepare(
        `DELETE FROM notifications
         WHERE unread = 0 AND handled_at IS NOT NULL AND handled_at < ? AND updated_at <= handled_through`,
      )
      .run(before);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Keep a Priority approval's durable state and visible note together across a restart. */
  saveQueueReorder(key: string, value: string, at: number, note?: NoteInput, clear?: string): void {
    this.transaction(() => {
      this.setSetting(key, value);
      if (note) this.raiseNote(note);
      if (clear) this.clearNote(clear, at);
    });
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  pruneCollaborators(before: number): void {
    this.db
      .prepare(`DELETE FROM settings WHERE key LIKE 'collaborator:%'
      AND CASE WHEN json_valid(value) THEN coalesce(json_extract(value, '$.at'), 0) < ? ELSE 1 END`)
      .run(before);
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  getOffset(path: string): number {
    const row = this.db.prepare("SELECT offset FROM file_offsets WHERE path = ?").get(path) as
      | { offset: number }
      | undefined;
    return row?.offset ?? 0;
  }

  setOffset(path: string, offset: number): void {
    this.db
      .prepare(
        "INSERT INTO file_offsets (path, offset) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET offset = excluded.offset WHERE file_offsets.offset != excluded.offset",
      )
      .run(path, offset);
  }

  /** Records a collector's status; `last_ok_at` moves on success and is kept through failures. */
  setStatus(collector: string, ok: boolean, error: string | null): void {
    const at = Date.now();
    // The same result again moves only its time. That is no news to a view built from the store:
    // `readVersion` leaves it out, so a tick that found nothing new does not drop every view.
    const kept = this.db
      .prepare("SELECT ok, error FROM collector_status WHERE collector = ?")
      .get(collector) as { ok: number; error: string | null } | undefined;
    if (kept !== undefined && kept.ok === (ok ? 1 : 0) && kept.error === error)
      this.timestampOnlyWrites++;
    this.db
      .prepare(
        `INSERT INTO collector_status (collector, ok, error, at, last_ok_at, failing_since)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collector) DO UPDATE SET ok = excluded.ok, error = excluded.error,
           at = excluded.at, last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at),
           failing_since = CASE WHEN excluded.ok = 1 THEN NULL
             ELSE COALESCE(collector_status.failing_since, excluded.at) END`,
      )
      .run(collector, ok ? 1 : 0, error, at, ok ? at : null, ok ? null : at);
  }

  status(): HealthRow[] {
    const rows = this.db
      .prepare("SELECT * FROM collector_status ORDER BY collector ASC")
      .all() as Row[];
    return rows.map((r) => ({
      collector: r.collector as string,
      ok: r.ok === 1,
      error: r.error as string | null,
      at: r.at as number,
      lastOkAt: r.last_ok_at as number | null,
      failingSince: (r.failing_since as number | null) ?? null,
    }));
  }

  /** Sets the run's loop state (null clears it). */
  setRunLoop(runId: string, loop: RunLoop | null, at = Date.now()): void {
    const previous = this.run(runId)?.loop;
    if (JSON.stringify(previous) !== JSON.stringify(loop)) {
      this.appendAttempt(runId, "loop", at, loop ?? { phase: null });
      if (
        previous &&
        (previous.phase === "ci" || previous.phase === "review" || previous.awaitingFlight)
      ) {
        if (previous.phase !== loop?.phase || previous.awaitingFlight !== loop?.awaitingFlight) {
          const start = this.db
            .prepare(
              "SELECT at FROM run_attempts WHERE run_id = ? AND kind = 'wait' ORDER BY id DESC LIMIT 1",
            )
            .get(runId) as Row | undefined;
          this.appendAttempt(runId, "wait-end", at, {
            on: previous.awaitingFlight ?? previous.phase,
            durationMs: start ? Math.max(0, at - (start.at as number)) : null,
          });
        }
      }
      if (
        loop &&
        (loop.phase === "ci" || loop.phase === "review" || loop.awaitingFlight) &&
        (previous?.phase !== loop.phase || previous?.awaitingFlight !== loop.awaitingFlight)
      ) {
        this.appendAttempt(runId, "wait", at, { on: loop.awaitingFlight ?? loop.phase, since: at });
      }
    }
    this.db
      .prepare("UPDATE runs SET loop = ? WHERE id = ?")
      .run(loop === null ? null : JSON.stringify(loop), runId);
    if (loop?.phase === "done") this.clearNoReportNotes(runId, at, true);
  }

  /** An unfinished author gets one immutable context record; Git status can be filled afterward. */
  recordHandoff(h: RunHandoff): void {
    this.statement(
      "INSERT OR IGNORE INTO run_handoffs (run_id, repo_id, ticket, at, record) VALUES (?, ?, ?, ?, ?)",
    ).run(h.runId, h.repoId, h.ticket, h.at, JSON.stringify(h));
  }

  handoff(runId: string): RunHandoff | null {
    const row = this.statement(
      "SELECT record, accepted_by, accepted_run_id FROM run_handoffs WHERE run_id = ?",
    ).get(runId) as Row | undefined;
    return row
      ? {
          ...JSON.parse(row.record as string),
          acceptedBy: row.accepted_by as string | null,
          acceptedRunId: row.accepted_run_id as string | null,
        }
      : null;
  }

  openHandoff(repoId: string, ticket: string): RunHandoff | null {
    const row = this.statement(
      "SELECT run_id FROM run_handoffs WHERE repo_id = ? AND ticket = ? ORDER BY at DESC, run_id DESC LIMIT 1",
    ).get(repoId, ticket) as Row | undefined;
    const h = row ? this.handoff(row.run_id as string) : null;
    return h?.acceptedRunId == null ? h : null;
  }

  receivedHandoff(runId: string): RunHandoff | null {
    const row = this.statement(
      "SELECT run_id FROM run_handoffs WHERE accepted_run_id = ? ORDER BY at DESC LIMIT 1",
    ).get(runId) as Row | undefined;
    return row ? this.handoff(row.run_id as string) : null;
  }

  latestHandoffs(repoId: string): RunHandoff[] {
    return (
      this.statement(`SELECT h.run_id FROM run_handoffs h WHERE repo_id = ? AND h.run_id = (
      SELECT fresh.run_id FROM run_handoffs fresh WHERE fresh.repo_id = h.repo_id AND fresh.ticket = h.ticket ORDER BY fresh.at DESC, fresh.run_id DESC LIMIT 1
    )`).all(repoId) as Row[]
    ).flatMap((r) => {
      const h = this.handoff(r.run_id as string);
      return h ? [h] : [];
    });
  }

  /** Enrichment never changes the reservation or the seat that accepted the work. */
  handoffGit(runId: string, gitStatus: string[], gitState: RunHandoff["gitState"]): void {
    const h = this.handoff(runId);
    if (h)
      this.statement("UPDATE run_handoffs SET record = ? WHERE run_id = ?").run(
        JSON.stringify({ ...h, gitStatus, gitState }),
        runId,
      );
  }

  claimHandoff(runId: string, token: string): boolean {
    return (
      this.statement(
        "UPDATE run_handoffs SET claim_token = ? WHERE run_id = ? AND claim_token IS NULL AND accepted_run_id IS NULL",
      ).run(token, runId).changes === 1
    );
  }

  /** Handoffs a seat has claimed and not yet accepted into a run row: a seat is starting on them. */
  claimedHandoffs(repoId: string): RunHandoff[] {
    return (
      this.statement(
        "SELECT run_id FROM run_handoffs WHERE repo_id = ? AND claim_token IS NOT NULL AND accepted_run_id IS NULL",
      ).all(repoId) as Row[]
    ).flatMap((r) => {
      const h = this.handoff(r.run_id as string);
      return h ? [h] : [];
    });
  }

  releaseHandoff(runId: string, token: string): void {
    this.statement(
      "UPDATE run_handoffs SET claim_token = NULL WHERE run_id = ? AND claim_token = ? AND accepted_run_id IS NULL",
    ).run(runId, token);
  }

  acceptHandoff(runId: string, token: string, seatId: string, newRunId: string): boolean {
    return (
      this.statement(
        "UPDATE run_handoffs SET accepted_by = ?, accepted_run_id = ?, claim_token = NULL WHERE run_id = ? AND claim_token = ? AND accepted_run_id IS NULL",
      ).run(seatId, newRunId, runId, token).changes === 1
    );
  }

  /** Called only by the supervisor after it acquires the single crew lock on startup. */
  releaseHandoffClaims(): void {
    this.statement(
      "UPDATE run_handoffs SET claim_token = NULL WHERE accepted_run_id IS NULL",
    ).run();
  }

  /** Ends the run: when, with what status, and who ended it. */
  setRunEnded(
    runId: string,
    at: number,
    status: RunStatus,
    endedBy: NonNullable<Run["endedBy"]>,
  ): void {
    this.db
      .prepare("UPDATE runs SET ended_at = ?, status = ?, ended_by = ? WHERE id = ?")
      .run(at, status, endedBy, runId);
  }

  /** Exit diagnostics are controller-owned; transcript upserts never overwrite them. */
  recordNoReport(runId: string, record: NonNullable<Run["noReport"]>, note: NoteInput): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE runs SET no_report = ? WHERE id = ?")
        .run(JSON.stringify(record), runId);
      this.raiseNote(note);
    });
  }

  /** A report resolves earlier failures on this ticket; done resolves the whole ticket. */
  private clearNoReportNotes(runId: string, at: number, done = false): void {
    this.db
      .prepare(`
      UPDATE attention_notes SET cleared_at = ?
      WHERE cleared_at IS NULL AND key IN (
        SELECT 'no_report:' || old.id FROM runs old JOIN runs fresh ON fresh.id = ?
        WHERE old.id = fresh.id OR (
          old.repo_id = fresh.repo_id AND old.ticket = fresh.ticket
          AND (? OR old.started_at <= fresh.started_at)
        )
      )
    `)
      .run(at, runId, done ? 1 : 0);
  }

  /** Appends a note the run's seat reported; returns its id. */
  addEvidence(
    runId: string,
    note: string,
    at: number,
    details: {
      tests?: ReportedTest[];
      testsAdded?: { file: string; failedOnBase: boolean }[];
      doneWhen?: DoneWhenEntry[];
    } = {},
  ): number {
    const r = this.db
      .prepare(
        "INSERT INTO run_evidence (run_id, note, at, tests, tests_added, done_when) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        runId,
        note,
        at,
        JSON.stringify(details.tests ?? []),
        JSON.stringify(details.testsAdded ?? []),
        JSON.stringify(details.doneWhen ?? []),
      );
    this.clearNoReportNotes(runId, at);
    return Number(r.lastInsertRowid);
  }

  latestEvidence(runId: string): Evidence | null {
    const r = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as Row | undefined;
    return r ? evidenceOf(r) : null;
  }

  /** Records the ticket's Done-when lines for a run, replacing any recorded before (none: no rule). */
  setRunDoneWhen(runId: string, lines: readonly string[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM run_done_when WHERE run_id = ?").run(runId);
      const insert = this.db.prepare(
        "INSERT INTO run_done_when (run_id, pos, line) VALUES (?, ?, ?)",
      );
      lines.forEach((line, pos) => {
        insert.run(runId, pos, line);
      });
    }, true);
  }

  /** The run's recorded Done-when lines in ticket order; empty when none were recorded. */
  runDoneWhen(runId: string): string[] {
    return (
      this.db
        .prepare("SELECT line FROM run_done_when WHERE run_id = ? ORDER BY pos")
        .all(runId) as Row[]
    ).map((r) => r.line as string);
  }

  /** Every note the run's seat reported, oldest first. */
  evidenceNotes(runId: string): Evidence[] {
    const rows = this.db
      .prepare("SELECT * FROM run_evidence WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map(evidenceOf);
  }

  /** Queues a review; its id, or null when the (run, sha, epoch, attempt) key already exists. */
  requestReview(r: ReviewRequest): number | null {
    const res = this.db
      .prepare(
        // Archived reports outlive reviews. Allocate above both tables so history pruning cannot
        // reuse an archived review's identity. The allocation and insertion are one SQLite write.
        `INSERT OR IGNORE INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch,
           attempt, round, state, created_at)
         SELECT MAX(last_id) + 1, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?
         FROM (SELECT COALESCE(MAX(id), 0) AS last_id FROM reviews
           UNION ALL SELECT COALESCE(MAX(native_review_id), 0) FROM qa_reports)`,
      )
      .run(r.authorRunId, r.repoId, r.seatId, r.prNumber, r.sha, r.epoch, r.attempt, r.round, r.at);
    if (res.changes === 1)
      this.appendAttempt(r.authorRunId, "review", r.at, {
        ...r,
        id: Number(res.lastInsertRowid),
        state: "queued",
      });
    return res.changes === 1 ? Number(res.lastInsertRowid) : null;
  }

  review(id: number): ReviewRow | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Row | undefined;
    return row ? toReview(row) : null;
  }

  /** Moves a queued review to another review seat; true only when it was still queued. */
  moveQueuedReview(id: number, seatId: string, at: number): boolean {
    let moved = false;
    this.transaction(() => {
      moved =
        this.db
          .prepare("UPDATE reviews SET seat_id = ? WHERE id = ? AND state = 'queued'")
          .run(seatId, id).changes === 1;
      if (moved)
        this.db
          .prepare("INSERT OR REPLACE INTO review_moves (review_id, seat_id, at) VALUES (?, ?, ?)")
          .run(id, seatId, at);
    });
    return moved;
  }

  /** Whether FLIGHT assigned the queued review to its current seat. */
  reviewMoved(id: number): boolean {
    return this.db.prepare("SELECT 1 FROM review_moves WHERE review_id = ?").get(id) !== undefined;
  }

  /** The first snapshot wins. No update method exists; later evidence creates a new report. */
  putQaReport(report: QaReport): boolean {
    return (
      this.db
        .prepare(`INSERT OR IGNORE INTO qa_reports
      (id, repo_id, pr_number, head_sha, registered_at, native_review_id, report)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          report.id,
          report.repoId,
          report.prNumber,
          report.headSha,
          report.registeredAt,
          report.nativeReviewId ?? null,
          JSON.stringify(report),
        ).changes === 1
    );
  }

  qaReport(id: string): QaReport | null {
    const row = this.db.prepare("SELECT report FROM qa_reports WHERE id = ?").get(id) as
      | Row
      | undefined;
    try {
      return row ? (JSON.parse(row.report as string) as QaReport) : null;
    } catch {
      return null;
    }
  }

  qaReports(repoId: string, pr: number, headSha?: string): QaReport[] {
    const rows = this.db
      .prepare(`SELECT report FROM qa_reports WHERE repo_id = ? AND pr_number = ?
      ${headSha === undefined ? "" : "AND head_sha = ?"} ORDER BY registered_at DESC, id DESC LIMIT 100`)
      .all(repoId, pr, ...(headSha === undefined ? [] : [headSha])) as Row[];
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.report as string) as QaReport];
      } catch {
        return [];
      }
    });
  }

  /** Lightweight union, paginated before detail/asset reads. Archived native rows appear once. */
  qaHistory(
    repoIds: readonly string[],
    limit: number,
    cursor?: { at: number; key: string },
  ): QaHistoryEntry[] {
    if (!repoIds.length) return [];
    const marks = repoIds.map(() => "?").join(",");
    // Select identities before parsing report JSON or reading child evidence. Work per page is bounded.
    const identities = this.db
      .prepare(`WITH history AS (
      SELECT 'r:' || id AS key, 'report' AS kind, id, registered_at AS recorded_at
        FROM qa_reports WHERE repo_id IN (${marks})
      UNION ALL
      SELECT 'n:' || v.id, 'native', v.id, COALESCE(v.ended_at, v.created_at)
        FROM reviews v WHERE v.repo_id IN (${marks})
        AND v.state IN ('reported', 'failed', 'superseded')
        AND NOT EXISTS (SELECT 1 FROM qa_reports q WHERE q.native_review_id = v.id
          AND q.repo_id = v.repo_id AND q.pr_number = v.pr_number AND q.head_sha = v.sha
          AND json_extract(q.report, '$.reviewer.id') = v.seat_id
          AND COALESCE(json_extract(q.report, '$.nativeRunId'), '') = COALESCE(v.run_id, ''))
    ) SELECT * FROM history ${cursor ? "WHERE recorded_at < ? OR (recorded_at = ? AND key < ?)" : ""}
      ORDER BY recorded_at DESC, key DESC LIMIT ?`)
      .all(
        ...repoIds,
        ...repoIds,
        ...(cursor ? [cursor.at, cursor.at, cursor.key] : []),
        Math.max(1, Math.min(51, limit)),
      ) as Row[];
    const reportSummary =
      this.db.prepare(`      SELECT 'r:' || q.id AS key, 'report' AS kind, q.repo_id, q.pr_number, q.head_sha,
        json_extract(q.report, '$.prTitle') AS title, json_extract(q.report, '$.source') AS source,
        json_extract(q.report, '$.reviewer') AS reviewer,
        json_extract(q.report, '$.reviewedAt') AS reviewed_at,
        q.registered_at AS recorded_at, 'saved' AS state,
        json_extract(q.report, '$.verdict') AS verdict,
        json_extract(q.report, '$.completeness.state') AS evidence,
        CASE WHEN json_extract(q.report, '$.ci.source') = 'unavailable'
          OR json_extract(q.report, '$.ci.headSha') IS NOT q.head_sha
          OR COALESCE(json_array_length(q.report, '$.ci.checks'), 0) = 0 THEN 'unavailable'
          WHEN EXISTS (SELECT 1 FROM json_each(q.report, '$.ci.checks') c
            WHERE json_extract(c.value, '$.state') = 'failing') THEN 'failing'
          WHEN EXISTS (SELECT 1 FROM json_each(q.report, '$.ci.checks') c
            WHERE json_extract(c.value, '$.state') != 'passing') THEN 'pending'
          ELSE 'passing' END AS ci,
        json_extract(q.report, '$.visual.applicability') AS visual,
        COALESCE(json_array_length(q.report, '$.visual.pairs'), 0) AS pairs,
        COALESCE(json_array_length(q.report, '$.visual.screenshots'), 0) AS shots,
        json_extract(q.report, '$.permalink') AS permalink
      FROM qa_reports q WHERE q.id = ? AND json_valid(q.report)
`);
    const nativeSummary =
      this.db.prepare(`SELECT 'n:' || v.id AS key, 'native' AS kind, 'native' AS source,
      v.repo_id, v.pr_number, v.sha AS head_sha, v.id, v.author_run_id, v.created_at, v.seat_id, v.run_id, v.epoch, v.attempt, v.round,
      'Native review · round ' || v.round AS title,
      json_object('id', v.seat_id, 'label', v.seat_id) AS reviewer,
      CASE WHEN v.state = 'reported' THEN v.ended_at END AS reviewed_at,
      COALESCE(v.ended_at, v.created_at) AS recorded_at, v.state, v.verdict,
      'legacy' AS evidence, 'unavailable' AS ci, 'unknown' AS visual, 0 AS pairs,
      (SELECT COUNT(*) FROM review_shots s WHERE s.review_id = v.id) AS shots,
      '/qa?view=history&native=' || v.id AS permalink FROM reviews v WHERE v.id = ?`);
    const rows = identities.flatMap((identity) => {
      const row = (identity.kind === "report" ? reportSummary : nativeSummary).get(
        identity.id as SQLInputValue,
      ) as Row | undefined;
      return row ? [row] : [];
    });
    return rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as QaHistoryEntry["kind"],
      source: r.source as QaHistoryEntry["source"],
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      headSha: r.head_sha as string,
      title: r.title as string,
      reviewer: JSON.parse(r.reviewer as string),
      reviewedAt: r.reviewed_at as number | null,
      recordedAt: r.recorded_at as number,
      state: r.state as string,
      verdict: r.verdict ? JSON.parse(r.verdict as string) : null,
      evidence: r.evidence as QaHistoryEntry["evidence"],
      ci: r.ci as QaHistoryEntry["ci"],
      visual: r.visual as QaHistoryEntry["visual"],
      pairCount: r.pairs as number,
      screenshotCount: r.shots as number,
      permalink:
        r.kind === "native"
          ? `${r.permalink}&identity=${qaNativeIdentity({
              id: r.id as number,
              repoId: r.repo_id as string,
              prNumber: r.pr_number as number,
              sha: r.head_sha as string,
              seatId: r.seat_id as string,
              runId: r.run_id as string | null,
              authorRunId: r.author_run_id as string,
              createdAt: r.created_at as number,
              epoch: r.epoch as number,
              attempt: r.attempt as number,
              round: r.round as number,
            })}`
          : (r.permalink as string),
    }));
  }

  qaReportForReview(reviewId: number): QaReport | null {
    const row = this.db
      .prepare("SELECT id FROM qa_reports WHERE native_review_id = ?")
      .get(reviewId) as Row | undefined;
    return row ? this.qaReport(row.id as string) : null;
  }

  qaAssetReferenced(id: string, repoIds: readonly string[]): boolean {
    if (!repoIds.length) return false;
    return (
      this.db
        .prepare(`SELECT 1 FROM qa_reports WHERE repo_id IN (${repoIds.map(() => "?").join(",")})
      AND instr(report, ?) > 0 LIMIT 1`)
        .get(...repoIds, `/api/qa-report-assets/${id}`) !== undefined
    );
  }

  /** Open PRs as `repoId#number`: the work whose evidence and pictures the disk sweep keeps. */
  openPrKeys(): Set<string> {
    return new Set(
      (
        this.db
          .prepare("SELECT repo_id, number FROM pull_requests WHERE state = 'open'")
          .all() as Row[]
      ).map((r) => `${r.repo_id as string}#${r.number as number}`),
    );
  }

  /** The QA image ids (sha256) that a report of an open PR cites. */
  qaAssetIdsOfOpenPrs(): Set<string> {
    const ids = new Set<string>();
    const rows = this.db
      .prepare(
        `SELECT q.report FROM qa_reports q JOIN pull_requests p
           ON p.repo_id = q.repo_id AND p.number = q.pr_number AND p.state = 'open'`,
      )
      .all() as Row[];
    for (const r of rows)
      for (const m of (r.report as string).matchAll(/\/api\/qa-report-assets\/([0-9a-f]{64})/g))
        ids.add(m[1]);
    return ids;
  }

  /** The review screenshot ids of reviews of open PRs. */
  reviewShotIdsOfOpenPrs(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT s.shot_id FROM review_shots s JOIN reviews v ON v.id = s.review_id
               JOIN pull_requests p ON p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'`,
          )
          .all() as Row[]
      ).map((r) => r.shot_id as string),
    );
  }

  /** Every review of an external PR (author id `external-pr:...`) that has not been superseded. */
  externalReviewRows(): ReviewRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM reviews WHERE author_run_id LIKE 'external-pr:%' AND state != 'superseded' ORDER BY id",
      )
      .all() as Row[];
    return rows.map(toReview);
  }

  reviewsOfRun(authorRunId: string): ReviewRow[] {
    const rows = this.db
      .prepare("SELECT * FROM reviews WHERE author_run_id = ? ORDER BY id")
      .all(authorRunId) as Row[];
    return rows.map(toReview);
  }

  /** The latest review of a PR that has reported, else null. */
  latestReportedReview(repoId: string, prNumber: number): ReviewRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reviews WHERE repo_id = ? AND pr_number = ? AND state = 'reported'
         ORDER BY ended_at DESC, id DESC LIMIT 1`,
      )
      .get(repoId, prNumber) as Row | undefined;
    return row ? toReview(row) : null;
  }

  /** The review the run (a review run) performs, else null. */
  reviewOfRun(reviewRunId: string): ReviewRow | null {
    const row = this.db.prepare("SELECT * FROM reviews WHERE run_id = ?").get(reviewRunId) as
      | Row
      | undefined;
    return row ? toReview(row) : null;
  }

  reviewsIn(
    states: readonly ReviewState[],
    window?: { repo: string; since: number; until: number },
  ): ReviewRow[] {
    if (states.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE state IN (${states.map(() => "?").join(", ")})
         ${window ? "AND repo_id = ? AND ended_at >= ? AND ended_at <= ?" : ""}
         ORDER BY created_at, id`,
      )
      .all(...states, ...(window ? [window.repo, window.since, window.until] : [])) as Row[];
    return rows.map(toReview);
  }

  /** Moves a review from one of `from` to `to`; true only when exactly one row changed. */
  setReviewState(
    id: number,
    from: readonly ReviewState[],
    to: ReviewState,
    patch: { at: number; runId?: string; failure?: string },
  ): boolean {
    if (from.length === 0) return false;
    const ended = {
      sql: "ended_at = ?, failure = COALESCE(?, failure)",
      args: [patch.at, patch.failure ?? null],
    };
    const sets: Record<ReviewState, { sql: string; args: SQLInputValue[] }> = {
      queued: { sql: "started_at = NULL", args: [] },
      starting: { sql: "started_at = ?", args: [patch.at] },
      running: {
        sql: "run_id = ?, started_at = COALESCE(started_at, ?)",
        args: [patch.runId ?? null, patch.at],
      },
      reported: ended,
      failed: ended,
      superseded: ended,
    };
    const set = sets[to];
    const r = this.db
      .prepare(
        `UPDATE reviews SET state = ?, ${set.sql}
         WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`,
      )
      .run(to, ...set.args, id, ...from);
    if (r.changes === 1) {
      const review = this.review(id);
      if (review) this.appendAttempt(review.authorRunId, "review", patch.at, review);
    }
    return r.changes === 1;
  }

  /**
   * Records the review run's findings and verdict, once: only a `running` review tied to `runId`
   * takes them. False (and nothing written) otherwise.
   */
  recordFindings(
    reviewId: number,
    runId: string,
    r: {
      verdict: ReviewVerdict;
      summary: string;
      findings: ReviewFinding[];
      checked?: ReviewCheck[];
      tests?: ReportedTest[];
      resolutions?: FindingResolution[];
      qaReport?: QaReport;
      at: number;
    },
  ): boolean {
    const isBlocking = (f: ReviewFinding) => BLOCKING_SEVERITIES.includes(f.severity);
    const blocking = r.findings.filter(isBlocking).length;
    let recorded = false;
    this.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE reviews SET state = 'reported', verdict = ?, summary = ?, blocking = ?, minor = ?,
             ended_at = ?
           WHERE id = ? AND state = 'running' AND run_id = ?`,
        )
        .run(
          JSON.stringify(r.verdict),
          r.summary,
          blocking,
          r.findings.length - blocking,
          r.at,
          reviewId,
          runId,
        );
      if (res.changes !== 1) return;
      const row = this.db
        .prepare(
          "SELECT author_run_id, repo_id, pr_number, sha, epoch, round, changed_since FROM reviews WHERE id = ?",
        )
        .get(reviewId) as Row;
      const author = row.author_run_id as string;
      const repoId = row.repo_id as string;
      const prNumber = row.pr_number as number;
      // late: a later round's finding on a file the author did not touch since the last review
      const changed =
        (row.round as number) >= 2 && row.changed_since !== null
          ? new Set(JSON.parse(row.changed_since as string) as string[])
          : null;
      // a finding the reviewer holds from the last round was raised then, so it is carried, not late
      const heldFile = this.db.prepare(
        "SELECT file FROM review_findings WHERE review_id = ? AND pos = ?",
      );
      const held = new Set<string>();
      for (const x of r.resolutions ?? []) {
        if (x.outcome !== "held") continue;
        const file = (heldFile.get(x.findingRef.reviewId, x.findingRef.pos) as Row | undefined)
          ?.file;
        if (typeof file === "string") held.add(file);
      }
      const insert = this.db.prepare(
        `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary,
           scenario, fix, category, state, late)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      r.findings.forEach((f, pos) => {
        insert.run(
          reviewId,
          author,
          pos,
          f.severity,
          f.file,
          f.line,
          f.summary,
          f.scenario,
          f.fix,
          f.category ?? null,
          isBlocking(f) ? "open" : "logged",
          changed !== null && !changed.has(f.file) && !held.has(f.file) ? 1 : 0,
        );
      });
      const insertCheck = this.db.prepare(
        "INSERT INTO review_checks (review_id, check_id, result, note) VALUES (?, ?, ?, ?)",
      );
      for (const check of r.checked ?? [])
        insertCheck.run(reviewId, check.check, check.result, check.note ?? null);
      const insertTest = this.db.prepare(
        `INSERT INTO review_tests (review_id, command, file, passed, failed, skipped, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const test of r.tests ?? [])
        insertTest.run(
          reviewId,
          test.command,
          test.file ?? null,
          test.passed,
          test.failed,
          test.skipped,
          test.duration,
        );
      const insertResolution = this.db.prepare(
        `INSERT INTO review_resolutions (review_id, prior_review_id, finding_pos, outcome)
         VALUES (?, ?, ?, ?)`,
      );
      const resolve = this.db.prepare(
        `UPDATE review_findings SET resolution = ?, resolved_review_id = ?
         WHERE review_id = ? AND pos = ? AND resolution IS NULL`,
      );
      for (const resolution of r.resolutions ?? []) {
        insertResolution.run(
          reviewId,
          resolution.findingRef.reviewId,
          resolution.findingRef.pos,
          resolution.outcome,
        );
        resolve.run(
          resolution.outcome,
          reviewId,
          resolution.findingRef.reviewId,
          resolution.findingRef.pos,
        );
      }
      // A round that reports nothing to fix accepts the author's work: the blocking findings of the
      // earlier rounds that RETRO did not name were fixed.
      if (blocking === 0) {
        this.db
          .prepare(
            `UPDATE review_findings SET resolution = 'fixed', resolved_review_id = ?
             WHERE state = 'open' AND resolution IS NULL AND review_id IN (
               SELECT p.id FROM reviews p, reviews c
               WHERE c.id = ? AND p.author_run_id = c.author_run_id AND p.epoch = c.epoch
                 AND p.round < c.round)`,
          )
          .run(reviewId, reviewId);
        // An external review's subject is the PR, so it also accepts the crew run's findings on
        // earlier heads, but only those its brief listed: a review does not accept what it never saw.
        if (author === externalReviewKey(repoId, prNumber)) {
          const previous = this.reviewsOfRun(author)
            .filter(
              (x) => x.id < reviewId && x.epoch === Number(row.epoch) && x.state === "reported",
            )
            .at(-1);
          const resolveListed = this.db.prepare(
            `UPDATE review_findings SET resolution = 'fixed', resolved_review_id = ?
             WHERE review_id = ? AND pos = ? AND resolution IS NULL`,
          );
          for (const o of openOlderFindings(
            this,
            { id: reviewId, repoId, prNumber, sha: row.sha as string, authorRunId: author },
            previous?.id ?? null,
          ).slice(0, OLDER_FINDINGS_MAX))
            resolveListed.run(reviewId, o.reviewId, o.finding.pos);
        }
      }
      this.appendAttempt(author, "review", r.at, {
        ...this.review(reviewId),
        findings: r.findings,
      });
      this.clearNoReportNotes(runId, r.at);
      if (r.qaReport && !this.putQaReport(r.qaReport))
        throw new Error("QA report snapshot already exists");
      recorded = true;
    }, true);
    return recorded;
  }

  /** The files the author changed since the previous reviewed sha, for tagging late findings. */
  setReviewChangedSince(reviewId: number, files: readonly string[]): void {
    this.db
      .prepare("UPDATE reviews SET changed_since = ? WHERE id = ?")
      .run(JSON.stringify(files), reviewId);
  }

  findingsOf(reviewId: number): StoredFinding[] {
    const rows = this.db
      .prepare("SELECT * FROM review_findings WHERE review_id = ? ORDER BY pos")
      .all(reviewId) as Row[];
    return rows.map((r) => ({
      pos: r.pos as number,
      severity: r.severity as StoredFinding["severity"],
      file: r.file as string,
      line: r.line as number,
      summary: r.summary as string,
      scenario: r.scenario as string,
      fix: r.fix as string,
      category: (r.category as StoredFinding["category"]) ?? undefined,
      state: r.state as StoredFinding["state"],
      late: r.late === 1,
      resolution: (r.resolution as StoredFinding["resolution"]) ?? undefined,
      resolvedReviewId: (r.resolved_review_id as number | null) ?? undefined,
    }));
  }

  /**
   * Findings of reviews in the requested window, plus unresolved findings on PRs still open now.
   * The latter protects an open card from losing its blocking review evidence as it ages.
   */
  qaFindings(since: number): QaFindingView[] {
    const rows = this.db
      .prepare(
        `SELECT f.*, v.repo_id, v.pr_number, v.round, v.ended_at FROM review_findings f
         JOIN reviews v ON v.id = f.review_id
         WHERE v.ended_at >= ? OR (f.resolution IS NULL AND EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'
         ))
         ORDER BY v.ended_at DESC, f.review_id DESC, f.pos`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      reviewId: r.review_id as number,
      authorRunId: r.author_run_id as string,
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      round: r.round as number,
      reviewEndedAt: r.ended_at as number | null,
      pos: r.pos as number,
      severity: r.severity as string,
      category: r.category as string | null,
      file: r.file as string,
      line: r.line as number,
      summary: r.summary as string,
      resolution: r.resolution as string | null,
      resolvedReviewId: r.resolved_review_id as number | null,
    }));
  }

  /** Completed review rounds in the requested window, plus the full history of open PRs. */
  qaReviewRounds(since: number): QaReviewRoundView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews v
         WHERE v.state = 'reported' AND v.ended_at IS NOT NULL AND (v.ended_at >= ? OR EXISTS (
           SELECT 1 FROM pull_requests p
           WHERE p.repo_id = v.repo_id AND p.number = v.pr_number AND p.state = 'open'
         ))
         ORDER BY v.ended_at DESC, v.id DESC`,
      )
      .all(since) as Row[];
    return rows.map((r) => ({
      reviewId: r.id as number,
      authorRunId: r.author_run_id as string,
      repoId: r.repo_id as string,
      prNumber: r.pr_number as number,
      round: r.round as number,
      sha: r.sha as string,
      verdict: JSON.parse(r.verdict as string) as QaReviewRoundView["verdict"],
      blocking: r.blocking as number,
      minor: r.minor as number,
      endedAt: r.ended_at as number,
      screenshots: this.reviewShots(r.id as number),
    }));
  }

  /** Records a screenshot RETRO took on a review's preview; `shotId` names its stored PNG. */
  addReviewShot(
    reviewId: number,
    shot: { shotId: string; label: string; width: number; theme: ReviewShotView["theme"] },
    at: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO review_shots (review_id, shot_id, label, width, theme, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(reviewId, shot.shotId, shot.label, shot.width, shot.theme, at);
  }

  /** The complete paths a PR changes, as GitHub's paged diff listing gave them. */
  prFilePaths(repoId: string, pr: number): string[] {
    return (
      this.db
        .prepare("SELECT path FROM pr_files WHERE repo_id = ? AND pr_number = ? ORDER BY path")
        .all(repoId, pr) as Row[]
    ).map((r) => r.path as string);
  }

  reviewShots(reviewId: number): ReviewShotView[] {
    return (
      this.db
        .prepare(
          "SELECT shot_id, label, width, theme, at FROM review_shots WHERE review_id = ? ORDER BY id",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      id: r.shot_id as string,
      label: r.label as string,
      width: r.width as number,
      theme: r.theme as ReviewShotView["theme"],
      at: r.at as number,
    }));
  }

  reviewChecks(reviewId: number): ReviewCheck[] {
    return (
      this.db
        .prepare(
          "SELECT check_id, result, note FROM review_checks WHERE review_id = ? ORDER BY check_id",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      check: r.check_id as ReviewCheck["check"],
      result: r.result as ReviewCheck["result"],
      ...(r.note === null ? {} : { note: r.note as string }),
    }));
  }

  reviewTests(reviewId: number): (Omit<ReportedTest, "file"> & { file: string | null })[] {
    return (
      this.db
        .prepare(
          "SELECT command, file, passed, failed, skipped, duration FROM review_tests WHERE review_id = ? ORDER BY id",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      command: r.command as string,
      file: r.file as string | null,
      passed: r.passed as number,
      failed: r.failed as number,
      skipped: r.skipped as number,
      duration: r.duration as number,
    }));
  }

  reviewResolutions(
    reviewId: number,
  ): { reviewId: number; pos: number; outcome: FindingResolution["outcome"] }[] {
    return (
      this.db
        .prepare(
          "SELECT prior_review_id, finding_pos, outcome FROM review_resolutions WHERE review_id = ? ORDER BY prior_review_id, finding_pos",
        )
        .all(reviewId) as Row[]
    ).map((r) => ({
      reviewId: r.prior_review_id as number,
      pos: r.finding_pos as number,
      outcome: r.outcome as FindingResolution["outcome"],
    }));
  }

  /** The run that performs the review, else null. */
  runOfReview(reviewId: number): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE review_id = ?").get(reviewId) as
      | Row
      | undefined;
    return row ? toRun(row) : null;
  }

  /** Reviews whose run has not ended although the review no longer needs it. */
  reviewsWithLiveRun(): ReviewRow[] {
    const rows = this.db
      .prepare(
        `SELECT reviews.* FROM reviews JOIN runs ON runs.id = reviews.run_id
         WHERE runs.ended_at IS NULL AND reviews.state NOT IN ('starting', 'running')
         ORDER BY reviews.id`,
      )
      .all() as Row[];
    return rows.map(toReview);
  }

  evidenceCount(runId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM run_evidence WHERE run_id = ?")
      .get(runId) as { n: number };
    return r.n;
  }

  /** Records a line under `key`; false (and nothing written) when the key is already there. */
  claimLine(key: string, line: SeatLine): boolean {
    let text = line.text;
    if (
      line.origin === "engine" &&
      key.startsWith(wakeKeyPrefix(line.runId)) &&
      text.startsWith(FLIGHT_WAKE_HEAD)
    ) {
      text = compactFlightWake(text);
    }
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO seat_lines (key, run_id, seat_id, origin, text, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, line.runId, line.seatId, line.origin, text, line.at);
    return r.changes === 1;
  }

  /** Frees a key, so its line can be claimed (and sent) again. */
  dropLine(key: string): void {
    this.db.prepare("DELETE FROM seat_lines WHERE key = ?").run(key);
  }

  /** The run's claimed line keys, each with the time it was claimed. */
  claimedKeys(runId: string): Record<string, number> {
    const rows = this.db.prepare("SELECT key, at FROM seat_lines WHERE run_id = ?").all(runId) as {
      key: string;
      at: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.at]));
  }

  /** When the engine last sent the run a line, else null. */
  lastEngineLineAt(runId: string): number | null {
    const r = this.db
      .prepare("SELECT MAX(at) AS at FROM seat_lines WHERE run_id = ? AND origin = ?")
      .get(runId, "engine" satisfies SeatLineOrigin) as { at: number | null };
    return r.at;
  }

  /** Records a loop event; false when its key is already recorded. */
  addLoopEvent(key: string, runId: string, text: string, at: number): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO loop_events (key, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(key, runId, text, at);
    if (r.changes === 1 && key === `${runId}:plan`) this.clearNoReportNotes(runId, at);
    return r.changes === 1;
  }

  /** The latest report_plan record for a ticket, attributed to the reporting run's seat. */
  ticketPlan(repoId: RepoId, ref: string): { by: AgentId; at: number; ref: string } | null {
    const row = this.db
      .prepare(
        `SELECT r.agent_id, e.at FROM loop_events e JOIN runs r ON r.id = e.run_id
         WHERE e.key = r.id || ':plan' AND r.repo_id = ? AND r.ticket = ?
         ORDER BY e.at DESC, e.key DESC LIMIT 1`,
      )
      .get(repoId, ref) as Row | undefined;
    return row ? { by: row.agent_id as AgentId, at: row.at as number, ref } : null;
  }

  /** Whether a `:plan` loop event exists for the run or any run on the same repo and ticket. */
  planLanded(run: Run): boolean {
    if (this.statement("SELECT 1 FROM loop_events WHERE key = ?").get(`${run.id}:plan`))
      return true;
    return (
      this.statement(
        `SELECT 1 FROM runs r JOIN loop_events e ON e.key = r.id || ':plan'
           WHERE r.repo_id = ? AND r.ticket = ? LIMIT 1`,
      ).get(run.repoId, run.ticket) !== undefined
    );
  }

  /** The run's loop events, oldest first. */
  loopEventsOfRun(runId: string): LoopEvent[] {
    const rows = this.statement("SELECT * FROM loop_events WHERE run_id = ? ORDER BY at, key").all(
      runId,
    ) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      runId: r.run_id as string,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  /** Records a hand-off whole up to COMMS_TEXT_MAX, then marks the stored copy's cut. */
  addComms(
    row: NewCommsRow,
    rate?: { since: number; limit: number },
    /** An identical message stored at or after this time is returned, flagged, not stored again. */
    repeatSince?: number,
    /** Server-resolved title for one internal context line accompanying an operator item send. */
    flightContextTitle?: string,
  ): (CommsRow & { repeat?: true }) | null {
    if (!Number.isFinite(row.at)) throw new Error("Comms messages need a time.");
    const label = row.label ?? "none";
    const text = cutCommsText(row.text);
    const replyTo =
      row.replyTo === undefined || row.replyTo === null ? null : commsMessageNumber(row.replyTo);
    if (row.replyTo !== undefined && row.replyTo !== null && replyTo === null)
      throw new Error("Invalid Comms message ID.");
    let id: number | null = null;
    let repeat = false;
    this.transaction(() => {
      if (repeatSince !== undefined) {
        const same = this.db
          .prepare(
            `SELECT id FROM comms WHERE from_id = ? AND to_id = ? AND text = ? AND at >= ?
               AND ticket IS ? AND label IS ? AND reply_to IS ? AND target_run_id IS ? AND item_key IS ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(
            row.from,
            row.to,
            text,
            repeatSince,
            row.ticket,
            label,
            replyTo,
            row.targetRunId ?? null,
            row.itemKey ?? null,
          ) as { id: number } | undefined;
        if (same !== undefined) {
          id = same.id;
          repeat = true;
          this.db
            .prepare("INSERT INTO comms_repeats (at, from_id, to_id, message_id) VALUES (?,?,?,?)")
            .run(row.at, row.from, row.to, same.id);
          return;
        }
      }
      if (rate !== undefined) {
        const count = this.db
          .prepare("SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND at >= ?")
          .get(row.from, rate.since) as { n: number };
        if (count.n >= rate.limit) return;
      }
      id = this.insertComms({ ...row, label }, text, replyTo);
      if (
        row.from === COMMS_CAPCOM &&
        row.itemKey !== undefined &&
        flightContextTitle !== undefined
      ) {
        const context: NewCommsRow = {
          from: COMMS_MC,
          to: row.to,
          senderKind: "hub",
          at: row.at,
          ticket: row.ticket,
          text: `[Mission Control] Needs-you context ${JSON.stringify({
            messageId: `comms:${id}`,
            itemKey: row.itemKey,
            title: flightContextTitle,
          })}`,
        };
        this.insertComms(context, cutCommsText(context.text), null);
      }
      this.raiseChatterNote(row);
    }, true);
    const stored = id === null ? null : this.commsMessage(`comms:${id}`);
    return stored !== null && repeat ? { ...stored, repeat: true } : stored;
  }

  /** How many exact repeats of a stored message were turned away at or after `since`. */
  commsRepeatCount(since: number): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM comms_repeats WHERE at >= ?").get(since) as {
        n: number;
      }
    ).n;
  }

  /** Opens one durable FLIGHT-facing note when a pair first crosses the rolling chatter limit. */
  private raiseChatterNote(row: NewCommsRow): void {
    if (
      row.ticket === null ||
      row.to === COMMS_CAPCOM ||
      row.to === COMMS_CREW ||
      row.to === COMMS_MC ||
      row.from === COMMS_CAPCOM ||
      row.from === COMMS_CREW ||
      row.from === COMMS_MC ||
      row.from === COMMS_CONTROLLER ||
      row.from === row.to
    )
      return;
    const pair = row.from < row.to ? [row.from, row.to] : [row.to, row.from];
    const crossed = this.commsChatter(row.at - COMMS_CHATTER_WINDOW_MS, row.at).some(
      (item) => item.ticket === row.ticket && item.from === pair[0] && item.to === pair[1],
    );
    if (!crossed) return;
    this.raiseNote({
      key: `${CHATTER_NOTE_PREFIX}${row.ticket}:${pair[0]}:${pair[1]}`,
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: row.ticket.slice(0, row.ticket.lastIndexOf("#")),
      text: `${pair[0]} and ${pair[1]} exceeded ${COMMS_CHATTER_ROUNDS} rounds on ${row.ticket}.`,
      at: row.at,
    });
  }

  private insertComms(row: NewCommsRow, text: string, replyTo: number | null): number {
    // The sender's name must match its kind: CAPCOM is only ever the operator, and the hub is MC.
    if (row.from === COMMS_CAPCOM && row.senderKind !== undefined && row.senderKind !== "operator")
      throw new Error("Only the operator sends as CAPCOM.");
    if (row.senderKind === "hub" && row.from !== COMMS_MC)
      throw new Error("A hub message is sent as MC.");
    const inserted = this.db
      .prepare(
        "INSERT INTO comms (at, from_id, to_id, ticket, text, label, ref, reply_to, target_run_id, from_run_id, pr, sender_kind, kind, item_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.at,
        row.from,
        row.to,
        row.ticket,
        text,
        row.label ?? null,
        row.ref ?? null,
        replyTo,
        row.targetRunId ?? null,
        row.fromRunId ?? null,
        row.pr ?? null,
        row.senderKind ?? null,
        row.kind ?? (row.senderKind === "hub" ? COMMS_NOTICE : null),
        row.itemKey ?? null,
      );
    const id = Number(inserted.lastInsertRowid);
    const mention = this.db.prepare(
      "INSERT OR IGNORE INTO comms_mentions (message_id, mentioned_id) VALUES (?, ?)",
    );
    for (const target of row.mentions ?? []) mention.run(id, target);
    return id;
  }

  private commsRow(r: Row, knownMentions?: string[]): CommsRow {
    const id = Number(r.id);
    const mentions =
      knownMentions ??
      this.db
        .prepare(
          "SELECT mentioned_id FROM comms_mentions WHERE message_id = ? ORDER BY mentioned_id",
        )
        .all(id)
        .map((m) => m.mentioned_id as string);
    return {
      id: `comms:${id}`,
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
      label: r.label as CommsLabel | null,
      ref: r.ref as string | null,
      replyTo: r.reply_to == null ? null : `comms:${r.reply_to}`,
      mentions,
      deliveredAt: (r.delivered_at as number | null | undefined) ?? null,
      senderKind: (r.sender_kind as CommsSenderKind | null) ?? null,
      kind: (r.kind as CommsKind | null) ?? null,
      ...(typeof r.item_key === "string" ? { itemKey: r.item_key } : {}),
    };
  }

  /** Bound mention reads per snapshot; retain no message or mention cache between calls. */
  private commsRows(rows: Row[]): CommsRow[] {
    const mentions = new Map<number, string[]>();
    // Stay below even SQLite's older 999-variable limit if the snapshot limit grows.
    const batchSize = 400;
    for (let start = 0; start < rows.length; start += batchSize) {
      const ids = rows.slice(start, start + batchSize).map((row) => Number(row.id));
      const found = this.db
        .prepare(
          `SELECT message_id, mentioned_id FROM comms_mentions WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, mentioned_id`,
        )
        .all(...ids);
      for (const row of found) {
        const id = Number(row.message_id);
        const names = mentions.get(id) ?? [];
        names.push(row.mentioned_id as string);
        mentions.set(id, names);
      }
    }
    return rows.map((row) => this.commsRow(row, mentions.get(Number(row.id))?.slice() ?? []));
  }

  /** Records that the recipient took a message; the first time wins. */
  markCommsDelivered(id: string, at: number): void {
    const n = commsMessageNumber(id);
    if (n !== null)
      this.db
        .prepare("UPDATE comms SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL")
        .run(at, n);
  }

  /**
   * Stores the choice unless this brief already has one. Returns the stored row and whether this
   * call made it, so a second click gets the first receipt.
   */
  claimChoice(c: QuestionChoiceRow): { row: QuestionChoiceRow; fresh: boolean } {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO question_choices
           (key, brief_at, option_id, label, answer, question, ticket, target, target_kind, message_id, chosen_at, chosen_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.key,
        c.briefAt,
        c.optionId,
        c.label,
        c.answer,
        c.question,
        c.ticket,
        c.target,
        c.targetKind,
        c.messageId === null ? null : commsMessageNumber(c.messageId),
        c.chosenAt,
        c.chosenBy,
      );
    const row = this.choice(c.key, c.briefAt);
    if (row === null) throw new Error("Choice was not stored.");
    return { row, fresh: Number(r.changes) > 0 };
  }

  /** Names the message that carries a claimed choice's answer. */
  setChoiceMessage(key: string, briefAt: number, messageId: string): void {
    const n = commsMessageNumber(messageId);
    if (n !== null)
      this.db
        .prepare("UPDATE question_choices SET message_id = ? WHERE key = ? AND brief_at = ?")
        .run(n, key, briefAt);
  }

  /**
   * Whether a Comms message is the hub-built answer to a choice. A reader that counts messages the
   * operator owes a reply to leaves these out: they answer, they do not ask.
   */
  isChoiceAnswer(messageId: string): boolean {
    const n = commsMessageNumber(messageId);
    return (
      n !== null &&
      this.db.prepare("SELECT 1 FROM question_choices WHERE message_id = ?").get(n) !== undefined
    );
  }

  /** Drops a claim whose answer could not be sent. */
  releaseChoice(key: string, briefAt: number): void {
    this.db
      .prepare("DELETE FROM question_choices WHERE key = ? AND brief_at = ?")
      .run(key, briefAt);
  }

  private choiceOf(r: Row): QuestionChoiceRow {
    return {
      key: r.key as string,
      briefAt: r.brief_at as number,
      optionId: r.option_id as string,
      label: r.label as string,
      answer: r.answer as string,
      question: r.question as string,
      ticket: (r.ticket as string | null) ?? null,
      target: r.target as string,
      targetKind: r.target_kind as ChoiceTargetKind,
      messageId: r.message_id == null ? null : `comms:${r.message_id}`,
      chosenBy: (r.chosen_by as string | null) ?? "the operator",
      chosenAt: r.chosen_at as number,
    };
  }

  /** The choice made on one brief of a key; null when none. */
  choice(key: string, briefAt: number): QuestionChoiceRow | null {
    const r = this.db
      .prepare("SELECT * FROM question_choices WHERE key = ? AND brief_at = ?")
      .get(key, briefAt) as Row | undefined;
    return r ? this.choiceOf(r) : null;
  }

  /** The newest choice on a key; null when none. */
  latestChoice(key: string): QuestionChoiceRow | null {
    const r = this.db
      .prepare("SELECT * FROM question_choices WHERE key = ? ORDER BY chosen_at DESC LIMIT 1")
      .get(key) as Row | undefined;
    return r ? this.choiceOf(r) : null;
  }

  /** The choices made on a ticket, newest first. */
  choicesOnTicket(ticket: string, limit: number): QuestionChoiceRow[] {
    return (
      this.db
        .prepare("SELECT * FROM question_choices WHERE ticket = ? ORDER BY chosen_at DESC LIMIT ?")
        .all(ticket, limit) as Row[]
    ).map((r) => this.choiceOf(r));
  }

  markCommsWakeFailed(id: string, at: number): void {
    const n = commsMessageNumber(id);
    if (n !== null) this.db.prepare("UPDATE comms SET wake_failed_at = ? WHERE id = ?").run(at, n);
  }
  clearCommsWakeFailed(id: string): void {
    const n = commsMessageNumber(id);
    if (n !== null) this.db.prepare("UPDATE comms SET wake_failed_at = NULL WHERE id = ?").run(n);
  }
  commsWakeFailed(id: string): boolean {
    const n = commsMessageNumber(id);
    return (
      n !== null &&
      this.db.prepare("SELECT wake_failed_at FROM comms WHERE id = ?").get(n)?.wake_failed_at !=
        null
    );
  }

  /** The run and PR the hub stamped on a message; nulls for a message it did not stamp. */
  commsStamp(id: string): { runId: string | null; pr: number | null } {
    const n = commsMessageNumber(id);
    const r =
      n === null
        ? undefined
        : (this.db.prepare("SELECT from_run_id, pr FROM comms WHERE id = ?").get(n) as
            | Row
            | undefined);
    return {
      runId: (r?.from_run_id as string | null | undefined) ?? null,
      pr: (r?.pr as number | null | undefined) ?? null,
    };
  }

  commsMessage(id: string): CommsRow | null {
    const n = commsMessageNumber(id);
    if (n === null) return null;
    return this.commsMessageByNumber(n);
  }

  /** Fixed delivery target, otherwise the sender's run that was open when it wrote the line. */
  commsRun(id: string, inferSender = true): Run | null {
    const number = commsMessageNumber(id);
    if (number === null) return null;
    const source = this.statement("SELECT target_run_id, from_id, at FROM comms WHERE id = ?").get(
      number,
    ) as Row | undefined;
    if (!source) return null;
    if (source.target_run_id !== null) return this.run(source.target_run_id as string);
    if (!inferSender) return null;
    const row = this.statement(`SELECT * FROM runs WHERE agent_id = ? AND started_at <= ?
      AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC, seq DESC, id DESC LIMIT 1`).get(
      source.from_id as string,
      source.at as number,
      source.at as number,
    ) as Row | undefined;
    return row ? toRun(row) : null;
  }

  private commsMessageByNumber(id: number): CommsRow | null {
    const row = this.db.prepare("SELECT * FROM comms WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : this.commsRow(row);
  }

  addCommsReaction(
    messageId: string,
    actor: string,
    reaction: CommsReactionKind,
    reason: string | undefined,
    at: number,
  ): CommsReaction | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const message = this.commsMessageByNumber(id);
    if (message === null) return null;
    this.db
      .prepare(`INSERT INTO comms_reactions (message_id, actor_id, reaction, reason, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id, actor_id) DO UPDATE SET reaction=excluded.reaction, reason=excluded.reason, at=excluded.at`)
      .run(id, actor, reaction, reason ?? null, at);
    return { messageId: message.id, actor, reaction, reason: reason ?? null, at };
  }

  setCommsPinned(messageId: string, pinned: boolean, actor: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    const message = this.commsMessageByNumber(id);
    if (message === null) return false;
    if (pinned)
      this.db
        .prepare(
          "INSERT INTO comms_pins (message_id, pinned_by, pinned_at) VALUES (?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET pinned_by=excluded.pinned_by, pinned_at=excluded.pinned_at",
        )
        .run(id, actor, at);
    else this.db.prepare("DELETE FROM comms_pins WHERE message_id = ?").run(id);
    return true;
  }

  commsPins(): CommsRow[] {
    return (
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_pins p ON p.message_id=c.id ORDER BY p.pinned_at DESC",
        )
        .all() as Row[]
    ).map((r) => this.commsRow(r));
  }
  commsReactions(messageId: string): CommsReaction[] {
    const id = commsMessageNumber(messageId);
    if (id === null) return [];
    return this.db
      .prepare(
        "SELECT actor_id, reaction, reason, at FROM comms_reactions WHERE message_id=? ORDER BY at,actor_id",
      )
      .all(id)
      .map((r) => ({
        messageId: `comms:${id}`,
        actor: r.actor_id as string,
        reaction: r.reaction as CommsReactionKind,
        reason: r.reason as string | null,
        at: r.at as number,
      }));
  }
  commsSettlement(messageId: string): CommsSettlement | null {
    const id = commsMessageNumber(messageId);
    if (id === null) return null;
    const row = this.db
      .prepare("SELECT settled_by, reason, at FROM comms_settlements WHERE message_id=?")
      .get(id) as Row | undefined;
    return row === undefined
      ? null
      : {
          messageId,
          settledBy: row.settled_by as string,
          reason: row.reason as string,
          at: row.at as number,
        };
  }
  settleCommsItem(messageId: string, settledBy: string, reason: string, at: number): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null || this.commsMessageByNumber(id) === null) return false;
    this.db
      .prepare(
        "INSERT INTO comms_settlements (message_id, settled_by, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING",
      )
      .run(id, settledBy, reason, at);
    return true;
  }
  commsMentions(target: string): CommsRow[] {
    return (
      this.db
        .prepare(
          "SELECT c.* FROM comms c JOIN comms_mentions m ON m.message_id=c.id WHERE m.mentioned_id=? ORDER BY c.at DESC,c.id DESC",
        )
        .all(target) as Row[]
    ).map((r) => this.commsRow(r));
  }
  markCommsMentionsSeen(target: string, ids: string[], at: number): void {
    const q = this.db.prepare(
      "UPDATE comms_mentions SET seen_at=? WHERE mentioned_id=? AND message_id=?",
    );
    for (const id of ids) {
      const number = commsMessageNumber(id);
      if (number !== null) q.run(at, target, number);
    }
  }
  commsMentionSeen(target: string, id: string): boolean {
    const number = commsMessageNumber(id);
    if (number === null) return false;
    return (
      (
        this.db
          .prepare("SELECT seen_at FROM comms_mentions WHERE mentioned_id=? AND message_id=?")
          .get(target, number) as { seen_at: number | null } | undefined
      )?.seen_at !== null
    );
  }
  commsForCrew(): CommsRow[] {
    return this.commsForWhere("to_id = 'crew'");
  }
  /** Seat-side reads include only general Comms and rows targeted at its live run. */
  commsForCrewRun(runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "to_id = 'crew'");
  }
  commsForAgent(id: string, contact?: string): CommsRow[] {
    return contact === undefined
      ? this.commsForWhere("from_id=? OR to_id=?", id, id)
      : this.commsForPair(id, contact);
  }
  commsForAgentRun(id: string, runId: string): CommsRow[] {
    return this.commsForRunWhere(runId, "from_id=? OR to_id=?", id, id);
  }
  commsInbox(id: string): CommsRow[] {
    return this.commsForWhere(
      `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      id,
      id,
      id,
    );
  }
  commsInboxRun(id: string, runId: string): CommsRow[] {
    return this.commsForWhere(
      `(
        (target_run_id IS NULL OR target_run_id = ?)
        AND id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        )
      ) OR id IN (SELECT message_id FROM comms_pins)`,
      runId,
      id,
      id,
      id,
    );
  }
  commsForPair(a: string, b: string): CommsRow[] {
    return this.commsForWhere("(from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", a, b, b, a);
  }

  /** Lightweight retained transcript sources; conversation paging is not limited to recent runs. */
  flightConversationRuns(
    agentId: string,
  ): Pick<Run, "id" | "startedAt" | "endedAt" | "transcriptPath" | "vendor" | "ticket">[] {
    const rows = this.db
      .prepare(`SELECT id, started_at, ended_at, transcript_path, vendor, ticket FROM runs
      WHERE agent_id = ? ORDER BY COALESCE(ended_at, 9223372036854775807) DESC, started_at DESC, seq DESC`)
      .all(agentId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number | null,
      transcriptPath: r.transcript_path as string,
      ticket: r.ticket as string | null,
      ...(r.vendor ? { vendor: r.vendor as Run["vendor"] } : {}),
    }));
  }

  private flightConversationScope(
    flightId: string,
    seats: readonly string[],
    hideNotices = false,
  ): { sql: string; args: SQLInputValue[] } {
    const targets = [...new Set([flightId, ...seats])];
    // The hub's notices to FLIGHT belong to its conversation; its internal context rows do not.
    return {
      sql: `(((c.from_id = ? AND c.to_id = ?) OR (c.from_id = ? AND c.to_id = ?))
      OR (c.from_id = ? AND q.target IN (${targets.map(() => "?").join(",")}))
      OR (c.from_id = ? AND c.to_id = ? AND c.kind = ?))
      AND (c.sender_kind IS NOT 'hub' OR c.kind = ?)
      AND LTRIM(c.text, char(9) || char(10) || char(13) || ' ') NOT LIKE '[Mission Control]%'${
        hideNotices ? " AND c.kind IS NOT ?" : ""
      }`,
      args: [
        COMMS_CAPCOM,
        flightId,
        flightId,
        COMMS_CAPCOM,
        COMMS_CAPCOM,
        ...targets,
        COMMS_MC,
        flightId,
        COMMS_NOTICE,
        COMMS_NOTICE,
        ...(hideNotices ? [COMMS_NOTICE] : []),
      ],
    };
  }

  /** A choice is projected from its durable receipt, never inferred from its rendered text. */
  flightConversationStored(
    flightId: string,
    seats: readonly string[],
    limit: number,
    before?: { at: number; id: number },
    exactId?: string,
    hideNotices = false,
  ): (CommsRow & { choice?: { label: string } })[] {
    const scope = this.flightConversationScope(flightId, seats, hideNotices);
    const id = exactId === undefined ? null : commsMessageNumber(exactId);
    if (exactId !== undefined && id === null) return [];
    const rows = this.db
      .prepare(`SELECT c.*, q.key AS choice_key, q.label AS choice_label FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql}${id === null ? "" : " AND c.id = ?"}${before ? " AND (c.at, c.id) < (?, ?)" : ""}
      ORDER BY c.at DESC, c.id DESC LIMIT ?`)
      .all(
        ...scope.args,
        ...(id === null ? [] : [id]),
        ...(before ? [before.at, before.id] : []),
        limit,
      ) as Row[];
    return rows.reverse().map((r) => ({
      ...this.commsRow(r),
      ...(typeof r.choice_label === "string"
        ? { choice: { label: r.choice_label }, itemKey: (r.item_key ?? r.choice_key) as string }
        : {}),
    }));
  }

  latestFlightStoredReplyAt(flightId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(at) AS at FROM comms WHERE from_id = ? AND to_id = ? AND sender_kind IS NOT 'hub'
      AND LTRIM(text, char(9) || char(10) || char(13) || ' ') NOT LIKE '[Mission Control]%'`)
      .get(flightId, COMMS_CAPCOM) as Row;
    return row.at as number | null;
  }

  flightConversationUnread(
    flightId: string,
    seats: readonly string[],
    cursor: string | null,
    bound?: { at: number; source: string; offset: number },
  ): number {
    const scope = this.flightConversationScope(flightId, seats);
    const after = bound
      ? bound.source === "comms"
        ? "(c.at, c.id) > (?, ?)"
        : "c.at > ?"
      : "c.id > ?";
    const args = bound
      ? bound.source === "comms"
        ? [bound.at, bound.offset]
        : [bound.at]
      : [cursor ? (commsMessageNumber(cursor) ?? 0) : 0];
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql} AND c.kind IS NOT ? AND ${after}`)
      .get(...scope.args, COMMS_NOTICE, ...args) as Row;
    return row.n as number;
  }

  flightConversationStoredReadThrough(
    flightId: string,
    seats: readonly string[],
    bound: { at: number; source: string; offset: number },
  ): number | null {
    const scope = this.flightConversationScope(flightId, seats);
    const through = bound.source === "comms" ? "(c.at, c.id) <= (?, ?)" : "c.at <= ?";
    const row = this.db
      .prepare(`SELECT MAX(c.id) AS id FROM comms c
      LEFT JOIN question_choices q ON q.rowid = (SELECT rowid FROM question_choices x WHERE x.message_id = c.id ORDER BY x.chosen_at DESC, x.key, x.brief_at DESC LIMIT 1)
      WHERE ${scope.sql} AND ${through}`)
      .get(
        ...scope.args,
        ...[bound.at, ...(bound.source === "comms" ? [bound.offset] : [])],
      ) as Row;
    return row.id as number | null;
  }
  private commsScopeWhere(scope: CommsReadScope): { where: string; args: SQLInputValue[] } {
    if ("crew" in scope) return { where: "to_id = 'crew'", args: [] };
    if ("pair" in scope) {
      const [a, b] = scope.pair;
      return { where: "((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))", args: [a, b, b, a] };
    }
    if ("agent" in scope)
      return { where: "(from_id=? OR to_id=?)", args: [scope.agent, scope.agent] };
    const id = scope.inbox;
    return {
      where: `id IN (
        SELECT id FROM comms WHERE to_id=?
        UNION
        SELECT message_id FROM comms_mentions WHERE mentioned_id=?
        UNION
        SELECT reply.id FROM comms reply JOIN comms original ON reply.reply_to=original.id WHERE original.from_id=?
        UNION
        SELECT message_id FROM comms_pins
      )`,
      args: [id, id, id],
    };
  }
  /**
   * The newest `limit` messages of a scope, oldest first, strictly older than `before` when given.
   * `hasMore` says older ones remain, so the HUD can offer "load older".
   */
  commsPage(
    scope: CommsReadScope,
    limit: number,
    before?: string,
    recentSince?: number,
    hideNotices = false,
  ): { rows: CommsRow[]; hasMore: boolean } {
    const { where, args } = this.commsRecentScopeWhere(scope, recentSince, hideNotices);
    const beforeId = before === undefined ? null : commsMessageNumber(before);
    const rows = (
      this.db
        .prepare(
          `SELECT * FROM comms WHERE ${where}${
            beforeId === null ? "" : " AND (at, id) < (SELECT at, id FROM comms WHERE id = ?)"
          } ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(...args, ...(beforeId === null ? [] : [beforeId]), limit + 1) as Row[]
    ).map((r) => this.commsRow(r));
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), hasMore };
  }
  /** How many messages a scope holds, and how many of them come after the read cursor. */
  commsCounts(
    scope: CommsReadScope,
    cursor: string | null,
    recentSince?: number,
    hideNotices = false,
  ): { count: number; unread: number } {
    const { where, args } = this.commsRecentScopeWhere(scope, recentSince, hideNotices);
    const offset = cursor === null ? 0 : (commsMessageNumber(cursor) ?? 0);
    // a notice is never unread, shown or not
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(id > ? AND kind IS NOT ?), 0) AS unread
         FROM comms WHERE ${where}`,
      )
      .get(offset, COMMS_NOTICE, ...args) as { count: number; unread: number };
    return { count: r.count, unread: r.unread };
  }
  private commsRecentScopeWhere(scope: CommsReadScope, since?: number, hideNotices = false) {
    const scoped = this.commsScopeWhere(scope);
    const base = hideNotices
      ? { where: `(${scoped.where}) AND kind IS NOT ?`, args: [...scoped.args, COMMS_NOTICE] }
      : scoped;
    if (since === undefined) return base;
    return {
      where: `(${base.where}) AND at >= ? AND (
        (target_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.id = comms.target_run_id AND r.ended_at IS NULL))
        OR (target_run_id IS NULL AND (NOT EXISTS (SELECT 1 FROM runs r WHERE r.agent_id = comms.from_id)
        OR (SELECT r.ended_at IS NULL FROM runs r WHERE r.agent_id = comms.from_id AND
          r.started_at <= comms.at AND (r.ended_at IS NULL OR r.ended_at >= comms.at)
          ORDER BY r.started_at DESC, r.seq DESC, r.id DESC LIMIT 1) = 1))
      )`,
      args: [...base.args, since],
    };
  }
  /** Everyone `id` has exchanged messages with, in first-contact order. */
  commsContactIds(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS contact
          FROM comms WHERE from_id=? OR to_id=? GROUP BY contact ORDER BY MIN(id)`,
        )
        .all(id, id, id) as { contact: string }[]
    ).map((r) => r.contact);
  }
  commsForRefs(refs: string[]): CommsRow[] {
    if (!refs.length) return [];
    return this.commsForWhere(`ref IN (${refs.map(() => "?").join(",")})`, ...refs);
  }
  commsForTicket(
    ref: string,
    ticketContext?: string,
  ): {
    ref: string;
    linkedPr: string | null;
    repoId: string | null;
    rows: CommsRow[];
  } {
    const prNumber = ref.startsWith("PR ") ? Number(ref.slice(3)) : null;
    let issueNumber = ref.startsWith("#") ? Number(ref.slice(1)) : null;
    const qualified = ticketContext?.match(/^(.+)#(\d+)$/);
    // A #n link may only carry its own ticket. PR links keep their PR number and use the ticket
    // solely as repository context.
    const scopedTicket =
      qualified && (issueNumber === null || Number(qualified[2]) === issueNumber)
        ? ticketContext
        : undefined;
    const scopedRepoId = scopedTicket === undefined ? undefined : (qualified?.[1] as string);
    let linkedPr: string | null = null;
    let linkedRows: { number: number; repoId: string; ticket: string | null }[] = [];
    if (prNumber !== null) {
      linkedRows = this.db
        .prepare(
          `SELECT number, repo_id, ticket FROM pull_requests WHERE number=?${
            scopedRepoId === undefined ? "" : " AND repo_id=?"
          } ORDER BY updated_at DESC`,
        )
        .all(prNumber, ...(scopedRepoId === undefined ? [] : [scopedRepoId]))
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      const row = linkedRows[0];
      const match = row?.ticket?.match(/#(\d+)$/);
      issueNumber = match === null || match === undefined ? null : Number(match[1]);
      linkedPr = `PR ${prNumber}`;
    } else if (issueNumber !== null) {
      linkedRows = this.db
        .prepare(
          scopedRepoId === undefined
            ? "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket GLOB ? ORDER BY updated_at DESC"
            : "SELECT number, repo_id, ticket FROM pull_requests WHERE ticket=? AND repo_id=? ORDER BY updated_at DESC",
        )
        .all(
          ...(scopedRepoId === undefined
            ? [`*#${issueNumber}`]
            : [scopedTicket as string, scopedRepoId]),
        )
        .map((row) => ({
          number: row.number as number,
          repoId: row.repo_id as string,
          ticket: row.ticket as string | null,
        }));
      linkedPr = linkedRows[0] === undefined ? null : `PR ${linkedRows[0].number}`;
    }
    const resolvedRef = issueNumber === null ? ref : `#${issueNumber}`;
    const refs = linkedPr === null ? [resolvedRef] : [resolvedRef, linkedPr];
    const predicates = [`ref IN (${refs.map(() => "?").join(",")})`, "text LIKE ?"];
    const args: SQLInputValue[] = [...refs, `%${resolvedRef}%`];
    if (linkedPr !== null) {
      predicates.push("text LIKE ?");
      args.push(`%${linkedPr}%`);
    }
    const ticketPredicate =
      scopedTicket === undefined
        ? ""
        : prNumber === null
          ? " AND ticket=?"
          : " AND substr(ticket, 1, length(?))=?";
    const ticketArgs: SQLInputValue[] =
      scopedTicket === undefined
        ? []
        : prNumber === null
          ? [scopedTicket]
          : [`${scopedRepoId}#`, `${scopedRepoId}#`];
    const rows = this.commsForWhere(
      `(${predicates.join(" OR ")})${ticketPredicate}`,
      ...args,
      ...ticketArgs,
    ).filter((row) => {
      if (refs.includes(row.ref ?? "")) return true;
      return refs.some((candidate) =>
        new RegExp(`(^|[^A-Za-z0-9])${candidate.replace("#", "\\#")}(?=$|[^A-Za-z0-9])`).test(
          row.text,
        ),
      );
    });
    const repoIds = new Set<string>();
    const repoFor = (ticket: string | null): string | null => {
      const match = ticket?.match(/^(.+)#(\d+)$/);
      return match?.[2] === String(issueNumber) ? (match[1] ?? null) : null;
    };
    // A clicked hub-set ticket is authoritative. Otherwise the linked PR's repo wins; without
    // either, only rows explicitly tagged with this ref count. A mere text mention never attributes.
    if (scopedRepoId !== undefined) repoIds.add(scopedRepoId);
    else for (const row of linkedRows) repoIds.add(row.repoId);
    if (repoIds.size === 0) {
      for (const row of rows) {
        if (!refs.includes(row.ref ?? "")) continue;
        const repoId = repoFor(row.ticket);
        if (repoId !== null) repoIds.add(repoId);
      }
    }
    return {
      ref: resolvedRef,
      linkedPr,
      repoId: repoIds.size === 1 ? [...repoIds][0] : null,
      rows,
    };
  }
  commsLinkedPr(ref: string): string | null {
    const ticket = Number(ref.replace(/^(?:#|PR )/, ""));
    const row = this.db
      .prepare("SELECT number FROM pull_requests WHERE ticket=? ORDER BY number DESC LIMIT 1")
      .get(ticket) as { number: number } | undefined;
    return row === undefined ? null : `PR ${row.number}`;
  }
  private commsForWhere(where: string, ...args: SQLInputValue[]): CommsRow[] {
    return (
      this.db.prepare(`SELECT * FROM comms WHERE ${where} ORDER BY at,id`).all(...args) as Row[]
    ).map((r) => this.commsRow(r));
  }
  private commsForRunWhere(runId: string, where: string, ...args: SQLInputValue[]): CommsRow[] {
    return this.commsForWhere(
      `(${where}) AND (target_run_id IS NULL OR target_run_id = ?)`,
      ...args,
      runId,
    );
  }
  /**
   * Direct-link counts since `since`, each with its newest message (id, time and the first
   * COMMS_LINK_PREVIEW characters) so the Comms graph can show it and spot a new one.
   */
  commsLinkCounts(since: number, until = Date.now()): CommsLinkCount[] {
    const rows = this.db
      .prepare(
        `SELECT c.from_id AS 'from', c.to_id AS 'to', g.count AS count, c.id AS lastId,
          c.at AS lastAt, substr(c.text, 1, ?) AS lastText
        FROM (SELECT from_id, to_id, COUNT(*) AS count, MAX(id) AS last FROM comms WHERE at>=?
          GROUP BY from_id,to_id) g
        JOIN comms c ON c.id = g.last
        ORDER BY c.from_id, c.to_id`,
      )
      .all(COMMS_LINK_PREVIEW, since) as Row[];
    return rows.map((r) => ({
      from: r.from as string,
      to: r.to as string,
      count: r.count as number,
      lastId: `comms:${r.lastId as number}`,
      lastAt: r.lastAt as number,
      lastText: r.lastText as string,
      tokens: this.commsTokenTotal(r.from as string, r.to as string, null, since, until),
    }));
  }
  /** Hourly direct-link counts for the Comms Traffic chart. */
  commsHourlyLinkCounts(
    since: number,
  ): { hour: number; from: string; to: string; count: number }[] {
    return this.db
      .prepare(
        "SELECT (at / 3600000) * 3600000 AS hour, from_id AS 'from', to_id AS 'to', COUNT(*) AS count FROM comms WHERE at>=? GROUP BY hour, from_id, to_id ORDER BY hour, from_id, to_id",
      )
      .all(since) as { hour: number; from: string; to: string; count: number }[];
  }
  /** Back-and-forth pairs on one ticket; a round needs a message in each direction. */
  commsChatter(
    since: number,
    until = Number.MAX_SAFE_INTEGER,
    flightId?: string,
  ): {
    from: string;
    to: string;
    ticket: string;
    rounds: number;
    tokens: number;
    flightSteppedInAt: number | null;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT "from", "to", ticket, first_at, last_at,
          CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END AS rounds
        FROM (
          SELECT CASE WHEN from_id < to_id THEN from_id ELSE to_id END AS 'from',
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END AS 'to', ticket,
            SUM(CASE WHEN from_id < to_id THEN 1 ELSE 0 END) AS forward_count,
            SUM(CASE WHEN from_id > to_id THEN 1 ELSE 0 END) AS reverse_count,
            MIN(at) AS first_at, MAX(at) AS last_at
          FROM comms
          WHERE at >= ? AND at <= ? AND ticket IS NOT NULL
            AND from_id NOT IN (?, ?, ?) AND to_id NOT IN (?, ?, ?) AND from_id != to_id
          GROUP BY ticket, CASE WHEN from_id < to_id THEN from_id ELSE to_id END,
            CASE WHEN from_id < to_id THEN to_id ELSE from_id END
        )
        WHERE CASE WHEN forward_count < reverse_count THEN forward_count ELSE reverse_count END > ?
        ORDER BY rounds DESC, ticket, "from", "to"`,
      )
      .all(
        since,
        until,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CAPCOM,
        COMMS_MC,
        COMMS_CREW,
        COMMS_CHATTER_ROUNDS,
      ) as Row[];
    return rows.map((row) => {
      const from = row.from as string;
      const to = row.to as string;
      const ticket = row.ticket as string;
      const thresholdAt = this.chatterThresholdAt(from, to, ticket, since, until);
      return {
        from,
        to,
        ticket,
        rounds: row.rounds as number,
        tokens: this.commsTokenTotal(
          from,
          to,
          ticket,
          row.first_at as number,
          row.last_at as number,
        ),
        flightSteppedInAt:
          flightId === undefined || thresholdAt === null
            ? null
            : ((
                this.db
                  .prepare(
                    "SELECT MIN(at) AS at FROM comms WHERE from_id = ? AND to_id IN (?, ?) AND ticket = ? AND at >= ? AND at <= ?",
                  )
                  .get(flightId, from, to, ticket, thresholdAt, until) as { at: number | null }
              ).at ?? null),
      };
    });
  }

  /** The message which first completes the over-limit reciprocal exchange in this rolling window. */
  private chatterThresholdAt(
    from: string,
    to: string,
    ticket: string,
    since: number,
    until: number,
  ): number | null {
    const messages = this.db
      .prepare(
        `SELECT at, from_id FROM comms WHERE ticket = ? AND at >= ? AND at <= ?
         AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) ORDER BY at, id`,
      )
      .all(ticket, since, until, from, to, to, from) as { at: number; from_id: string }[];
    let forward = 0;
    let reverse = 0;
    for (const message of messages) {
      if (message.from_id === from) forward++;
      else reverse++;
      if (Math.min(forward, reverse) > COMMS_CHATTER_ROUNDS) return message.at;
    }
    return null;
  }

  /** Tokens consumed by either end's runs overlapping a Comms link's observed window. */
  private commsTokenTotal(
    from: string,
    to: string,
    ticket: string | null,
    since: number,
    until: number,
  ): number {
    const rows = this.db
      .prepare(
        `SELECT tokens FROM runs WHERE agent_id IN (?, ?) AND started_at <= ?
         AND (ended_at IS NULL OR ended_at >= ?)${ticket === null ? "" : " AND ticket = ?"}`,
      )
      .all(
        ...(ticket === null ? [from, to, until, since] : [from, to, until, since, ticket]),
      ) as Row[];
    return rows.reduce((total, row) => {
      if (row.tokens === null) return total;
      const tokens = JSON.parse(row.tokens as string) as TokenUsage;
      return total + tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
    }, 0);
  }

  /** Labelled direct questions and blockers still awaiting their addressee's reply or reaction. */
  openCommsItems(): (CommsRow & { label: "question" | "blocker" })[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM comms c
         WHERE c.label IN ('question', 'blocker') AND c.to_id != ?
           AND NOT EXISTS (
             SELECT 1 FROM comms_reactions r WHERE r.message_id = c.id AND r.actor_id = c.to_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM comms reply
             WHERE reply.reply_to = c.id AND reply.from_id = c.to_id
           )
           AND NOT EXISTS (SELECT 1 FROM comms_settlements s WHERE s.message_id = c.id)
         ORDER BY c.at ASC, c.id ASC`,
      )
      .all(COMMS_CREW) as Row[];
    return rows.map((row) => this.commsRow(row) as CommsRow & { label: "question" | "blocker" });
  }
  /** The newest `limit` messages with an id above `sinceId`, newest first; text cut to `textMax`. */
  commsFeed(
    sinceId: number,
    limit: number,
    textMax: number,
  ): Pick<CommsRow, "id" | "at" | "from" | "to" | "label" | "ref" | "text" | "senderKind">[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, from_id, to_id, label, ref, sender_kind, substr(text, 1, ?) AS text FROM comms
         WHERE id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(textMax, sinceId, limit) as Row[];
    return rows.map((r) => ({
      id: `comms:${Number(r.id)}`,
      at: Number(r.at),
      from: r.from_id as string,
      to: r.to_id as string,
      label: (r.label as CommsLabel | null) ?? null,
      ref: (r.ref as string | null) ?? null,
      text: r.text as string,
      senderKind: (r.sender_kind as CommsSenderKind | null) ?? null,
    }));
  }
  markCommsScopeRead(scope: string, messageId: string): void {
    const id = commsMessageNumber(messageId);
    if (id === null) return;
    this.db
      .prepare(
        `INSERT INTO comms_reads(thread_id,source_id,offset,block) VALUES (?, 'comms', ?, 0) ON CONFLICT(thread_id,source_id) DO UPDATE SET offset=MAX(offset,excluded.offset)`,
      )
      .run(scope, id);
  }
  commsScopeCursor(scope: string): string | null {
    const r = this.db
      .prepare("SELECT offset FROM comms_reads WHERE thread_id=? AND source_id='comms'")
      .get(scope) as { offset: number } | undefined;
    return r ? `comms:${r.offset}` : null;
  }
  /** Seat delivery receipts, deliberately separate from the operator's UI cursor. */
  commsInboxRead(seatId: string, messageId: string): boolean {
    const id = commsMessageNumber(messageId);
    if (id === null) return false;
    return (
      this.db
        .prepare("SELECT 1 FROM comms_inbox_reads WHERE seat_id=? AND message_id=?")
        .get(seatId, id) !== undefined
    );
  }
  /** Ids of messages `from` sent `to` at or after `since` that `to` has not read, oldest first. */
  unreadCommsFrom(from: string, to: string, since: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?
           AND id NOT IN (SELECT message_id FROM comms_inbox_reads WHERE seat_id = ?)
         ORDER BY id`,
      )
      .all(from, to, since, to) as { id: number }[];
    return rows.map((r) => String(r.id));
  }
  /**
   * Ids of messages `from` sent `to` at or after `since` that `to` has read and not answered (no
   * message from `to` carries `replyTo` naming it, `to` has not reacted to it, and it is not
   * settled: the same closes an open Comms item), oldest first.
   */
  owedCommsFrom(from: string, to: string, since: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM comms c WHERE c.from_id = ? AND c.to_id = ? AND c.at >= ?
           AND c.id IN (SELECT message_id FROM comms_inbox_reads WHERE seat_id = ?)
           AND NOT EXISTS (SELECT 1 FROM comms r WHERE r.from_id = ? AND r.reply_to = c.id)
           AND NOT EXISTS (
             SELECT 1 FROM comms_reactions x WHERE x.message_id = c.id AND x.actor_id = c.to_id
           )
           AND NOT EXISTS (SELECT 1 FROM comms_settlements s WHERE s.message_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM question_choices q WHERE q.message_id = c.id)
         ORDER BY c.id`,
      )
      .all(from, to, since, to, to) as { id: number }[];
    return rows.map((r) => String(r.id));
  }
  markCommsInboxRead(seatId: string, messageIds: readonly string[], at = Date.now()): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO comms_inbox_reads(seat_id,message_id) VALUES (?,?)",
    );
    // the seat took what was sent to it: that is delivery
    const deliver = this.db.prepare(
      "UPDATE comms SET delivered_at = ? WHERE id = ? AND to_id = ? AND delivered_at IS NULL",
    );
    this.transaction(() => {
      for (const messageId of messageIds) {
        const id = commsMessageNumber(messageId);
        if (id === null) continue;
        insert.run(seatId, id);
        deliver.run(at, id, seatId);
      }
    }, true);
  }

  /** The hand-offs at or after `since`, oldest first. */
  comms(since: number, targetRunId?: string): CommsRow[] {
    const rows = this.db
      .prepare(
        targetRunId === undefined
          ? `SELECT * FROM (
               SELECT * FROM comms WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`
          : `SELECT * FROM (
               SELECT * FROM (
                 SELECT * FROM comms WHERE at >= ? AND target_run_id IS NULL
                 UNION ALL
                 SELECT * FROM comms WHERE at >= ? AND target_run_id = ?
               ) ORDER BY at DESC, id DESC LIMIT ?
             ) ORDER BY at, id`,
      )
      .all(
        since,
        ...(targetRunId === undefined ? [] : [since, targetRunId]),
        LIVE_COMMS_LIMIT,
      ) as Row[];
    // Activity's long-standing feed deliberately remains its compact legacy shape. New Comms
    // readers use the scoped methods above, which include metadata and related rows.
    return rows.map((r) => ({
      at: r.at as number,
      from: r.from_id as string,
      to: r.to_id as string,
      ticket: r.ticket as string | null,
      text: r.text as string,
    })) as CommsRow[];
  }

  /** Messages to `to` at or after `since`, with their label: the times FLIGHT's callers began to wait. */
  commsTo(to: string, since: number): { at: number; from: string; label: string | null }[] {
    return (
      this.db
        .prepare("SELECT at, from_id, label FROM comms WHERE to_id = ? AND at >= ? ORDER BY at, id")
        .all(to, since) as { at: number; from_id: string; label: string | null }[]
    ).map((r) => ({ at: r.at, from: r.from_id, label: r.label }));
  }

  /** How many hand-offs `from` sent `to` at or after `since`. */
  commsCountTo(from: string, to: string, since: number): number {
    const r = this.statement(
      "SELECT COUNT(*) AS n FROM comms WHERE from_id = ? AND to_id = ? AND at >= ?",
    ).get(from, to, since) as { n: number };
    return r.n;
  }

  /** Stable stored message IDs for one thread, in insertion order. */
  threadComms(id: string, after = 0): (CommsRow & { id: string })[] {
    const rows = this.db
      .prepare(`SELECT * FROM comms WHERE id IN (
          SELECT id FROM (SELECT id FROM comms WHERE from_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
          UNION
          SELECT id FROM (SELECT id FROM comms WHERE to_id = ? AND id > ? ORDER BY id DESC LIMIT ?)
        ) ORDER BY id DESC LIMIT ?`)
      .all(
        id,
        after,
        THREAD_COMMS_LIMIT,
        id,
        after,
        THREAD_COMMS_LIMIT,
        THREAD_COMMS_LIMIT,
      ) as Row[];
    return this.commsRows(rows.reverse());
  }

  /** Prompt metadata remains available even after its body has been read. */
  threadPrompt(id: string): { id: string; at: number } | undefined {
    const row = this.db
      .prepare(
        "SELECT id, at FROM comms WHERE from_id = ? AND to_id = ? ORDER BY at DESC, id DESC LIMIT 1",
      )
      .get(COMMS_CAPCOM, id) as { id: number; at: number } | undefined;
    return row && { id: `comms:${row.id}`, at: row.at };
  }

  /** Progress evidence does not need message bodies. */
  commsEvidence(since: number): Pick<CommsRow, "at" | "from" | "ticket">[] {
    return this.db
      .prepare('SELECT at, from_id AS "from", ticket FROM comms WHERE at >= ? ORDER BY at, id')
      .all(since) as Pick<CommsRow, "at" | "from" | "ticket">[];
  }

  threadReadCursors(id: string): Map<string, { offset: number; block: number }> {
    const rows = this.db.prepare("SELECT * FROM comms_reads WHERE thread_id = ?").all(id) as Row[];
    return new Map(
      rows.map((r) => [
        r.source_id as string,
        { offset: r.offset as number, block: r.block as number },
      ]),
    );
  }

  /** Validates ownership without re-reading a transcript window that may have moved on. */
  threadOwnsMessage(id: string, messageId: string): boolean {
    const position = commsPosition(messageId);
    if (!position) return false;
    if (position.source === "comms") {
      return (
        this.db
          .prepare("SELECT 1 FROM comms WHERE id = ? AND (from_id = ? OR to_id = ?)")
          .get(position.offset, id, id) !== undefined
      );
    }
    return this.run(position.source.slice("stream:".length))?.agentId === id;
  }

  /** Advance only through the opened snapshot, atomically; stale reads never move backwards. */
  markThreadRead(id: string, messageIds: string[]): void {
    this.transaction(() => {
      const update =
        this.db.prepare(`INSERT INTO comms_reads (thread_id, source_id, offset, block) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, source_id) DO UPDATE SET offset = excluded.offset, block = excluded.block
        WHERE excluded.offset > comms_reads.offset OR (excluded.offset = comms_reads.offset AND excluded.block > comms_reads.block)`);
      for (const messageId of messageIds) {
        const p = commsPosition(messageId);
        if (p) update.run(id, p.source, p.offset, p.block);
      }
    });
  }

  /** Records a hub event (a line on the Activity page). */
  addHubEvent(text: string, at: number): void {
    this.db.prepare("INSERT OR IGNORE INTO hub_events (at, text) VALUES (?, ?)").run(at, text);
  }

  /** The hub events at or after `since`, oldest first. */
  hubEvents(since: number): { at: number; text: string }[] {
    const rows = this.db
      .prepare("SELECT at, text FROM hub_events WHERE at >= ? ORDER BY at")
      .all(since) as Row[];
    return rows.map((r) => ({ at: r.at as number, text: r.text as string }));
  }

  /** The loop events at or after `since`, oldest first, optionally scoped to a repo. */
  loopEvents(since: number, repoId?: RepoId): LoopEvent[] {
    const rows = (
      repoId === undefined
        ? this.db
            .prepare(`SELECT * FROM (
              SELECT * FROM loop_events WHERE at >= ? ORDER BY at DESC, key DESC LIMIT ?
            ) ORDER BY at, key`)
            .all(since, LIVE_LOOP_EVENTS_LIMIT)
        : this.db
            .prepare(`SELECT * FROM (
              SELECT e.* FROM loop_events e JOIN runs r ON r.id = e.run_id
              WHERE e.at >= ? AND r.repo_id = ? ORDER BY e.at DESC, e.key DESC LIMIT ?
            ) ORDER BY at, key`)
            .all(since, repoId, LIVE_LOOP_EVENTS_LIMIT)
    ) as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      runId: r.run_id as string,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  /**
   * Replaces the seat's untaken items with `items`, in order, after any taken row. An issue the
   * seat already holds, or that another seat has queued, is skipped.
   */
  replaceQueue(seatId: string, items: { repoId: RepoId; issue: number }[]): void {
    this.replaceQueues([{ seatId, items }]);
  }

  /**
   * One transaction: deletes every listed seat's untaken rows, then queues each seat's items as
   * `replaceQueue` does (after its taken row; skipping an issue it holds or any other seat has
   * queued).
   */
  replaceQueues(queues: { seatId: string; items: { repoId: RepoId; issue: number }[] }[]): void {
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM queues WHERE seat_id = ? AND taken_at IS NULL");
      for (const q of queues) del.run(q.seatId);
      const queuedElsewhere = this.db.prepare(
        "SELECT 1 FROM queues WHERE repo_id = ? AND issue = ? AND seat_id != ?",
      );
      const ins = this.db.prepare(
        "INSERT INTO queues (seat_id, pos, repo_id, issue, taken_at) VALUES (?, ?, ?, ?, NULL)",
      );
      for (const { seatId, items } of queues) {
        const kept = this.queue(seatId);
        const held = new Set(kept.map((q) => `${q.repoId}#${q.issue}`));
        let pos = kept.reduce((max, q) => Math.max(max, q.pos), -1) + 1;
        for (const i of items) {
          const ref = `${i.repoId}#${i.issue}`;
          if (held.has(ref) || queuedElsewhere.get(i.repoId, i.issue, seatId)) continue;
          held.add(ref);
          ins.run(seatId, pos++, i.repoId, i.issue);
        }
      }
    }, true);
  }

  /** The seat's queue in order, taken row first. */
  queue(seatId: string): QueueRow[] {
    const rows = this.db
      .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos")
      .all(seatId) as Row[];
    return rows.map(queueRow);
  }

  /**
   * Takes the head of the seat's queue, stamped `at`; null when the queue is empty or the seat
   * already holds a row. Under the write lock, so two processes are granted one between them.
   * `between` is a test seam: it runs after the head is read and before it is stamped.
   */
  takeQueued(seatId: string, at: number, between?: () => void): QueueRow | null {
    let taken: QueueRow | null = null;
    this.transaction(() => {
      const held = this.db
        .prepare("SELECT 1 FROM queues WHERE seat_id = ? AND taken_at IS NOT NULL")
        .get(seatId);
      if (held) return;
      const head = this.db
        .prepare("SELECT * FROM queues WHERE seat_id = ? ORDER BY pos LIMIT 1")
        .get(seatId) as Row | undefined;
      if (!head) return;
      between?.();
      this.db
        .prepare("UPDATE queues SET taken_at = ? WHERE seat_id = ? AND pos = ?")
        .run(at, seatId, head.pos as number);
      taken = { ...queueRow(head), takenAt: at };
    }, true);
    return taken;
  }

  /** Gives a taken row back to the queue. */
  untake(seatId: string, repoId: RepoId, issue: number): void {
    this.db
      .prepare("UPDATE queues SET taken_at = NULL WHERE seat_id = ? AND repo_id = ? AND issue = ?")
      .run(seatId, repoId, issue);
  }

  dropQueued(seatId: string, repoId: RepoId, issue: number): void {
    this.db
      .prepare("DELETE FROM queues WHERE seat_id = ? AND repo_id = ? AND issue = ?")
      .run(seatId, repoId, issue);
  }

  /** Rows taken before `before` (a take whose run never began), oldest first. */
  staleTakes(before: number): QueueRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM queues WHERE taken_at IS NOT NULL AND taken_at < ? ORDER BY taken_at, seat_id",
      )
      .all(before) as Row[];
    return rows.map(queueRow);
  }

  /**
   * Opens the note. One already open is left as it is; a cleared one is re-opened with the new
   * text and time. A re-opened note is no longer dismissed.
   */
  raiseNote(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL
         WHERE attention_notes.cleared_at IS NOT NULL`,
      )
      .run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
  }

  /** Updates one open operator item in place, keeping its key and history. */
  refreshNote(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL`,
      )
      .run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
  }

  /** Refresh measured details without restarting or unacknowledging an open episode. */
  refreshNoteInEpisode(n: NoteInput): void {
    this.db
      .prepare(
        `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = CASE WHEN attention_notes.cleared_at IS NULL THEN attention_notes.at ELSE excluded.at END,
           dismissed_at = CASE WHEN attention_notes.cleared_at IS NULL THEN attention_notes.dismissed_at ELSE NULL END,
           cleared_at = NULL`,
      )
      .run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
  }

  clearNote(key: string, at: number): void {
    this.db
      .prepare("UPDATE attention_notes SET cleared_at = ? WHERE key = ? AND cleared_at IS NULL")
      .run(at, key);
  }

  clearNotesFor(runId: string, at: number): void {
    this.db
      .prepare("UPDATE attention_notes SET cleared_at = ? WHERE run_id = ? AND cleared_at IS NULL")
      .run(at, runId);
  }

  /** Dismisses an open note of any kind from Needs you; false when there is no such note. */
  dismissNote(key: string, at: number): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE attention_notes SET dismissed_at = ? WHERE key = ? AND cleared_at IS NULL",
          )
          .run(at, key).changes,
      ) > 0
    );
  }

  /** The open notes, oldest first. */
  notes(): AttentionNote[] {
    const rows = this.db
      .prepare("SELECT * FROM attention_notes WHERE cleared_at IS NULL ORDER BY at, key")
      .all() as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      kind: r.kind as NoteKind,
      runId: r.run_id as string | null,
      seatId: r.seat_id as string | null,
      repoId: r.repo_id as string | null,
      text: r.text as string,
      at: r.at as number,
      clearedAt: null,
      dismissedAt: (r.dismissed_at as number | null) ?? null,
    }));
  }

  /** Historical waits, including cleared notes; only the named seat's evidence counts. */
  telemetryNoteIntervals(
    seatId: string,
    since: number,
    now: number,
    kinds: string[],
  ): [number, number][] {
    const rows = this.db
      .prepare(
        "SELECT at, cleared_at, kind FROM attention_episodes WHERE seat_id = ? AND at < ? AND (cleared_at IS NULL OR cleared_at > ?) ORDER BY at",
      )
      .all(seatId, now, since) as Row[];
    return rows
      .filter((r) => kinds.includes(r.kind as string))
      .map((r) => [
        Math.max(since, r.at as number),
        Math.min(now, (r.cleared_at as number | null) ?? now),
      ]);
  }

  openNoteKeys(runId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT key FROM attention_notes WHERE run_id = ? AND cleared_at IS NULL ORDER BY key",
      )
      .all(runId) as { key: string }[];
    return rows.map((r) => r.key);
  }

  seatSession(seatId: string): SeatSessionRow | null {
    const r = this.db.prepare("SELECT * FROM seat_sessions WHERE seat_id = ?").get(seatId) as
      | Row
      | undefined;
    return r ? seatRow(r) : null;
  }

  /** Seat sessions for the configured HUD rows, indexed after one table read. */
  seatSessions(seatIds: readonly AgentId[]): Map<AgentId, SeatSessionRow> {
    const out = new Map<AgentId, SeatSessionRow>();
    if (seatIds.length === 0) return out;
    const rows = this.statement(
      `SELECT * FROM seat_sessions WHERE seat_id IN (${seatIds.map(() => "?").join(", ")})`,
    ).all(...seatIds) as Row[];
    for (const row of rows) {
      const seat = seatRow(row);
      out.set(seat.seatId, seat);
    }
    return out;
  }

  setSeatSession(row: SeatSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO seat_sessions (seat_id, run_id, cli_session_id, state, reason, worktree, updated_at, error_since, vendor, stop_by, stop_reason, stop_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seat_id) DO UPDATE SET run_id = excluded.run_id,
           cli_session_id = excluded.cli_session_id, state = excluded.state, vendor = excluded.vendor,
           reason = excluded.reason, worktree = excluded.worktree, updated_at = excluded.updated_at,
           stop_by = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_by ELSE NULL END,
           stop_reason = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_reason ELSE NULL END,
           stop_at = CASE WHEN excluded.state = 'stopped' THEN excluded.stop_at ELSE NULL END,
           error_since = CASE WHEN excluded.state != 'error' THEN NULL
             WHEN seat_sessions.state = 'error' THEN COALESCE(seat_sessions.error_since, seat_sessions.updated_at)
             ELSE excluded.updated_at END,
           quiet_turns = CASE WHEN seat_sessions.run_id IS excluded.run_id THEN seat_sessions.quiet_turns ELSE 0 END`,
      )
      .run(
        row.seatId,
        row.runId,
        row.cliSessionId,
        row.state,
        row.reason,
        row.worktree,
        row.updatedAt,
        row.state === "error" ? row.updatedAt : null,
        row.vendor ?? "claude",
        row.stop?.by ?? null,
        row.stop?.reason ?? null,
        row.stop?.at ?? null,
      );
  }

  /**
   * Records that the seat's turn ended at `at`; null: no turn of the seat's current run has. A turn
   * that made no commit since the one before it adds to the seat's quiet turns; a commit clears them.
   */
  setSeatTurnEnded(seatId: string, at: number | null): void {
    const row = this.db
      .prepare("SELECT run_id, last_turn_ended_at FROM seat_sessions WHERE seat_id = ?")
      .get(seatId) as { run_id: string | null; last_turn_ended_at: number | null } | undefined;
    const newest = row?.run_id ? this.newestRunCommit(row.run_id) : null;
    const committed = newest !== null && newest.at > (row?.last_turn_ended_at ?? 0);
    this.db
      .prepare(
        "UPDATE seat_sessions SET last_turn_ended_at = ?, quiet_turns = CASE WHEN ? THEN 0 ELSE quiet_turns + 1 END WHERE seat_id = ?",
      )
      .run(at, at === null || committed ? 1 : 0, seatId);
  }

  /** Records that the seat started a turn at `at`. */
  setSeatTurnStarted(seatId: string, at: number): void {
    this.db
      .prepare("UPDATE seat_sessions SET last_turn_started_at = ? WHERE seat_id = ?")
      .run(at, seatId);
  }

  /** Commits since `since`, per agent, joined to their runs. */
  commitsSince(since: number): { agentId: AgentId; n: number }[] {
    const rows = this.db
      .prepare(`SELECT r.agent_id, COUNT(*) AS n FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? GROUP BY r.agent_id ORDER BY r.agent_id`)
      .all(since) as Row[];
    return rows.map((r) => ({ agentId: r.agent_id as string, n: r.n as number }));
  }

  /** How long each cleared attention note of `kinds` raised since `since` stood open. */
  noteWaits(kinds: string[], since: number): number[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT cleared_at - at AS wait FROM attention_notes
      WHERE kind IN (${kinds.map(() => "?").join(",")}) AND at >= ? AND cleared_at IS NOT NULL
      ORDER BY at, key`)
      .all(...kinds, since) as Row[];
    return rows.map((r) => r.wait as number);
  }

  /**
   * Seat questions answered since `since` by the operator: a CAPCOM message to the seat up to 5 s
   * after the answer. FLIGHT's answers and questions a run's end closed have none.
   */
  operatorAnswers(since: number): { agentId: AgentId; at: number; answeredAt: number }[] {
    const rows = this.db
      .prepare(`SELECT q.agent_id, q.at, q.answered_at FROM seat_questions q
      WHERE q.answered_at >= ? AND EXISTS (SELECT 1 FROM comms c
        WHERE c.from_id = ? AND c.to_id = q.agent_id
        AND c.at BETWEEN q.answered_at AND q.answered_at + 5000)
      ORDER BY q.answered_at, q.id`)
      .all(since, COMMS_CAPCOM) as Row[];
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      at: r.at as number,
      answeredAt: r.answered_at as number,
    }));
  }

  /** Runs the operator ended since `since`; FLIGHT's `end_run` also ends as `operator`, so its runs are left out. */
  operatorStops(since: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs r
      WHERE r.ended_at >= ? AND r.ended_by = 'operator' AND NOT EXISTS (
        SELECT 1 FROM flight_decisions d WHERE d.target_run_id = r.id AND d.kind = 'end'
      )`)
      .get(since) as Row;
    return row.n as number;
  }

  /** A configured check ran to its end on `headSha`: `ok` when the command exited successfully. */
  addCheckRun(c: {
    runId: string;
    command: string;
    invokedCommand?: string;
    headSha: string;
    ok: boolean;
    exitCode?: number | null;
    at: number;
  }): void {
    this.db
      .prepare(
        "INSERT INTO check_runs (run_id, command, invoked_command, head_sha, ok, exit_code, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        c.runId,
        c.command,
        c.invokedCommand ?? c.command,
        c.headSha,
        c.ok ? 1 : 0,
        c.exitCode ?? null,
        c.at,
      );
  }

  qaCheckReceipts(
    runId: string,
    headSha: string,
  ): {
    command: string;
    ok: boolean | null;
    exitCode: number | null;
    at: number;
    evidence: string;
  }[] {
    const checks = (
      this.db
        .prepare(`SELECT invoked_command, ok, exit_code, at FROM check_runs
      WHERE run_id = ? AND head_sha = ? ORDER BY at DESC, id DESC LIMIT 100`)
        .all(runId, headSha) as Row[]
    ).map((row) => ({
      command: row.invoked_command as string,
      ok: row.ok === 1,
      exitCode: row.exit_code as number | null,
      at: row.at as number,
      evidence: `Hub check recorder observed command completion at exact head ${headSha}. Counts were not parsed.`,
    }));
    const locks =
      this.reviewOfRun(runId)?.sha === headSha
        ? (this.db
            .prepare(`SELECT command, started_at, ended_at, outcome
      FROM test_lock_runs WHERE run_id = ? AND ended_at IS NOT NULL AND outcome IN ('pass', 'fail', 'done')
      ORDER BY ended_at DESC, id DESC LIMIT 100`)
            .all(runId) as Row[])
        : [];
    return [
      ...checks,
      ...locks
        .filter((row) => !checks.some((check) => check.command === row.command))
        .map((row) => ({
          command: row.command as string,
          ok: null,
          exitCode: null,
          at: row.ended_at as number,
          evidence: `Hub observed this locked tool invocation in review run ${runId}, reviewing ${headSha}, from ${row.started_at} to ${row.ended_at} (tool ${row.outcome}). Numeric process exit, test counts and scratch source cleanliness were not recorded.`,
        })),
    ].slice(0, 100);
  }

  /** The newest run of `command` by this run on exactly `headSha`, or null if there is none. */
  latestCheckRun(
    runId: string,
    command: string,
    headSha: string,
  ): {
    headSha: string;
    invokedCommand: string;
    ok: boolean;
    exitCode: number | null;
    at: number;
  } | null {
    const r = this.db
      .prepare(
        `SELECT head_sha, invoked_command, ok, exit_code, at FROM check_runs
         WHERE run_id = ? AND command = ? AND head_sha = ?
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(runId, command, headSha) as Row | undefined;
    return r === undefined
      ? null
      : {
          headSha: r.head_sha as string,
          invokedCommand: (r.invoked_command as string | null) ?? command,
          ok: r.ok === 1,
          exitCode: (r.exit_code as number | null) ?? null,
          at: r.at as number,
        };
  }

  /** The newest results (a pass, or a failure with an exit code) of `command` by this run on `headSha`. */
  latestCheckResults(
    runId: string,
    command: string,
    headSha: string,
    limit: number,
  ): { ok: boolean; exitCode: number | null }[] {
    return (
      this.db
        .prepare(
          `SELECT ok, exit_code FROM check_runs
           WHERE run_id = ? AND command = ? AND head_sha = ? AND (ok = 1 OR exit_code IS NOT NULL)
           ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(runId, command, headSha, limit) as Row[]
    ).map((r) => ({ ok: r.ok === 1, exitCode: (r.exit_code as number | null) ?? null }));
  }

  /** The newest result this run recorded for `command`, regardless of commit. */
  newestCheckRun(
    runId: string,
    command: string,
  ): {
    headSha: string;
    invokedCommand: string;
    ok: boolean;
    exitCode: number | null;
    at: number;
  } | null {
    const r = this.db
      .prepare(
        `SELECT head_sha, invoked_command, ok, exit_code, at FROM check_runs WHERE run_id = ? AND command = ?
         ORDER BY at DESC, id DESC LIMIT 1`,
      )
      .get(runId, command) as Row | undefined;
    return r === undefined
      ? null
      : {
          headSha: r.head_sha as string,
          invokedCommand: (r.invoked_command as string | null) ?? command,
          ok: r.ok === 1,
          exitCode: (r.exit_code as number | null) ?? null,
          at: r.at as number,
        };
  }

  addLockHold(h: LockHoldRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO test_lock_holds (run_id, tool_use_id, seat_id, command, since)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(h.runId, h.toolUseId, h.seatId, h.command, h.since);
    this.db
      .prepare(`INSERT INTO test_lock_runs (run_id, seat_id, command, queued_at, started_at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM test_lock_runs WHERE run_id = ? AND ended_at IS NULL
      )`)
      .run(h.runId, h.seatId, h.command, h.queuedAt ?? h.since, h.since, h.runId);
    this.db
      .prepare("DELETE FROM test_lock_runs WHERE started_at < ?")
      .run(h.since - QA_RETENTION_DAYS * 86400000);
  }

  /**
   * One held call ended. `failed` is the Post hook event (PostToolUseFailure): the hold's outcome is
   * `fail` when any of its calls failed, else `pass`; with no event (undefined) it is `done`.
   */
  deleteLockHold(runId: string, toolUseId: string, at = Date.now(), failed?: boolean): void {
    this.db
      .prepare("DELETE FROM test_lock_holds WHERE run_id = ? AND tool_use_id = ?")
      .run(runId, toolUseId);
    if (failed === true) {
      this.db
        .prepare("UPDATE test_lock_runs SET outcome = 'fail' WHERE run_id = ? AND ended_at IS NULL")
        .run(runId);
    }
    this.db
      .prepare(`UPDATE test_lock_runs SET ended_at = ?,
        outcome = CASE WHEN outcome = 'fail' THEN 'fail' WHEN ? IS NULL THEN 'done' ELSE 'pass' END
      WHERE run_id = ? AND ended_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM test_lock_holds WHERE run_id = ?
      )`)
      .run(at, failed === undefined ? null : 1, runId, runId);
  }

  /** Every held call of the run. */
  deleteLockHolds(runId: string, at = Date.now()): void {
    this.db.prepare("DELETE FROM test_lock_holds WHERE run_id = ?").run(runId);
    this.db
      .prepare(
        "UPDATE test_lock_runs SET ended_at = ?, outcome = CASE WHEN outcome = 'fail' THEN 'fail' ELSE 'freed' END WHERE run_id = ? AND ended_at IS NULL",
      )
      .run(at, runId);
  }

  /** Holds of the test lock started or ended since `since`, newest first, with their run's ticket. */
  lockRuns(since: number): TestLockRun[] {
    const rows = this.db
      .prepare(`SELECT h.*, r.ticket FROM test_lock_runs h
      LEFT JOIN runs r ON r.id = h.run_id WHERE h.started_at >= ? OR h.ended_at >= ?
      ORDER BY h.started_at DESC, h.id DESC`)
      .all(since, since) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      seatId: r.seat_id as string,
      command: r.command as string,
      queuedAt: r.queued_at as number,
      startedAt: r.started_at as number,
      endedAt: r.ended_at as number | null,
      outcome: r.outcome as TestLockRun["outcome"],
      ticket: r.ticket as string | null,
    }));
  }

  /** Check runs last read since `since`, newest first. */
  ciRuns(since: number): CiRunView[] {
    const rows = this.db
      .prepare("SELECT * FROM ci_runs WHERE at >= ? ORDER BY at DESC, name, attempt DESC")
      .all(since) as Row[];
    return rows.map(toCiRun);
  }

  /** The repo's milestones, from the last full read. */
  replaceMilestones(repoId: RepoId, goals: RepoGoal[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM milestones WHERE repo_id = ?").run(repoId);
      const ins = this.db.prepare(
        `INSERT INTO milestones (repo_id, number, title, state, due_on, open, closed)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of goals) ins.run(repoId, g.number, g.title, g.state, g.dueOn, g.open, g.closed);
    });
  }

  milestones(repoId?: RepoId): RepoGoal[] {
    const rows = (
      repoId === undefined
        ? this.db.prepare("SELECT * FROM milestones ORDER BY repo_id, number").all()
        : this.db.prepare("SELECT * FROM milestones WHERE repo_id = ? ORDER BY number").all(repoId)
    ) as Row[];
    return rows.map((r) => ({
      repoId: r.repo_id as RepoId,
      number: r.number as number,
      title: r.title as string,
      state: r.state as RepoGoal["state"],
      dueOn: r.due_on as number | null,
      open: r.open as number,
      closed: r.closed as number,
    }));
  }

  setKeeperCursor(c: KeeperCursor): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO keeper_cursors (run_id, spawn, line, rate_limited_until)
         VALUES (?, ?, ?, ?)`,
      )
      .run(c.runId, c.spawn, c.line, c.rateLimitedUntil);
  }

  keeperCursor(runId: string): KeeperCursor | null {
    const r = this.db.prepare("SELECT * FROM keeper_cursors WHERE run_id = ?").get(runId) as
      | Row
      | undefined;
    if (r === undefined) return null;
    return {
      runId,
      spawn: r.spawn as string,
      line: r.line as number,
      rateLimitedUntil: r.rate_limited_until as number | null,
    };
  }

  deleteKeeperCursor(runId: string): void {
    this.db.prepare("DELETE FROM keeper_cursors WHERE run_id = ?").run(runId);
  }

  lockHolds(): LockHoldRow[] {
    const rows = this.db
      .prepare("SELECT * FROM test_lock_holds ORDER BY since, run_id, tool_use_id")
      .all() as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      toolUseId: r.tool_use_id as string,
      seatId: r.seat_id as string,
      command: r.command as string,
      since: r.since as number,
    }));
  }

  /** Sessions that hold a run and are not stopped or in error. */
  activeSeatSessions(): SeatSessionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM seat_sessions WHERE run_id IS NOT NULL ORDER BY seat_id ASC")
      .all() as Row[];
    return rows.map(seatRow).filter((r) => ACTIVE_SEAT_STATES.includes(r.state));
  }

  /** Unended runs a seat row names (any seat state), with the row's worktree; by seat id. */
  liveSeatRuns(): { seatId: string; worktree: string | null; run: Run }[] {
    const rows = this.db
      .prepare(
        `SELECT s.seat_id, s.worktree, s.run_id FROM seat_sessions s JOIN runs r ON r.id = s.run_id
         WHERE r.ended_at IS NULL ORDER BY s.seat_id ASC`,
      )
      .all() as { seat_id: string; worktree: string | null; run_id: string }[];
    const out: { seatId: string; worktree: string | null; run: Run }[] = [];
    for (const r of rows) {
      const run = this.run(r.run_id);
      if (run !== null) out.push({ seatId: r.seat_id, worktree: r.worktree, run });
    }
    return out;
  }

  /** Records one refusal; returns its id. */
  addGuardHit(h: Omit<GuardHit, "id">): number {
    const r = this.db
      .prepare("INSERT INTO guard_hits (agent_id, run_id, rule, text, at) VALUES (?, ?, ?, ?, ?)")
      .run(h.agentId, h.runId, h.rule, h.text, h.at);
    return Number(r.lastInsertRowid);
  }

  /** Hits at or after `sinceMs`, newest first; at most `limit` of them. */
  guardHits(sinceMs: number, limit = GUARD_HITS_LIMIT): GuardHit[] {
    const rows = this.db
      .prepare("SELECT * FROM guard_hits WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(sinceMs, limit) as Row[];
    return rows.map(toGuardHit);
  }

  /** How many refusals a run has had. */
  guardHitCount(runId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM guard_hits WHERE run_id = ?")
      .get(runId) as { n: number };
    return r.n;
  }

  /** Hits at or after `sinceMs` per rule; every rule is present, 0 when it has none. */
  guardHitCounts(sinceMs: number): Record<GuardRule, number> {
    const counts = Object.fromEntries(Object.keys(GUARD_RULES).map((k) => [k, 0])) as Record<
      GuardRule,
      number
    >;
    const rows = this.db
      .prepare("SELECT rule, COUNT(*) AS n FROM guard_hits WHERE at >= ? GROUP BY rule")
      .all(sinceMs) as { rule: string; n: number }[];
    for (const r of rows) if (Object.hasOwn(counts, r.rule)) counts[r.rule as GuardRule] = r.n;
    return counts;
  }

  /** Records a commit the commit tool made for a run (once per run and sha). */
  addRunCommit(c: {
    runId: string;
    repoId: RepoId;
    branch: string;
    sha: string;
    at: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_commits (run_id, repo_id, branch, sha, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, sha) DO NOTHING`,
      )
      .run(c.runId, c.repoId, c.branch, c.sha, c.at);
  }

  commitLines(sha: string): { additions: number | null; deletions: number | null } | null {
    return (
      (this.db.prepare("SELECT additions, deletions FROM commit_lines WHERE sha = ?").get(sha) as
        | { additions: number | null; deletions: number | null }
        | undefined) ?? null
    );
  }

  setCommitLines(
    sha: string,
    counts: { additions: number | null; deletions: number | null },
  ): void {
    this.db
      .prepare("INSERT OR IGNORE INTO commit_lines VALUES (?, ?, ?)")
      .run(sha, counts.additions, counts.deletions);
  }

  /** First record of each repo/commit in the window; a later retry never recounts it. */
  telemetryCommits(
    since: number,
    now: number,
  ): { runId: string; repoId: string; sha: string; at: number }[] {
    const rows = this.db
      .prepare(
        `SELECT c.run_id, c.repo_id, c.sha, c.at FROM run_commits c
         WHERE c.at >= ? AND c.at <= ? AND c.id = (
           SELECT first.id FROM run_commits first
           WHERE first.repo_id = c.repo_id AND first.sha = c.sha ORDER BY first.at, first.id LIMIT 1
         ) ORDER BY c.at, c.id`,
      )
      .all(since, now) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      repoId: r.repo_id as string,
      sha: r.sha as string,
      at: r.at as number,
    }));
  }

  /** Every commit the commit tool made on a branch, oldest first. */
  commitsOnBranch(repoId: RepoId, branch: string): { sha: string; at: number }[] {
    return (
      this.db
        .prepare("SELECT sha, at FROM run_commits WHERE repo_id = ? AND branch = ? ORDER BY at, id")
        .all(repoId, branch) as { sha: string; at: number }[]
    ).map((r) => ({ sha: r.sha, at: r.at }));
  }

  /** The newest `limit` messages `from` sent about one run, newest first. */
  commsFromToRun(from: string, runId: string, limit: number): CommsRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM comms WHERE from_id = ? AND target_run_id = ? ORDER BY at DESC, id DESC LIMIT ?",
        )
        .all(from, runId, limit) as Row[]
    ).map((r) => this.commsRow(r));
  }

  /** The commits the commit tool made for a run, in the order it made them. */
  runCommits(runId: string): string[] {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as { sha: string }[];
    return rows.map((r) => r.sha);
  }

  /** The commits the commit tool made at or after `since`, oldest first, with their run's agent and ticket. */
  runCommitsSince(
    since: number,
  ): { runId: string; agentId: AgentId; sha: string; at: number; ticket: string | null }[] {
    const rows = this.db
      .prepare(`SELECT c.run_id, r.agent_id, c.sha, c.at, r.ticket FROM run_commits c
      JOIN runs r ON r.id = c.run_id WHERE c.at >= ? ORDER BY c.at, c.id`)
      .all(since) as Row[];
    return rows.map((r) => ({
      runId: r.run_id as string,
      agentId: r.agent_id as AgentId,
      sha: r.sha as string,
      at: r.at as number,
      ticket: r.ticket as string | null,
    }));
  }

  /** The run's newest commit and when the commit tool made it, else null. */
  newestRunCommit(runId: string): { sha: string; at: number } | null {
    const r = this.db
      .prepare("SELECT sha, at FROM run_commits WHERE run_id = ? ORDER BY id DESC LIMIT 1")
      .get(runId) as { sha: string; at: number } | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /**
   * Every commit any run made on `branch`: a later run on the same ticket reuses the branch, and
   * the earlier run's unpushed commits still count as the hub's.
   */
  branchCommits(repoId: RepoId, branch: string): Set<string> {
    const rows = this.db
      .prepare("SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ?")
      .all(repoId, branch) as { sha: string }[];
    return new Set(rows.map((r) => r.sha));
  }

  /** The first and last commit recorded on `branch` (by id), or null. */
  branchCommitSpan(repoId: RepoId, branch: string): { first: string; last: string } | null {
    const first = this.db
      .prepare(
        "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ? ORDER BY id ASC LIMIT 1",
      )
      .get(repoId, branch) as { sha: string } | undefined;
    const last = this.db
      .prepare(
        "SELECT sha FROM run_commits WHERE repo_id = ? AND branch = ? ORDER BY id DESC LIMIT 1",
      )
      .get(repoId, branch) as { sha: string } | undefined;
    return first === undefined || last === undefined ? null : { first: first.sha, last: last.sha };
  }

  /** Records that a run's branch is on origin at `sha` (replacing an earlier push of the run). */
  setRunPush(p: { runId: string; sha: string; at: number }): void {
    this.appendAttempt(p.runId, "push", p.at, { sha: p.sha });
    this.db
      .prepare(
        `INSERT INTO run_pushes (run_id, sha, at) VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET sha = excluded.sha, at = excluded.at`,
      )
      .run(p.runId, p.sha, p.at);
  }

  /** The run's last push, or null when it has not pushed. */
  runPush(runId: string): { sha: string; at: number } | null {
    const r = this.statement("SELECT sha, at FROM run_pushes WHERE run_id = ?").get(runId) as
      | { sha: string; at: number }
      | undefined;
    return r ? { sha: r.sha, at: r.at } : null;
  }

  /** Records strays; one already there (same session and path) takes the new seat, kind and time. */
  addStrays(strays: Omit<Stray, "key">[]): void {
    this.transaction(() => {
      const ins = this.db.prepare(
        // `at` stays first-seen: a retry of the same stray is not a new one (its ack holds)
        `INSERT INTO strays (key, session_id, path, agent_id, kind, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent_id = excluded.agent_id, kind = excluded.kind`,
      );
      for (const x of strays) {
        ins.run(strayKey(x.sessionId, x.path), x.sessionId, x.path, x.agentId, x.kind, x.at);
      }
    });
  }

  /** Every stray, oldest first (then by path). */
  strays(): Stray[] {
    const rows = this.db.prepare("SELECT * FROM strays ORDER BY at ASC, path ASC").all() as Row[];
    return rows.map((r) => ({
      key: r.key as string,
      sessionId: r.session_id as string,
      path: r.path as string,
      agentId: r.agent_id as string,
      kind: r.kind as StrayKind,
      at: r.at as number,
    }));
  }

  /** Drops the session's strays on `paths` (reverted, or the run that made them ended). */
  clearStrays(sessionId: string, paths: readonly string[]): void {
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM strays WHERE key = ?");
      for (const p of paths) del.run(strayKey(sessionId, p));
    });
  }

  /** Records a seat's question; returns its id. */
  addQuestion(q: Omit<SeatQuestion, "id" | "passedAt" | "asideAt">): number {
    const r = this.db
      .prepare("INSERT INTO seat_questions (agent_id, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(q.agentId, q.runId, q.text, q.at);
    return Number(r.lastInsertRowid);
  }

  /** When the seat asked its questions, answered or not (ask_flight mirrors each to Comms). */
  questionTimes(agentId: AgentId): Set<number> {
    const rows = this.db
      .prepare("SELECT at FROM seat_questions WHERE agent_id = ?")
      .all(agentId) as { at: number }[];
    return new Set(rows.map((r) => r.at));
  }

  /**
   * The questions seats asked on a ticket that FLIGHT answered, with the answer it recorded,
   * newest first. Every run on the ticket starts with these, so a decision is not asked twice.
   */
  answeredQuestionsOn(
    ticket: string,
    limit: number,
  ): { id: number; question: string; answer: string; at: number }[] {
    const rows = this.db
      .prepare(
        `SELECT q.id, q.text AS question, d.decision AS answer, d.at AS at
         FROM seat_questions q
         JOIN runs r ON r.id = q.run_id
         JOIN flight_decisions d ON d.question_id = q.id AND d.kind = 'answer'
         WHERE r.ticket = ? AND (q.answered_at IS NOT NULL OR q.aside_at IS NOT NULL)
         ORDER BY d.at DESC, d.id DESC LIMIT ?`,
      )
      .all(ticket, limit) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      question: r.question as string,
      answer: r.answer as string,
      at: r.at as number,
    }));
  }

  /** Questions not yet answered and not set aside, oldest first: the ones that wait in Needs you. */
  openQuestions(): SeatQuestion[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM seat_questions WHERE answered_at IS NULL AND aside_at IS NULL ORDER BY id ASC",
      )
      .all() as Row[];
    return rows.map(toQuestion);
  }

  /** Questions the operator set aside with Not now and nobody has answered, oldest first. */
  asideQuestions(): SeatQuestion[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM seat_questions WHERE answered_at IS NULL AND aside_at IS NOT NULL ORDER BY id ASC",
      )
      .all() as Row[];
    return rows.map(toQuestion);
  }

  /** The seat's questions open at any time in [from, to), oldest first. */
  questionsOverlapping(
    agentId: AgentId,
    from: number,
    to: number,
  ): { at: number; answeredAt: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT at, answered_at FROM seat_questions
         WHERE agent_id = ? AND at < ? AND (answered_at IS NULL OR answered_at > ?) ORDER BY id`,
      )
      .all(agentId, to, from) as Row[];
    return rows.map((r) => ({ at: r.at as number, answeredAt: r.answered_at as number | null }));
  }

  /** One question by id, answered or not; null when there is none. */
  question(id: number): (SeatQuestion & { answeredAt: number | null }) | null {
    const r = this.db.prepare("SELECT * FROM seat_questions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? { ...toQuestion(r), answeredAt: r.answered_at as number | null } : null;
  }

  /** Sets an open question aside (Not now); true only when it was open and not yet set aside. */
  setQuestionAside(id: number, at: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET aside_at = ? WHERE id = ? AND answered_at IS NULL AND aside_at IS NULL",
      )
      .run(at, id);
    return Number(r.changes) > 0;
  }

  /** Puts a set-aside question back in Needs you, for a Not now whose GitHub writes failed. */
  clearQuestionAside(id: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET aside_at = NULL WHERE id = ? AND answered_at IS NULL AND aside_at IS NOT NULL",
      )
      .run(id);
    return Number(r.changes) > 0;
  }

  /** Marks an open question passed to the operator; true only when it was open and not yet passed. */
  passQuestion(id: number, at: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET passed_at = ? WHERE id = ? AND answered_at IS NULL AND passed_at IS NULL",
      )
      .run(at, id);
    return Number(r.changes) > 0;
  }

  /**
   * Hands a passed, still open question back to FLIGHT (#758): FLIGHT kept it, or it was passed
   * without a brief before #758. True only when it was passed.
   */
  unpassQuestion(id: number): boolean {
    const r = this.db
      .prepare(
        "UPDATE seat_questions SET passed_at = NULL WHERE id = ? AND answered_at IS NULL AND passed_at IS NOT NULL",
      )
      .run(id);
    return Number(r.changes) > 0;
  }

  /** Marks one open question answered at `at`. */
  answerQuestion(id: number, at: number): void {
    this.db
      .prepare("UPDATE seat_questions SET answered_at = ? WHERE id = ? AND answered_at IS NULL")
      .run(at, id);
  }

  /**
   * Marks every open question of the seat answered at `at`; with `unpassedOnly`, leaves the ones
   * passed to the operator open.
   */
  answerQuestions(agentId: AgentId, at: number, unpassedOnly = false): void {
    this.db
      .prepare(
        `UPDATE seat_questions SET answered_at = ? WHERE agent_id = ? AND answered_at IS NULL${
          unpassedOnly ? " AND passed_at IS NULL" : ""
        }`,
      )
      .run(at, agentId);
  }

  /**
   * Marks every open question of one run answered at `at`; with `unpassedOnly`, leaves the ones
   * passed to the operator open. Another run of the same seat keeps its own questions.
   */
  answerRunQuestions(runId: string, at: number, unpassedOnly = false): void {
    this.db
      .prepare(
        `UPDATE seat_questions SET answered_at = ? WHERE run_id = ? AND answered_at IS NULL${
          unpassedOnly ? " AND passed_at IS NULL" : ""
        }`,
      )
      .run(at, runId);
  }

  /**
   * Records that a question left Needs you without an answer. False, storing nothing, when this ask
   * was closed already. Closing an `ask:` key also answers its question, so the seat's run no
   * longer waits on it.
   */
  closeQuestion(c: QuestionClosure): boolean {
    let stored = false;
    this.transaction(() => {
      stored = this.insertClosure(c);
    });
    return stored;
  }

  /** Operator Clear closes the displayed source and records its closure in the same transaction. */
  clearAttention(c: QuestionClosure, notices: NewCommsRow[] = []): boolean {
    let stored = false;
    this.transaction(() => {
      stored = this.insertClosure(c);
      if (!stored) return;
      if (c.key.startsWith("note:")) this.dismissNote(c.key.slice("note:".length), c.at);
      else if (c.key.startsWith("crew-error:")) {
        const id = Number(c.key.slice("crew-error:".length));
        if (Number.isSafeInteger(id) && id > 0) this.ackCrewError(id);
      } else if (c.key.startsWith(COMMS_OPEN_PREFIX))
        this.settleCommsItem(c.key.slice(COMMS_OPEN_PREFIX.length), c.by, c.reason, c.at);
      this.db
        .prepare(`INSERT INTO acks (key, at, absent_since) VALUES (?, ?, NULL)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at`)
        .run(c.key, c.at);
      for (const notice of notices) this.insertComms(notice, cutCommsText(notice.text), null);
    }, true);
    return stored;
  }

  /** Hide only FLIGHT's latest brief; retain its history and the underlying question or hold. */
  withdrawFlightBrief(key: string): boolean {
    let withdrawn = false;
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT id, structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
        .get(key) as Row | undefined;
      if (
        !row?.structured ||
        (JSON.parse(row.structured as string) as AttentionBrief).by !== "flight"
      )
        return;
      this.setSetting(`withdrawn-brief:${key}`, String(row.id));
      withdrawn = true;
    }, true);
    return withdrawn;
  }

  /** `closeQuestion` without its own transaction, for a caller already in one. */
  private insertClosure(c: QuestionClosure): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO question_closures (key, ask_at, kind, reason, by, question, ticket, operator, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key, ask_at) DO NOTHING`,
      )
      .run(c.key, c.askAt, c.kind, c.reason, c.by, c.question, c.ticket, c.operator ? 1 : 0, c.at);
    const stored = Number(r.changes) > 0;
    const ask = /^ask:(\d+)$/.exec(c.key);
    if (stored && ask !== null) this.answerQuestion(Number(ask[1]), c.at);
    return stored;
  }

  private closureOf(r: Row): QuestionClosure {
    return {
      key: r.key as string,
      askAt: r.ask_at as number,
      kind: r.kind as QuestionClosureKind,
      reason: r.reason as string,
      by: r.by as string,
      question: r.question as string,
      ticket: (r.ticket as string | null) ?? null,
      operator: r.operator === 1,
      at: r.at as number,
    };
  }

  /** The closure of one ask of a key; null when it was not closed without an answer. */
  questionClosure(key: string, askAt: number): QuestionClosure | null {
    const r = this.db
      .prepare("SELECT * FROM question_closures WHERE key = ? AND ask_at = ?")
      .get(key, askAt) as Row | undefined;
    return r ? this.closureOf(r) : null;
  }

  /**
   * The closures of items that stay in the attention list until routed away (not a seat's `ask:`
   * question, which leaves when answered), by key, newest first; read once per build.
   */
  closedItemKeys(): Map<string, QuestionClosure[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM question_closures WHERE key NOT LIKE 'ask:%' ORDER BY at DESC, rowid DESC",
      )
      .all() as Row[];
    const byKey = new Map<string, QuestionClosure[]>();
    for (const r of rows) {
      const c = this.closureOf(r);
      byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    }
    return byKey;
  }

  /** The closures the operator had in Needs you since `since`, newest first. */
  questionClosures(since: number, limit: number): QuestionClosure[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM question_closures WHERE operator = 1 AND at >= ? ORDER BY at DESC, rowid DESC LIMIT ?",
      )
      .all(since, limit) as Row[];
    return rows.map((r) => this.closureOf(r));
  }

  /** Whether FLIGHT's newest brief on the key is for the operator. */
  private briefedForOperator(key: string): boolean {
    const r = this.db
      .prepare("SELECT structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
      .get(key) as { structured: string | null } | undefined;
    return r?.structured != null && (JSON.parse(r.structured) as AttentionBrief).for === "operator";
  }

  private endQuestions(where: "run_id" | "agent_id", id: string, at: number): void {
    this.transaction(() => {
      const rows = this.db
        // a question the operator set aside outlives its run: it is answered on the Ticket page
        .prepare(
          `SELECT * FROM seat_questions WHERE ${where} = ? AND answered_at IS NULL AND aside_at IS NULL`,
        )
        .all(id) as Row[];
      for (const r of rows) {
        const q = toQuestion(r);
        const key = `ask:${q.id}`;
        this.insertClosure({
          key,
          askAt: q.at,
          kind: "run-ended",
          reason: ASKING_RUN_ENDED_REASON,
          by: "hub",
          question: q.text,
          ticket: this.run(q.runId)?.ticket ?? null,
          operator: q.passedAt !== null && this.briefedForOperator(key),
          at,
        });
      }
    });
  }

  /** The asking run has ended: each of its open questions closes, with that reason. */
  endRunQuestions(runId: string, at: number): void {
    this.endQuestions("run_id", runId, at);
  }

  /** The seat has no run now: each of its open questions closes, with that reason. */
  endSeatQuestions(agentId: AgentId, at: number): void {
    this.endQuestions("agent_id", agentId, at);
  }

  /** Records an mc tool failure for the operator; returns its id. */
  addCrewError(e: Omit<CrewError, "id">): number {
    const r = this.db
      .prepare("INSERT INTO crew_errors (agent_id, run_id, text, at) VALUES (?, ?, ?, ?)")
      .run(e.agentId, e.runId, e.text, e.at);
    return Number(r.lastInsertRowid);
  }

  /** Crew errors not yet acked, oldest first. */
  crewErrors(): CrewError[] {
    const rows = this.db
      .prepare("SELECT * FROM crew_errors WHERE acked = 0 ORDER BY id ASC")
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      runId: r.run_id as string | null,
      text: r.text as string,
      at: r.at as number,
    }));
  }

  ackCrewError(id: number): void {
    this.db.prepare("UPDATE crew_errors SET acked = 1 WHERE id = ?").run(id);
  }

  addDraft(
    target: string,
    kind: ReplyDraft["kind"],
    text: string,
    at: number,
    metadata?: Pick<ReplyDraft, "to" | "via" | "where" | "context">,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO drafts (target, kind, text, created_at, metadata) VALUES (?, ?, ?, ?, ?)",
        )
        .run(target, kind, text, at, metadata ? JSON.stringify(metadata) : null).lastInsertRowid,
    );
  }

  addSourceDraft(
    target: string,
    kind: ReplyDraft["kind"],
    text: string,
    at: number,
    source: { itemKey: string; replyId: string; source: PersonSource },
    metadata?: Pick<ReplyDraft, "to" | "via" | "where" | "context">,
  ): number {
    const id = this.addDraft(target, kind, text, at, metadata);
    this.db.prepare("UPDATE drafts SET source = ? WHERE id = ?").run(JSON.stringify(source), id);
    return id;
  }

  draftSource(
    id: number,
  ): { itemKey: string; replyId: string; source: PersonSource; state: string } | null {
    const row = this.db.prepare("SELECT source, state FROM drafts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row?.source ? { ...JSON.parse(row.source as string), state: row.state as string } : null;
  }

  drafts(includeDone = false): ReplyDraft[] {
    return this.readDrafts(includeDone ? "all" : "pending");
  }

  draft(id: number): ReplyDraft | undefined {
    return this.readDrafts(id)[0];
  }

  draftHistory(): ReplyDraft[] {
    return this.readDrafts("history");
  }

  private readDrafts(selection: "pending" | "all" | "history" | number): ReplyDraft[] {
    const rows = this.db
      .prepare(
        `SELECT id, target, kind, text, created_at AS createdAt, state, metadata, completed_at AS completedAt
       FROM drafts ${
         typeof selection === "number"
           ? "WHERE id = ?"
           : selection === "history"
             ? "WHERE state != 'pending' ORDER BY COALESCE(completed_at, created_at) DESC, id DESC LIMIT 100"
             : selection === "all"
               ? `WHERE state = 'pending' OR id IN (
               SELECT id FROM drafts WHERE state != 'pending'
               ORDER BY created_at DESC, id DESC LIMIT 100
             ) ORDER BY created_at DESC, id DESC`
               : "WHERE state = 'pending' ORDER BY created_at, id"
       }`,
      )
      .all(...(typeof selection === "number" ? [selection] : [])) as Row[];
    return rows.map(({ metadata, completedAt, ...r }) => ({
      ...r,
      to: r.target,
      via: "GitHub",
      where: r.target,
      ...(metadata ? JSON.parse(metadata as string) : {}),
      ...(completedAt === null ? {} : { completedAt }),
    })) as ReplyDraft[];
  }

  finishDraft(
    id: number,
    state: "posted" | "copied" | "discarded",
    text?: string,
    at = Date.now(),
  ): void {
    this.db
      .prepare(
        "UPDATE drafts SET state = ?, text = COALESCE(?, text), completed_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(state, text ?? null, at, id);
  }

  setFlightPlans(session: string, operation: FlightPlanOperation, at: number): void {
    const write = this.prepareFlightPlans(session, operation, at);
    this.transaction(write);
  }

  private prepareFlightPlans(
    session: string,
    operation: FlightPlanOperation,
    at: number,
  ): () => void {
    const plans = new Map(this.flightPlans(session).map((p) => [p.id, p]));
    for (const entry of operation.upsert ?? []) {
      if (entry.status === "completed" && !entry.detail?.trim())
        throw new Error("Completion needs an observed outcome.");
      plans.set(entry.id, { ...entry, createdAt: plans.get(entry.id)?.createdAt ?? at });
    }
    if ([...plans.values()].filter((p) => p.status === "pending").length > FLIGHT_PLAN_LIMIT)
      throw new Error("Too many planned entries.");
    const finished = [...plans.values()]
      .filter((p) => p.status !== "pending")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    for (const entry of finished.slice(0, Math.max(0, plans.size - FLIGHT_PLAN_LIMIT)))
      plans.delete(entry.id);
    return () => {
      this.db.prepare("DELETE FROM flight_plans WHERE session_id = ?").run(session);
      for (const entry of plans.values())
        this.db
          .prepare("INSERT INTO flight_plans (session_id, id, entry) VALUES (?, ?, ?)")
          .run(session, entry.id, JSON.stringify(entry));
    };
  }

  /** Stores a FLIGHT wake on the run it woke, with the fact categories that caused it. */
  addFlightWake(runId: string, at: number, reasons: string[], wakeId?: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO flight_wakes (run_id, at, reasons, wake_id) VALUES (?, ?, ?, ?)",
      )
      .run(runId, at, JSON.stringify(reasons), wakeId ?? null);
  }

  /** The id of the run's latest wake; null when it has none or none was given an id. */
  latestFlightWakeId(runId: string): string | null {
    const row = this.db
      .prepare("SELECT wake_id FROM flight_wakes WHERE run_id = ? ORDER BY at DESC LIMIT 1")
      .get(runId) as { wake_id: string | null } | undefined;
    return row?.wake_id ?? null;
  }

  /** FLIGHT's wakes at or after `since`, oldest first. */
  flightWakes(since: number): FlightWakeRecord[] {
    const rows = this.db
      .prepare(
        "SELECT run_id, at, reasons, wake_id FROM flight_wakes WHERE at >= ? ORDER BY at, run_id",
      )
      .all(since) as { run_id: string; at: number; reasons: string; wake_id: string | null }[];
    return rows.map((r) => ({
      runId: r.run_id,
      at: r.at,
      reasons: JSON.parse(r.reasons) as string[],
      ...(r.wake_id === null ? {} : { wakeId: r.wake_id }),
    }));
  }

  flightPlans(session: string): (FlightPlanInput & { createdAt: number })[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_plans WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightPlanInput & { createdAt: number });
  }

  setFlightWatch(session: string, operation: FlightWatchOperation, at: number): void {
    const write = this.prepareFlightWatch(session, operation, at);
    this.transaction(write);
  }

  private prepareFlightWatch(
    session: string,
    operation: FlightWatchOperation,
    at: number,
  ): () => void {
    const watch = new Map(this.flightWatch(session).map((entry) => [entry.id, entry]));
    for (const id of operation.remove ?? []) watch.delete(id);
    for (const entry of operation.upsert ?? []) watch.set(entry.id, { ...entry, updatedAt: at });
    if (watch.size > FLIGHT_WATCH_LIMIT) throw new Error("Too many watch entries.");
    return () => {
      this.db.prepare("DELETE FROM flight_watch WHERE session_id = ?").run(session);
      for (const entry of watch.values())
        this.db
          .prepare("INSERT INTO flight_watch (session_id, id, entry) VALUES (?, ?, ?)")
          .run(session, entry.id, JSON.stringify(entry));
    };
  }

  /** Validate the whole update before writing any part of it. */
  updateFlightBrief(
    section: Omit<FlightBriefRow, "section" | "text"> &
      Partial<Pick<FlightBriefRow, "section" | "text">>,
    planned?: FlightPlanOperation,
    watch?: FlightWatchOperation,
    arrival?: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">,
  ): void {
    const plansWrite = planned
      ? this.prepareFlightPlans(section.sessionId, planned, section.updatedAt)
      : undefined;
    const watchWrite = watch
      ? this.prepareFlightWatch(section.sessionId, watch, section.updatedAt)
      : undefined;
    this.transaction(() => {
      plansWrite?.();
      watchWrite?.();
      if (arrival) this.writeFlightArrival(arrival);
      if (section.section !== undefined && section.text !== undefined)
        this.setFlightBriefSection({ ...section, section: section.section, text: section.text });
    });
  }

  flightWatch(session: string): FlightWatchEntry[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_watch WHERE session_id = ? ORDER BY id")
        .all(session) as Row[]
    ).map((r) => JSON.parse(r.entry as string) as FlightWatchEntry);
  }

  recordFlightArrival(entry: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">): void {
    this.transaction(() => this.writeFlightArrival(entry));
  }

  private writeFlightArrival(
    entry: Omit<FlightArrivalDisposition, "id" | "repoId" | "sourceRef">,
  ): void {
    const id = JSON.stringify([entry.source, entry.arrivalId, entry.version]);
    const notification = entry.source === "Board" ? null : this.notification(entry.arrivalId);
    const board =
      entry.source === "Board"
        ? this.board(entry.arrivalId.split("#")[0] ?? "").find(
            (c) => `${c.repoId}#${c.issueNumber}` === entry.arrivalId,
          )
        : undefined;
    const repoId = notification?.repoId || board?.repoId || null;
    const kind =
      entry.source === "Teams"
        ? "teams"
        : notification?.subjectType === "PullRequest"
          ? "github-pr"
          : "github-issue";
    const url = notification?.message?.url ?? notification?.url ?? board?.url;
    let sourceRef: FlightArrivalDisposition["sourceRef"] = null;
    if (url) {
      try {
        const parsed = new URL(url);
        if (
          parsed.origin ===
            (kind === "teams" ? "https://teams.microsoft.com" : "https://github.com") &&
          !parsed.username &&
          !parsed.password
        )
          sourceRef = { kind, url };
      } catch {
        /* Invalid source URLs are never offered as links. */
      }
    }
    const previous = this.db.prepare("SELECT entry FROM flight_incoming WHERE id = ?").get(id) as
      | Row
      | undefined;
    const saved = previous
      ? (JSON.parse(previous.entry as string) as FlightArrivalDisposition)
      : null;
    if (saved?.outcome === entry.outcome && saved.detail === entry.detail) return;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO flight_incoming (id, source, arrival_id, version, at, entry) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        entry.source,
        entry.arrivalId,
        entry.version,
        entry.at,
        JSON.stringify({
          ...entry,
          id,
          repoId: saved ? (saved.repoId ?? null) : repoId,
          sourceRef: saved ? (saved.sourceRef ?? null) : sourceRef,
        }),
      );
    this.db
      .prepare(
        "DELETE FROM flight_incoming WHERE id NOT IN (SELECT id FROM flight_incoming ORDER BY at DESC, id DESC LIMIT ?)",
      )
      .run(FLIGHT_INCOMING_LIMIT);
  }

  flightIncoming(): FlightArrivalDisposition[] {
    return (
      this.db
        .prepare("SELECT entry FROM flight_incoming ORDER BY at DESC, id DESC LIMIT ?")
        .all(FLIGHT_INCOMING_LIMIT) as Row[]
    ).map((r) => {
      const entry = JSON.parse(r.entry as string) as FlightArrivalDisposition;
      return { ...entry, repoId: entry.repoId ?? null, sourceRef: entry.sourceRef ?? null };
    });
  }

  /**
   * Records the operator's answer to a set-aside question where every later run on its ticket reads
   * it (`answeredQuestionsOn`). A repeat for the same question replaces the earlier text.
   */
  recordSetAsideAnswer(d: {
    at: number;
    seatId: AgentId;
    questionId: number;
    ref: string;
    about: string;
    decision: string;
  }): void {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM flight_decisions WHERE question_id = ? AND kind = 'answer'")
        .run(d.questionId);
      this.addFlightDecision({
        at: d.at,
        kind: "answer",
        seatId: d.seatId,
        targetRunId: null,
        ref: d.ref,
        questionId: d.questionId,
        about: d.about,
        decision: d.decision,
        basis: "Operator answered the set-aside question from its ticket.",
      });
    });
  }

  /** Records one of FLIGHT's decisions; returns its id. */
  addFlightDecision(d: Omit<FlightDecision, "id">): number {
    const r = this.db
      .prepare(
        `INSERT INTO flight_decisions
           (at, kind, seat_id, target_run_id, ref, question_id, about, decision, basis, order_id,
            wake_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.at,
        d.kind,
        d.seatId,
        d.targetRunId,
        d.ref,
        d.questionId,
        d.about,
        d.decision,
        d.basis,
        d.orderId ?? null,
        d.wakeId ?? null,
      );
    return Number(r.lastInsertRowid);
  }

  /** FLIGHT's decisions at or after `since`, newest first. */
  flightDecisions(since: number, limit: number): FlightDecision[] {
    const rows = this.db
      .prepare("SELECT * FROM flight_decisions WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(since, limit) as Row[];
    return rows.map(toFlightDecision);
  }

  /** When FLIGHT decided to wait, at or after `since`, oldest first. */
  flightWaitTimes(since: number): number[] {
    return (
      this.db
        .prepare("SELECT at FROM flight_decisions WHERE kind = 'wait' AND at >= ? ORDER BY at")
        .all(since) as { at: number }[]
    ).map((r) => r.at);
  }

  /** The decisions of one kind about one ticket, newest first. */
  flightDecisionsAbout(kind: FlightDecisionKind, ref: string): FlightDecision[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM flight_decisions WHERE kind = ? AND ref = ? ORDER BY at DESC, id DESC",
      )
      .all(kind, ref) as Row[];
    return rows.map(toFlightDecision);
  }

  /** Replaces one section of a session's brief. */
  setFlightBriefSection(r: FlightBriefRow): void {
    this.db
      .prepare(
        `INSERT INTO flight_brief (session_id, section, text, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, section) DO UPDATE SET
           text = excluded.text, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(r.sessionId, r.section, r.text, r.updatedAt, r.updatedBy);
  }

  /** Lasting notes for one repo, in topic order. */
  flightMemory(repo: string): FlightMemoryNote[] {
    return (
      this.db
        .prepare("SELECT * FROM flight_memory WHERE repo_id = ? ORDER BY topic")
        .all(repo) as Row[]
    ).map((r) => ({
      repoId: r.repo_id as string,
      topic: r.topic as string,
      kind: r.kind as FlightMemoryNote["kind"],
      body: r.body as string,
      source: r.source as string,
      author: r.author as FlightMemoryNote["author"],
      updatedAt: r.updated_at as number,
    }));
  }

  /** The state index never reads note bodies. */
  flightMemoryTitles(repo: string): FlightMemoryTitle[] {
    return (
      this.db
        .prepare(
          "SELECT topic, kind, updated_at, author FROM flight_memory WHERE repo_id = ? ORDER BY topic",
        )
        .all(repo) as Row[]
    ).map((r) => ({
      topic: r.topic as string,
      kind: r.kind as FlightMemoryTitle["kind"],
      updatedAt: r.updated_at as number,
      author: r.author as FlightMemoryTitle["author"],
    }));
  }

  putFlightMemory(note: FlightMemoryNote): void {
    const parsed = validateMemoryNote(note);
    const key = memoryTopicKey(parsed.topic);
    this.transaction(() => {
      const exists = this.db
        .prepare("SELECT 1 FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
        .get(note.repoId, key);
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM flight_memory WHERE repo_id = ?")
        .get(note.repoId) as { n: number };
      if (!exists && count.n >= FLIGHT_MEMORY_TOPICS_MAX) throw new Error(FLIGHT_MEMORY_FULL);
      this.db
        .prepare(`INSERT INTO flight_memory (repo_id, topic, topic_key, kind, body, source, author, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, topic_key) DO UPDATE SET
        topic = excluded.topic, kind = excluded.kind, body = excluded.body, source = excluded.source,
        author = excluded.author, updated_at = excluded.updated_at`)
        .run(
          note.repoId,
          parsed.topic,
          key,
          parsed.kind,
          parsed.body,
          parsed.source,
          parsed.author,
          note.updatedAt,
        );
    });
  }

  deleteFlightMemory(repo: string, topic: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM flight_memory WHERE repo_id = ? AND topic_key = ?")
        .run(repo, memoryTopicKey(topic)).changes > 0
    );
  }

  /** The full ledger for one crew session, including retained closed entries. */
  flightLedger(session: string): FlightLedgerEntry[] {
    const pointers = new Map<string, FlightPointer[]>();
    for (const r of this.db
      .prepare(
        `SELECT entry_key, kind, target, changed_at, change, read_at FROM flight_pointers
         WHERE session_id = ? ORDER BY rowid`,
      )
      .all(session) as Row[]) {
      const list = pointers.get(r.entry_key as string) ?? [];
      list.push({
        kind: r.kind as FlightPointerKind,
        target: r.target as string,
        changedAt: r.changed_at as number | null,
        change: r.change as string | null,
        readAt: r.read_at as number | null,
      });
      pointers.set(r.entry_key as string, list);
    }
    return (
      this.db
        .prepare("SELECT entry FROM flight_ledger WHERE session_id = ? ORDER BY key")
        .all(session) as { entry: string }[]
    ).map((r) => {
      const entry = JSON.parse(r.entry) as FlightLedgerEntry;
      const held = pointers.get(entry.key);
      return held === undefined ? entry : { ...entry, pointers: held };
    });
  }

  /** Marks every pointer at `kind` and `target`, in any entry, as changed at `at`. */
  markFlightPointers(kind: FlightPointerKind, target: string, change: string, at: number): void {
    this.db
      .prepare(
        `UPDATE flight_pointers SET changed_at = ?, change = ?, changed_seq = (SELECT COALESCE(MAX(MAX(COALESCE(changed_seq, 0), COALESCE(read_seq, 0))), 0) + 1 FROM flight_pointers)
         WHERE kind = ? AND target = ?`,
      )
      .run(at, change.slice(0, FLIGHT_POINTER_CHANGE_MAX), kind, target);
  }

  /** The pointers of open entries whose target changed after FLIGHT last read them. */
  movedFlightPointers(session: string): FlightMovedPointer[] {
    const open = FLIGHT_LEDGER_OPEN.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT p.entry_key, p.kind, p.target, p.changed_at, p.change FROM flight_pointers p
           JOIN flight_ledger l ON l.session_id = p.session_id AND l.key = p.entry_key
           WHERE p.session_id = ? AND l.status IN (${open}) AND p.changed_at IS NOT NULL
             AND p.changed_seq > COALESCE(p.read_seq, 0)
           ORDER BY p.changed_at, p.entry_key, p.kind, p.target`,
        )
        .all(session, ...FLIGHT_LEDGER_OPEN) as Row[]
    ).map((r) => ({
      entry: r.entry_key as string,
      kind: r.kind as FlightPointerKind,
      target: r.target as string,
      change: (r.change as string | null) ?? "",
      at: r.changed_at as number,
    }));
  }

  /**
   * FLIGHT has read the pointers in `moved` at `at`. A pointer marked again since (another time or
   * text) stays unread; changes are ordered by a counter, not by `at`, whose clock is the poll's.
   */
  markFlightPointersRead(session: string, moved: readonly FlightMovedPointer[], at: number): void {
    const stamp = this.db.prepare(
      `UPDATE flight_pointers SET read_at = ?, read_seq = (SELECT COALESCE(MAX(MAX(COALESCE(changed_seq, 0), COALESCE(read_seq, 0))), 0) + 1 FROM flight_pointers)
       WHERE session_id = ? AND entry_key = ? AND kind = ? AND target = ?
         AND changed_at = ? AND change = ?`,
    );
    this.transaction(() => {
      for (const m of moved) stamp.run(at, session, m.entry, m.kind, m.target, m.at, m.change);
    });
  }

  /** Save an entry and prune old closed entries across all sessions, in one transaction. */
  putFlightLedgerEntry(session: string, entry: FlightLedgerEntry, pruneBefore: number): void {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO flight_ledger (session_id, key, kind, status, updated_at, entry)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, key) DO UPDATE SET
        kind = excluded.kind, status = excluded.status, updated_at = excluded.updated_at, entry = excluded.entry`)
        .run(
          session,
          entry.key,
          entry.kind,
          entry.status,
          entry.updatedAt,
          JSON.stringify({ ...entry, pointers: undefined }),
        );
      if (entry.pointers !== undefined) this.syncFlightPointers(session, entry);
      this.db
        .prepare(`DELETE FROM flight_ledger WHERE updated_at < ?
        AND status NOT IN (${FLIGHT_LEDGER_OPEN.map(() => "?").join(", ")})`)
        .run(pruneBefore, ...FLIGHT_LEDGER_OPEN);
      this.db
        .prepare(
          `DELETE FROM flight_pointers WHERE NOT EXISTS (
             SELECT 1 FROM flight_ledger l
             WHERE l.session_id = flight_pointers.session_id AND l.key = flight_pointers.entry_key)`,
        )
        .run();
    });
  }

  /** Makes the entry's pointers exactly `entry.pointers`; one that stays keeps its marks. */
  private syncFlightPointers(session: string, entry: FlightLedgerEntry): void {
    const pointers = entry.pointers ?? [];
    const kept = new Set(pointers.map((p) => `${p.kind}\0${p.target}`));
    const drop = this.db.prepare(
      "DELETE FROM flight_pointers WHERE session_id = ? AND entry_key = ? AND kind = ? AND target = ?",
    );
    for (const old of this.db
      .prepare("SELECT kind, target FROM flight_pointers WHERE session_id = ? AND entry_key = ?")
      .all(session, entry.key) as { kind: string; target: string }[]) {
      if (!kept.has(`${old.kind}\0${old.target}`))
        drop.run(session, entry.key, old.kind, old.target);
    }
    const add = this.db.prepare(
      `INSERT OR IGNORE INTO flight_pointers (session_id, entry_key, kind, target, changed_at, change, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of pointers)
      add.run(session, entry.key, p.kind, p.target, p.changedAt, p.change, p.readAt);
  }

  /** The stored sections of a session's brief. */
  flightBrief(sessionId: string): FlightBriefRow[] {
    const rows = this.db
      .prepare("SELECT * FROM flight_brief WHERE session_id = ? ORDER BY section")
      .all(sessionId) as Row[];
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      section: r.section as FlightBriefRow["section"],
      text: r.text as string,
      updatedAt: r.updated_at as number,
      updatedBy: r.updated_by as string,
    }));
  }

  /** A stable, bounded thread for one exact version of an item. */
  ensureDiscussion(
    itemKey: string,
    version: string,
    opening?: { text: string; at: number },
  ): ItemDiscussion {
    const id = randomUUID();
    const messages: ItemChatMessage[] = opening
      ? [
          {
            id: `${id}:opening`,
            itemKey,
            correlationId: id,
            role: "flight",
            text: opening.text,
            at: opening.at,
          },
        ]
      : [];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO item_discussions (id, item_key, version, messages) VALUES (?, ?, ?, ?)`,
      )
      .run(id, itemKey, version, JSON.stringify(messages));
    const row = this.db
      .prepare("SELECT id FROM item_discussions WHERE item_key = ? AND version = ?")
      .get(itemKey, version) as Row;
    return this.discussion(itemKey, row.id as string) as ItemDiscussion;
  }

  discussion(itemKey: string, id: string): ItemDiscussion | null {
    const row = this.db
      .prepare("SELECT * FROM item_discussions WHERE item_key = ? AND id = ?")
      .get(itemKey, id) as Row | undefined;
    return row
      ? {
          id,
          itemKey,
          version: row.version as string,
          messages: JSON.parse(row.messages as string) as ItemChatMessage[],
        }
      : null;
  }

  /** The newest stored conversation for an item which is no longer in attention. */
  discussionForItem(itemKey: string): ItemDiscussion | null {
    const row = this.db
      .prepare("SELECT id FROM item_discussions WHERE item_key = ? ORDER BY rowid DESC LIMIT 1")
      .get(itemKey) as Row | undefined;
    return row ? this.discussion(itemKey, row.id as string) : null;
  }

  private discussionById(id: string): ItemDiscussion | null {
    const row = this.db.prepare("SELECT item_key FROM item_discussions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.discussion(row.item_key as string, id) : null;
  }

  private saveDiscussion(thread: ItemDiscussion): void {
    this.db
      .prepare("UPDATE item_discussions SET messages = ? WHERE id = ?")
      .run(JSON.stringify(thread.messages.slice(-100)), thread.id);
  }

  askDiscussion(id: string, messageId: string, text: string, at: number): boolean {
    const thread = this.discussionById(id);
    if (!thread) throw new Error("Unknown discussion.");
    const prior = thread.messages.find((m) => m.id === messageId);
    if (prior) {
      if (prior.role !== "operator" || prior.text !== text)
        throw new Error("Message id already used.");
      return false;
    }
    thread.messages.push({
      id: messageId,
      itemKey: thread.itemKey,
      correlationId: id,
      role: "operator",
      text,
      at,
    });
    this.saveDiscussion(thread);
    return true;
  }

  replyDiscussion(
    id: string,
    replyTo: string,
    messageId: string,
    text: string,
    at: number,
  ): boolean {
    const thread = this.discussionById(id);
    if (!thread?.messages.some((m) => m.id === replyTo && m.role === "operator")) return false;
    const prior = thread.messages.find((m) => m.id === messageId || m.replyTo === replyTo);
    if (prior) return prior.id === messageId && prior.replyTo === replyTo && prior.text === text;
    thread.messages.push({
      id: messageId,
      itemKey: thread.itemKey,
      correlationId: id,
      replyTo,
      role: "flight",
      text,
      at,
    });
    this.saveDiscussion(thread);
    return true;
  }

  discussionSent(id: string, messageId: string): boolean {
    const row = this.db.prepare("SELECT sent FROM item_discussions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? (JSON.parse(row.sent as string) as string[]).includes(messageId) : false;
  }

  markDiscussionSent(id: string, messageId: string): void {
    const row = this.db.prepare("SELECT sent FROM item_discussions WHERE id = ?").get(id) as Row;
    const sent = JSON.parse(row.sent as string) as string[];
    this.db
      .prepare("UPDATE item_discussions SET sent = ? WHERE id = ?")
      .run(JSON.stringify([...new Set([...sent, messageId])].slice(-100)), id);
  }

  pendingDiscussions(): ItemDiscussion[] {
    const rows = this.db
      .prepare(`
        SELECT d.item_key, d.id,
          (SELECT MIN(json_extract(q.value, '$.at'))
           FROM json_each(d.messages) AS q
           WHERE json_extract(q.value, '$.role') = 'operator'
             AND NOT EXISTS (
               SELECT 1 FROM json_each(d.messages) AS r
               WHERE json_extract(r.value, '$.replyTo') = json_extract(q.value, '$.id')
             )) AS waiting_since
        FROM item_discussions AS d
        WHERE waiting_since IS NOT NULL
        ORDER BY waiting_since ASC, d.rowid ASC
        LIMIT 100
      `)
      .all() as Row[];
    return rows.map((r) => this.discussion(r.item_key as string, r.id as string) as ItemDiscussion);
  }

  /** Stores FLIGHT's brief on an attention key; returns its id. */
  addBrief(b: AttentionBrief & { key: string; defaultEligible?: boolean }): number {
    let id = 0;
    this.transaction(() => {
      id = this.writeBrief(b);
    });
    return id;
  }

  /** Source handoff, audit and the prepared brief commit together or not at all. */
  addPreparedBrief(
    makeBrief: () => AttentionBrief & { key: string; defaultEligible?: boolean },
    handoff: () => void,
  ): number {
    let id = 0;
    this.transaction(() => {
      handoff();
      id = this.writeBrief(makeBrief());
    }, true);
    return id;
  }

  /** A hub-produced queue proposal and its validated brief become visible atomically. */
  addQueueReorderBrief(
    key: string,
    proposal: string,
    note: NoteInput,
    makeBrief: () => AttentionBrief,
  ): number {
    let id = 0;
    this.transaction(() => {
      this.setSetting(key, proposal);
      this.raiseNote(note);
      id = this.writeBrief({ ...makeBrief(), key: `note:${key}`, defaultEligible: false });
    }, true);
    return id;
  }

  private writeBrief(b: AttentionBrief & { key: string; defaultEligible?: boolean }): number {
    let id = 0;
    {
      const {
        key,
        context,
        recommendation,
        options,
        basis,
        at,
        defaultEligible = true,
        ...structured
      } = b;
      if (structured.person) {
        const thread = /^person:(\d+):(\d+)$/.exec(key);
        const n = thread ? this.notification(thread[1] as string) : null;
        if (
          !n ||
          n.updatedAt !== Number(thread?.[2]) ||
          !n.unread ||
          (n.handledThrough !== null && n.updatedAt <= n.handledThrough) ||
          !n.message ||
          JSON.stringify(n.message.source) !== JSON.stringify(structured.person.source)
        ) {
          throw new Error("Source changed; refresh the item before drafting.");
        }
        const source = n.message.source;
        structured.person = {
          ...structured.person,
          history: n.history,
          replies: structured.person.replies?.map(({ draftId: _ignored, ...r }) => ({
            ...r,
            ...(structured.person?.source.kind === "github" && n.number !== null
              ? {
                  draftId: this.addSourceDraft(
                    `${n.repoId}#${n.number}`,
                    n.subjectType === "PullRequest" ? "pr" : "issue",
                    r.text,
                    at,
                    { itemKey: key, replyId: r.id, source },
                    {
                      ...(n.author === null ? {} : { to: n.author }),
                      via: "GitHub",
                      where: `${n.repoId}#${n.number}`,
                      context: n.title,
                    },
                  ),
                }
              : {}),
          })),
        };
      }
      // Read-model identities and receipts are derived, never producer-owned persisted content.
      delete structured.id;
      delete structured.state;
      delete structured.choice;
      // A rebrief with the same ask (for the same reader) keeps when that ask began; a new or
      // changed ask begins at its own `at`, so it carries no askAt.
      delete structured.askAt;
      const last = this.db
        .prepare("SELECT at, structured FROM briefs WHERE key = ? ORDER BY id DESC LIMIT 1")
        .get(key) as { at: number; structured: string | null } | undefined;
      const prior: AttentionBrief | null = last?.structured ? JSON.parse(last.structured) : null;
      if (
        last !== undefined &&
        prior?.for === structured.for &&
        (structured.binding
          ? structured.binding.epoch === prior?.binding?.epoch
          : prior?.ask === structured.ask)
      )
        structured.askAt = prior?.askAt ?? last.at;
      // No timed default on a question to the operator (#1532): a brief never stores one.
      delete structured.defaultAt;
      const eligibleBinding = structured.binding?.actions.some(
        (action) => action.optionId === structured.recommendedOptionId && action.defaultable,
      );
      if (
        defaultEligible &&
        eligibleBinding &&
        !structured.decision?.whyOperator &&
        structured.for !== "flight" &&
        structured.recommendedOptionId
      ) {
        const kept =
          structured.binding?.epoch === prior?.binding?.epoch ? prior?.defaultAt : undefined;
        // The wait starts when a default is first stamped, never at an older ask's time: an ask
        // briefed before defaults existed must not come due the moment it is briefed again.
        structured.defaultAt = kept ?? at + DECISION_DEFAULT_WAIT_MS;
      }
      const r = this.db
        .prepare(`INSERT INTO briefs (key, context, recommendation, options, basis, at, structured)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          key,
          context,
          recommendation,
          JSON.stringify(options),
          basis,
          at,
          JSON.stringify(structured),
        );
      id = Number(r.lastInsertRowid);
      if (structured.binding && structured.binding.epochId === 0) {
        structured.binding = { ...structured.binding, epochId: id };
        this.db
          .prepare("UPDATE briefs SET structured = ? WHERE id = ?")
          .run(JSON.stringify(structured), id);
      }
    }
    return id;
  }

  /** Whether the key was ever briefed for the operator (a brief with no reader predates routing). */
  operatorBriefed(key: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM briefs WHERE key = ? AND (structured IS NULL OR json_extract(structured, '$.for') IS NOT 'flight') LIMIT 1",
        )
        .get(key) !== undefined
    );
  }

  /** The newest brief on each attention key. */
  briefs(): Map<string, AttentionBrief> {
    const rows = this.db
      .prepare(`SELECT b.* FROM briefs b WHERE b.id IN (SELECT MAX(id) FROM briefs GROUP BY key)
        AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'withdrawn-brief:' || b.key AND s.value = CAST(b.id AS TEXT))`)
      .all() as Row[];
    return new Map(
      rows
        .filter((r) => {
          const person = r.structured
            ? (JSON.parse(r.structured as string) as AttentionBrief).person
            : undefined;
          if (!person) return true;
          const thread = /^person:(\d+):(\d+)$/.exec(r.key as string);
          const n = thread ? this.notification(thread[1] as string) : null;
          return (
            n?.updatedAt === Number(thread?.[2]) &&
            JSON.stringify(n?.message?.source) === JSON.stringify(person.source)
          );
        })
        .map((r) => [
          r.key as string,
          {
            ...(r.structured ? JSON.parse(r.structured as string) : {}),
            id: r.id as number,
            context: r.context as string,
            recommendation: r.recommendation as string,
            options: JSON.parse(r.options as string) as BriefOption[],
            basis: r.basis as string,
            at: r.at as number,
          },
        ]),
    );
  }

  /** Holds a card in Backlog behind PR `waitsOn`; an earlier open hold on the card is replaced. */
  addHold(h: { ref: string; waitsOn: number; basis: string; at: number }): void {
    this.releaseHold(h.ref, h.at);
    this.db
      .prepare("INSERT INTO holds (ref, waits_on, basis, at) VALUES (?, ?, ?, ?)")
      .run(h.ref, h.waitsOn, h.basis, h.at);
  }

  /** Releases the card's open hold, if it has one. */
  releaseHold(ref: string, at: number): void {
    this.db
      .prepare("UPDATE holds SET released_at = ? WHERE ref = ? AND released_at IS NULL")
      .run(at, ref);
  }

  /** The holds not yet released, oldest first. */
  activeHolds(): Hold[] {
    const rows = this.db
      .prepare("SELECT * FROM holds WHERE released_at IS NULL ORDER BY at, id")
      .all() as Row[];
    return rows.map((r) => ({
      ref: r.ref as string,
      waitsOn: r.waits_on as number,
      basis: r.basis as string,
      at: r.at as number,
      releasedAt: r.released_at as number | null,
      seen: r.seen === 1,
      toldState: (r.told_state as string | null) ?? null,
    }));
  }

  /** The board has shown the card's open hold in Backlog. */
  markHoldSeen(ref: string): void {
    this.db.prepare("UPDATE holds SET seen = 1 WHERE ref = ? AND released_at IS NULL").run(ref);
  }

  /** FLIGHT has been told the card's open hold waits on a PR in `state`. */
  markHoldTold(ref: string, state: string): void {
    this.db
      .prepare("UPDATE holds SET told_state = ? WHERE ref = ? AND released_at IS NULL")
      .run(state, ref);
  }

  /** How many briefs were written at or after `since`. */
  countBriefs(since: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM briefs WHERE at >= ?").get(since) as {
      n: number;
    };
    return row.n;
  }

  /** How many decisions of these kinds since `since`, optionally for one seat, ref or run. */
  countFlightDecisions(q: {
    kinds: readonly FlightDecisionKind[];
    since: number;
    seatId?: string;
    ref?: string;
    targetRunId?: string;
  }): number {
    if (q.kinds.length === 0) return 0;
    const where = [`kind IN (${q.kinds.map(() => "?").join(", ")})`, "at >= ?"];
    const args: SQLInputValue[] = [...q.kinds, q.since];
    if (q.seatId !== undefined) {
      where.push("seat_id = ?");
      args.push(q.seatId);
    }
    if (q.ref !== undefined) {
      where.push("ref = ?");
      args.push(q.ref);
    }
    if (q.targetRunId !== undefined) {
      where.push("target_run_id = ?");
      args.push(q.targetRunId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM flight_decisions WHERE ${where.join(" AND ")}`)
      .get(...args) as { n: number };
    return row.n;
  }
}
