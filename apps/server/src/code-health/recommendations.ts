import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CODE_HEALTH_RULES,
  type CodeHealthRecommendation,
  type CodeHealthRecommendationState,
} from "@mc/core";
import { z } from "zod";
import type { Store } from "../store.ts";
import { CodeHealthReadError } from "./error.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
export interface RecommendationScope {
  from: number;
  until: number;
  file?: string;
  category?: string;
  pr?: number;
  observedFrom: number | null;
  observedUntil: number | null;
}
type Proposal = Omit<CodeHealthRecommendation, "createdAt" | "updatedAt" | "state" | "evidence"> & {
  scope: RecommendationScope | null;
};
export interface RecommendationRecord extends CodeHealthRecommendation {
  scope: RecommendationScope | null;
  baseline: {
    fingerprint: string;
    target: CodeHealthRecommendation["target"];
    acceptedAt: number;
    observation: string;
    scope: RecommendationScope | null;
  } | null;
  active: boolean;
  workReady: boolean;
  workAttempt: { fingerprint: string; at: number } | null;
  owner: string | null;
  reviewAt: number | null;
  linkedWork: string | null;
}
export function installRecommendations(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_recommendations (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, proposal TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{"kind":"proposed"}', baseline TEXT,
    active INTEGER NOT NULL DEFAULT 1, work_ready INTEGER NOT NULL DEFAULT 0, work_attempt TEXT, owner TEXT, review_at INTEGER, linked_work TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS code_health_recommendations_repo ON code_health_recommendations(repo_id);
  CREATE TABLE IF NOT EXISTS code_health_recommendation_requests (
    repo_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(repo_id,request_id)
  );`);
}
function decode(row: Record<string, unknown>): RecommendationRecord {
  return {
    ...JSON.parse(String(row.proposal)),
    state: JSON.parse(String(row.state)),
    active: row.active === 1,
    workReady: row.work_ready === 1,
    workAttempt: row.work_attempt === null ? null : JSON.parse(String(row.work_attempt)),
    baseline: row.baseline === null ? null : JSON.parse(String(row.baseline)),
    owner: row.owner as string | null,
    reviewAt: row.review_at as number | null,
    linkedWork: row.linked_work as string | null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    evidence: [],
  };
}
export function recommendationRows(db: Db, repo: string, openAt?: number): RecommendationRecord[] {
  return (
    db
      .prepare(
        `SELECT * FROM code_health_recommendations WHERE repo_id=? ${openAt === undefined ? "" : "AND active=1 AND (json_extract(state,'$.kind')='proposed' OR (json_extract(state,'$.kind')='snoozed' AND json_extract(state,'$.until')<=?))"} ORDER BY updated_at DESC,id LIMIT 200`,
      )
      .all(repo, ...(openAt === undefined ? [] : [openAt])) as Record<string, unknown>[]
  ).map(decode);
}
export function recommendationRow(db: Db, repo: string, id: string): RecommendationRecord | null {
  const row = db
    .prepare("SELECT * FROM code_health_recommendations WHERE repo_id=? AND id=?")
    .get(repo, id);
  return row ? decode(row) : null;
}
export function upsertRecommendation(db: Db, proposal: Proposal, at: number) {
  db.prepare(`INSERT INTO code_health_recommendations(id,repo_id,proposal,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET proposal=excluded.proposal,active=1,updated_at=MAX(excluded.updated_at,updated_at+1)
    WHERE proposal != excluded.proposal OR active=0`).run(
    proposal.id,
    proposal.repoId,
    JSON.stringify(proposal),
    at,
    at,
  );
}
const text = z.string().trim().min(1).max(2000);
export const RecommendationAction = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("accept"),
    owner: text.max(120),
    reviewAt: z.number().int().min(0).max(8640000000000000),
  }),
  z.strictObject({ action: z.literal("dismiss"), reason: text }),
  z.strictObject({
    action: z.literal("snooze"),
    until: z.number().int().min(0).max(8640000000000000),
  }),
  z.strictObject({
    action: z.literal("assess"),
    outcome: z.enum(["paid-off", "no-effect"]),
    reason: text.max(800),
    evidenceId: text,
    comparison: text.max(800),
  }),
]);
export const RecommendationMutation = z.strictObject({
  requestId: z.string().uuid(),
  basis: text,
  expectedUpdatedAt: z.number().int(),
  change: RecommendationAction,
});
export type Mutation = z.infer<typeof RecommendationMutation>;
export function mutateRecommendation(
  db: Db,
  repo: string,
  id: string,
  request: Mutation,
  actor: string,
  at: number,
) {
  const payload = JSON.stringify({ id, request, actor });
  const previous = db
    .prepare(
      "SELECT payload,response FROM code_health_recommendation_requests WHERE repo_id=? AND request_id=?",
    )
    .get(repo, request.requestId);
  if (previous) {
    if (previous.payload !== payload)
      throw new CodeHealthReadError(409, "Request ID was already used for another decision.");
    return JSON.parse(String(previous.response)) as RecommendationRecord;
  }
  const row = recommendationRow(db, repo, id);
  if (!row) throw new CodeHealthReadError(404, "Unknown code-health recommendation.");
  if (row.updatedAt !== request.expectedUpdatedAt)
    throw new CodeHealthReadError(409, "Recommendation changed. Refresh before deciding.");
  const change = request.change;
  let state: CodeHealthRecommendationState;
  if (change.action === "accept") {
    if (!["proposed", "snoozed"].includes(row.state.kind))
      throw new CodeHealthReadError(
        409,
        "Only a proposed or snoozed recommendation can be accepted.",
      );
    if (change.reviewAt <= at)
      throw new CodeHealthReadError(400, "Metric review date must be in the future.");
    row.owner = change.owner;
    row.reviewAt = change.reviewAt;
    row.baseline = {
      observation: row.observation,
      scope: row.scope,
      fingerprint: row.evidenceFingerprint,
      target: row.target,
      acceptedAt: at,
    };
    state = {
      kind: "accepted",
      owner: change.owner,
      reviewAt: change.reviewAt,
      linkedWork: row.linkedWork,
    };
  } else if (change.action === "assess") {
    if (
      row.state.kind !== "accepted" ||
      !row.baseline ||
      row.reviewAt === null ||
      at < row.reviewAt
    )
      throw new CodeHealthReadError(
        409,
        "Assess accepted work on or after its metric review date.",
      );
    const reason = `${change.reason}\nComparison with accepted baseline: ${change.comparison}`;
    state =
      change.outcome === "paid-off"
        ? { kind: "paid-off", assessment: reason, assessedAt: at, evidenceId: change.evidenceId }
        : { kind: "no-effect", reason, assessedAt: at, evidenceId: change.evidenceId };
  } else {
    if (!["proposed", "snoozed"].includes(row.state.kind))
      throw new CodeHealthReadError(409, "This recommendation already has a decision.");
    if (change.action === "dismiss") state = { kind: "dismissed", reason: change.reason };
    else {
      if (change.until <= at)
        throw new CodeHealthReadError(400, "Snooze date must be in the future.");
      state = { kind: "snoozed", until: change.until };
    }
  }
  row.state = state;
  row.updatedAt = Math.max(at, row.updatedAt + 1);
  db.prepare(
    "UPDATE code_health_recommendations SET state=?,baseline=?,owner=?,review_at=?,updated_at=? WHERE repo_id=? AND id=?",
  ).run(
    JSON.stringify(state),
    row.baseline ? JSON.stringify(row.baseline) : null,
    row.owner,
    row.reviewAt,
    row.updatedAt,
    repo,
    id,
  );
  db.prepare("INSERT INTO code_health_recommendation_requests VALUES(?,?,?,?)").run(
    repo,
    request.requestId,
    payload,
    JSON.stringify(row),
  );
  return row;
}
export function linkRecommendation(db: Db, repo: string, id: string, link: string, at: number) {
  const row = recommendationRow(db, repo, id);
  if (
    !row ||
    !(
      row.state.kind === "accepted" ||
      ((row.state.kind === "paid-off" || row.state.kind === "no-effect") && row.workAttempt)
    )
  )
    throw new CodeHealthReadError(
      409,
      "Recommendation must be accepted, or have an existing creation attempt, before linking work.",
    );
  if (row.linkedWork && row.linkedWork !== link)
    throw new CodeHealthReadError(409, "Recommendation already links different work.");
  if (row.state.kind === "accepted") row.state = { ...row.state, linkedWork: link };
  db.prepare(
    "UPDATE code_health_recommendations SET linked_work=?,state=?,updated_at=? WHERE repo_id=? AND id=?",
  ).run(link, JSON.stringify(row.state), Math.max(at, row.updatedAt + 1), repo, id);
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
/** Conservative rules consume only measured source rows; missing prerequisites remain collection proposals. */
export function recommendationProposals(store: Store, repoId: string, at: number): Proposal[] {
  const source = store.codeHealthReviews(repoId, at - 30 * 86400_000, at),
    proposals: Proposal[] = [];
  function add(
    rule: string,
    subject: string,
    observations: unknown,
    observation: string,
    proposal: string,
    metric: string,
    baseline: number | null,
    uncertainty: string,
    scope: Omit<
      RecommendationScope,
      "from" | "until" | "observedFrom" | "observedUntil"
    > | null = null,
  ) {
    proposals.push({
      id: `chr_${hash([repoId, rule, CODE_HEALTH_RULES.version, subject])}`,
      repoId,
      rule,
      ruleVersion: CODE_HEALTH_RULES.version,
      scope: scope
        ? {
            ...scope,
            from: at - 30 * 86400000,
            until: at,
            observedFrom: source.observedFrom,
            observedUntil: source.observedUntil,
          }
        : null,
      evidenceFingerprint: hash(observations),
      observation,
      proposal,
      uncertainty,
      rankingReason:
        rule === "collection"
          ? "Collection is missing; no negative health judgement is possible."
          : "Conservative triage threshold met by observed reported reviews in 30 days.",
      target: { metric, direction: "decrease", baseline },
    });
  }
  const groups = new Map<string, typeof source.findings>();
  const seenFindings = new Set<string>();
  for (const f of source.findings)
    if (f.category !== null && f.file && !seenFindings.has(f.findingId)) {
      seenFindings.add(f.findingId);
      const key = JSON.stringify([f.category, f.file]);
      const group = groups.get(key) ?? [];
      group.push(f);
      groups.set(key, group);
    }
  for (const [key, rows] of groups)
    if (
      rows.length >= CODE_HEALTH_RULES.recurringCorrection.findings &&
      new Set(rows.map((r) => r.pr)).size >= CODE_HEALTH_RULES.recurringCorrection.distinctPrs
    ) {
      const [category, file] = JSON.parse(key);
      add(
        "recurring-correction",
        key,
        rows.map((r) => r.findingId).sort(),
        `${rows.length} distinct ${category} findings on ${file} across ${new Set(rows.map((r) => r.pr)).size} PRs in 30 days.`,
        "Inspect the shared cause and propose a narrow invariant or regression test.",
        "distinct findings in this category/file per 30 days",
        rows.length,
        "Reported findings are review observations, not confirmed production defects. Carry lineage may be unknown.",
        { file, category },
      );
    }
  const prs = new Map<number, { round: number; reviews: typeof source.reviews }>();
  for (const r of source.reviews) {
    const group = prs.get(r.pr) ?? { round: 0, reviews: [] };
    group.round = Math.max(group.round, r.round);
    group.reviews.push(r);
    prs.set(r.pr, group);
  }
  for (const [pr, group] of prs)
    if (group.round >= CODE_HEALTH_RULES.repeatedRounds.reportedRounds)
      add(
        "repeated-rounds",
        String(pr),
        group.reviews.map((r) => [r.reviewId, r.round]),
        `PR ${pr} reached ${group.round} reported review rounds in the observed 30-day cohort.`,
        "Inspect finding history and planning scope before extending the same work.",
        "maximum reported review round for this PR",
        group.round,
        "Recent cohorts are provisional; round counts do not establish a production defect.",
        { pr },
      );
  add(
    "collection",
    "risk-and-tests",
    ["dated-file-touches", "ordered-test-results"],
    "Dated per-file touches, ordered CI attempts and named-test results are not yet collected.",
    "Collect dated PR/file membership and ordered test results before judging churn, size trends or flaky tests.",
    "missing measurement sources",
    null,
    "Unordered mixed job outcomes are candidates only; no flaky-test rate or size-change trend is inferred.",
  );
  const collection = proposals.pop();
  proposals.sort(
    (a, b) =>
      (a.rule === b.rule ? 0 : a.rule === "recurring-correction" ? -1 : 1) ||
      (b.target.baseline ?? 0) - (a.target.baseline ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return [...proposals.slice(0, 199), ...(collection ? [collection] : [])];
}
