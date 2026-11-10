import type { DatabaseSync } from "node:sqlite";
import {
  CODE_HEALTH_FLIGHT_TIER_RULES,
  CODE_HEALTH_RULES,
  type CodeHealthRecommendation,
  type CodeHealthRecommendationState,
} from "@mc/core";
import { z } from "zod";
import type { Store } from "../store.ts";
import { CodeHealthReadError } from "./error.ts";
import { fileRecommendationProposals } from "./file-recommendations.ts";
import { recommendationHash as hash } from "./proposal-hash.ts";

type Db = Pick<DatabaseSync, "prepare" | "exec">;
export interface RecommendationScope {
  kind?: "file-risk";
  sizeSha?: string;
  sizeCapturedAt?: number;
  sizeVersion?: number;
  from: number;
  until: number;
  file?: string;
  /** All paths carrying the same explicit finding lineage. */
  files?: string[];
  category?: string;
  findingSummary?: string;
  findingFix?: string;
  /** Latest reported review time for this exact lineage. Used only for safe legacy migration. */
  lineageObservedUntil?: number;
  pr?: number;
  /** What the PR's review findings mostly concerned; one-per-PR proposals with one cause group. */
  cause?: string;
  observedFrom: number | null;
  observedUntil: number | null;
}
export type Proposal = Omit<
  CodeHealthRecommendation,
  "createdAt" | "updatedAt" | "state" | "evidence"
> & {
  scope: RecommendationScope | null;
};

function defaultDecision(rule: string): NonNullable<CodeHealthRecommendation["decision"]> {
  return CODE_HEALTH_FLIGHT_TIER_RULES.includes(rule)
    ? { owner: "FLIGHT", tier: "flight" }
    : { owner: "operator", tier: "operator" };
}
function normaliseProposal(
  value: Omit<CodeHealthRecommendation, "createdAt" | "updatedAt" | "state" | "evidence">,
): Proposal {
  const legacy = value as typeof value & Partial<CodeHealthRecommendation>;
  return {
    ...value,
    causeId: legacy.causeId ?? `legacy:${value.rule}:${value.id}`,
    title: legacy.title ?? value.proposal,
    measure: legacy.measure ?? {
      current: value.target.baseline,
      unit: value.target.metric,
      window: "recorded observation",
      sourceAt: null,
      coverage: "Recorded before measured recommendation fields were introduced.",
    },
    target: {
      ...value.target,
      value: value.target.value ?? null,
      source: value.target.source ?? "Missing recorded target policy.",
      policy: value.target.policy ?? "A numeric target was not recorded for this rule.",
    },
    decision: legacy.decision ?? defaultDecision(value.rule),
  } as Proposal;
}
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
  /** The automatic re-measure against the accepted baseline; set once, on or after the review date. */
  remeasure: Remeasure | null;
}
export interface Remeasure {
  at: number;
  baseline: number | null;
  current: number | null;
  change: "improved" | "unchanged" | "worse" | "unmeasured";
  note: string;
}
export function installRecommendations(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_recommendations (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, proposal TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{"kind":"proposed"}', baseline TEXT,
    active INTEGER NOT NULL DEFAULT 1, work_ready INTEGER NOT NULL DEFAULT 0, work_attempt TEXT, owner TEXT, review_at INTEGER, linked_work TEXT, remeasure TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS code_health_recommendations_repo ON code_health_recommendations(repo_id);
  CREATE TABLE IF NOT EXISTS code_health_recommendation_requests (
    repo_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(repo_id,request_id)
  );`);
  if (
    !db
      .prepare("PRAGMA table_info(code_health_recommendations)")
      .all()
      .some((c) => c.name === "remeasure")
  )
    db.exec("ALTER TABLE code_health_recommendations ADD COLUMN remeasure TEXT");
}
function decode(row: Record<string, unknown>): RecommendationRecord {
  const proposal = normaliseProposal(JSON.parse(String(row.proposal)));
  return {
    ...proposal,
    scope: proposal.scope ?? null,
    state: JSON.parse(String(row.state)),
    active: row.active === 1,
    workReady: row.work_ready === 1,
    workAttempt: row.work_attempt === null ? null : JSON.parse(String(row.work_attempt)),
    baseline: row.baseline === null ? null : JSON.parse(String(row.baseline)),
    owner: row.owner as string | null,
    reviewAt: row.review_at as number | null,
    linkedWork: row.linked_work as string | null,
    remeasure: row.remeasure === null ? null : JSON.parse(String(row.remeasure)),
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
/** Every undecided one-per-PR proposal (a snoozed one counts once its date has passed), for grouping. */
export function openRepeatedRoundsRows(db: Db, repo: string, at: number): RecommendationRecord[] {
  return db
    .prepare(
      `SELECT * FROM code_health_recommendations WHERE repo_id=? AND active=1
       AND json_extract(proposal,'$.rule')='repeated-rounds'
       AND (json_extract(state,'$.kind')='proposed' OR (json_extract(state,'$.kind')='snoozed' AND json_extract(state,'$.until')<=?))
       ORDER BY id LIMIT 500`,
    )
    .all(repo, at)
    .map(decode);
}
export function recommendationRowsForFiles(
  db: Db,
  repo: string,
  paths: readonly string[],
  at: number,
) {
  if (paths.length > 100) throw Error("Recommendation file scope limit");
  if (!paths.length) return [];
  return db
    .prepare(`SELECT * FROM code_health_recommendations WHERE repo_id=? AND active=1
    AND json_extract(proposal,'$.scope.file') IN (SELECT value FROM json_each(?))
    AND (json_extract(state,'$.kind') IN ('proposed','accepted') OR (json_extract(state,'$.kind')='snoozed' AND json_extract(state,'$.until')<=?))
    ORDER BY CASE json_extract(proposal,'$.rule') WHEN 'recurring-correction' THEN 0 ELSE 1 END,json_extract(proposal,'$.target.baseline') DESC,updated_at DESC,id LIMIT 3`)
    .all(repo, JSON.stringify(paths), at)
    .map(decode);
}
function legacyReplacement(db: Db, proposal: Proposal): RecommendationRecord | null {
  const scope = proposal.scope;
  if (
    proposal.rule !== "recurring-correction" ||
    !scope?.category ||
    !scope.files?.length ||
    scope.lineageObservedUntil === undefined
  )
    return null;
  const files = scope.files,
    lineageObservedUntil = scope.lineageObservedUntil;
  const legacy = (
    db
      .prepare(
        "SELECT * FROM code_health_recommendations WHERE repo_id=? AND json_extract(proposal,'$.rule')='recurring-correction'",
      )
      .all(proposal.repoId) as Record<string, unknown>[]
  )
    .map(decode)
    .filter(
      (row) =>
        row.causeId?.startsWith("legacy:") &&
        row.scope !== null &&
        row.scope.category === scope.category &&
        row.scope.file !== undefined &&
        files.includes(row.scope.file) &&
        row.scope.until >= lineageObservedUntil &&
        (row.state.kind === "dismissed" || row.state.kind === "accepted"),
    );
  return legacy.length === 1 ? legacy[0] : null;
}
/** Returns the durable id, which can be a safely migrated legacy id. */
export function upsertRecommendation(db: Db, proposal: Proposal, at: number): string {
  const existing = recommendationRow(db, proposal.repoId, proposal.id);
  if (!existing) {
    const legacy = legacyReplacement(db, proposal);
    if (legacy) {
      db.prepare(
        "UPDATE code_health_recommendations SET proposal=?,active=1,updated_at=MAX(?,updated_at+1) WHERE repo_id=? AND id=?",
      ).run(JSON.stringify({ ...proposal, id: legacy.id }), at, proposal.repoId, legacy.id);
      return legacy.id;
    }
  }
  db.prepare(`INSERT INTO code_health_recommendations(id,repo_id,proposal,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET proposal=excluded.proposal,active=1,updated_at=MAX(excluded.updated_at,updated_at+1)
    WHERE proposal != excluded.proposal OR active=0`).run(
    proposal.id,
    proposal.repoId,
    JSON.stringify(proposal),
    at,
    at,
  );
  return proposal.id;
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
/** Conservative rules consume only measured source rows; missing prerequisites remain collection proposals. */
export function recommendationProposals(
  store: Store,
  repoId: string,
  at: number,
  checkout?: string,
): Proposal[] {
  const source = store.codeHealthReviews(repoId, at - 30 * 86400_000, at),
    proposals: Proposal[] = [];
  function add(
    rule: string,
    subject: string,
    causeId: string,
    title: string,
    observations: unknown,
    observation: string,
    proposal: string,
    metric: string,
    baseline: number | null,
    target: { value: number | null; source: string; policy: string },
    measure: NonNullable<CodeHealthRecommendation["measure"]>,
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
      causeId,
      title,
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
      measure,
      target: { metric, direction: "decrease", baseline, ...target },
      decision: defaultDecision(rule),
    });
  }
  const groups = new Map<string, typeof source.findings>();
  const seenFindings = new Set<string>();
  for (const f of source.findings)
    if (f.category !== null && f.file && !seenFindings.has(f.findingId)) {
      seenFindings.add(f.findingId);
      // The reviewer-recorded summary and fix are the explicit cause lineage. A path or
      // category alone is only a location or label and must not merge recommendations.
      const key = JSON.stringify([f.category, f.summary.trim(), f.fix.trim()]);
      const group = groups.get(key) ?? [];
      group.push(f);
      groups.set(key, group);
    }
  for (const [key, rows] of groups)
    if (
      rows.length >= CODE_HEALTH_RULES.recurringCorrection.findings &&
      new Set(rows.map((r) => r.pr)).size >= CODE_HEALTH_RULES.recurringCorrection.distinctPrs
    ) {
      const [category, summary, fix] = JSON.parse(key) as [string, string, string];
      const files = [
        ...new Set(rows.map((row) => row.file).filter((file): file is string => !!file)),
      ].sort();
      const causeId = `finding-lineage:${hash([category, summary, fix])}`;
      const exactHead = [...new Set(rows.map((row) => row.pr))].every((pr) => {
        const currentHead = rows.find((row) => row.pr === pr)?.currentHeadSha;
        return (
          currentHead !== null &&
          currentHead !== undefined &&
          source.reviews.some((review) => review.pr === pr && review.headSha === currentHead)
        );
      });
      const unresolved = rows.filter(
        (row) => row.resolution === null && row.currentHeadSha === row.headSha,
      );
      const current = exactHead ? unresolved.length : null;
      add(
        "recurring-correction",
        key,
        causeId,
        `Apply recorded ${category} fix: ${fix}`,
        rows.map((r) => r.findingId).sort(),
        `${rows.length} recorded ${category} findings for one cause across ${files.length} files and ${new Set(rows.map((r) => r.pr)).size} PRs in 30 days.`,
        `Apply the recorded fix “${fix}” for ${category} findings, then add its regression coverage.`,
        "unresolved findings for this recorded cause",
        current,
        {
          value: 0,
          source: "clean-review target",
          policy: "Existing clean-review target: no unresolved findings for the recorded cause.",
        },
        {
          current,
          unit: "findings",
          window: "30d",
          sourceAt: source.observedUntil,
          coverage: exactHead
            ? "Exact reviewed heads for the recorded finding lineage."
            : "A newer PR head has no matching review; the current blocking count is unknown.",
        },
        "Reported findings are review observations, not confirmed production defects. Carry lineage may be unknown.",
        {
          file: files[0],
          files,
          category,
          findingSummary: summary,
          findingFix: fix,
          lineageObservedUntil: Math.max(...rows.map((row) => row.reportedAt)),
          cause: causeId,
        },
      );
    }
  const prs = new Map<number, { round: number; reviews: typeof source.reviews }>();
  for (const r of source.reviews) {
    const group = prs.get(r.pr) ?? { round: 0, reviews: [] };
    group.round = Math.max(group.round, r.round);
    group.reviews.push(r);
    prs.set(r.pr, group);
  }
  /** The category most of the PR's distinct findings carry (ties: first alphabetically). */
  function causeOf(pr: number): string {
    const counts = new Map<string, number>(),
      seen = new Set<string>();
    for (const f of source.findings)
      if (f.pr === pr && f.category !== null && !seen.has(f.findingId)) {
        seen.add(f.findingId);
        counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
      }
    return (
      [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "uncategorised"
    );
  }
  for (const [pr, group] of prs)
    if (group.round >= CODE_HEALTH_RULES.repeatedRounds.reportedRounds)
      add(
        "repeated-rounds",
        String(pr),
        `review-rounds:${pr}`,
        `Reduce review rounds for PR ${pr} before extending its scope`,
        group.reviews.map((r) => [r.reviewId, r.round]),
        `PR ${pr} reached ${group.round} reported review rounds in the observed 30-day cohort.`,
        "Inspect finding history and planning scope before extending the same work.",
        "maximum reported review round for this PR",
        group.round,
        {
          value: null,
          source: "Missing recorded clean-review target.",
          policy: "A review-round threshold is a triage trigger, not a numeric completion target.",
        },
        {
          current: group.round,
          unit: "review rounds",
          window: "recorded PR",
          sourceAt: source.observedUntil,
          coverage: "Reported reviews for this PR in the observed 30-day cohort.",
        },
        "Recent cohorts are provisional; round counts do not establish a production defect.",
        { pr, cause: causeOf(pr) },
      );
  const files = fileRecommendationProposals(store, repoId, at, checkout);
  proposals.push(...files.proposals);
  const tests = store.codeHealthTestCollection(repoId, at - 30 * 86400_000, at);
  const missing = [
    ...files.missing,
    ...(!tests.hasAttempts ? ["named-test results"] : []),
    ...(!tests.hasExecuted || tests.unorderedExecuted ? ["test execution-order metadata"] : []),
    ...(tests.partialReports ? ["complete observed attempt counts"] : []),
  ];
  let collection: Proposal | undefined;
  if (missing.length) {
    add(
      "collection",
      "risk-and-tests",
      "collection:risk-and-tests",
      "Collect the missing code-health measurement sources",
      [missing, tests],
      `Missing measurement sources: ${missing.join(", ")}. ${tests.reports} imported test reports are recorded in this window.`,
      "Check missing collection before judging file trends or test reliability.",
      "missing measurement sources",
      null,
      {
        value: null,
        source: "Missing source collection.",
        policy: "A numeric health target cannot be set until these sources are collected.",
      },
      {
        current: null,
        unit: "sources",
        window: "30d",
        sourceAt: source.observedUntil,
        coverage: "Collection prerequisite, not a code-health measure.",
      },
      "Observed imports are not complete GitHub history. Explicit order metadata is not a verified retry sequence; mixed job outcomes alone do not establish flaky tests.",
    );
    collection = proposals.pop();
  }
  const priority = (rule: string) =>
    rule === "recurring-correction" ? 0 : rule === "repeated-rounds" ? 1 : 2;
  proposals.sort(
    (a, b) =>
      priority(a.rule) - priority(b.rule) ||
      (b.target.baseline ?? 0) - (a.target.baseline ?? 0) ||
      a.id.localeCompare(b.id),
  );
  return [...proposals.slice(0, 199), ...(collection ? [collection] : [])];
}
