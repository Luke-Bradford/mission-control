import type { DatabaseSync } from "node:sqlite";
import {
  MAP_COUPLING_CAP,
  MAP_COUPLING_PR_FILES_MAX,
  mapCouplingEligible,
} from "../map/history-rules.ts";

type Db = Pick<DatabaseSync, "prepare">;
type Row = Record<string, unknown>;
export const RISK_PR_MAX = 5000,
  RISK_MEMBERSHIP_MAX = 100000,
  RISK_PAIR_MAX = 20000;
export const CODE_HEALTH_FILE_SCOPE_VERSION = 1;
export function riskPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1000 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export type MembershipKind = "github-head" | "git-merge";
export function installRiskMemberships(db: Pick<DatabaseSync, "exec">) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS code_health_file_memberships(repo_id TEXT NOT NULL,pr_number INTEGER NOT NULL,sha TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(repo_id,pr_number,sha,kind))`,
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS code_health_membership_age ON code_health_file_memberships(at)",
  );
}
/** Walk a bounded indexed batch, retaining every head still named by durable evidence or live PRs. */
export function pruneRiskMemberships(db: Db, now: number, cursor: { at: number; id: number }) {
  const rows = db
    .prepare(`SELECT rowid AS id,at FROM code_health_file_memberships
    WHERE at < ? AND (at,rowid) > (?,?) ORDER BY at,rowid LIMIT 100`)
    .all(now - 90 * 86400000, cursor.at, cursor.id) as { id: number; at: number }[];
  const remove = db.prepare(`DELETE FROM code_health_file_memberships AS m WHERE rowid=?
    AND NOT EXISTS(SELECT 1 FROM pull_requests p WHERE p.repo_id=m.repo_id AND p.number=m.pr_number AND p.head_sha=m.sha)
    AND NOT EXISTS(SELECT 1 FROM pr_history h WHERE h.repo_id=m.repo_id AND h.number=m.pr_number AND (json_extract(h.record,'$.headSha')=m.sha OR json_extract(h.record,'$.mergeCommitSha')=m.sha))
    AND NOT EXISTS(SELECT 1 FROM reviews v WHERE v.repo_id=m.repo_id AND v.pr_number=m.pr_number AND v.sha=m.sha)`);
  for (const row of rows) remove.run(row.id);
  return rows.length === 100 ? rows[rows.length - 1] : { at: -1, id: 0 };
}
export function recordRiskMembership(
  db: Db,
  input: {
    repoId: string;
    pr: number;
    sha: string;
    kind: MembershipKind;
    files: readonly string[];
    declaredFiles: number | null;
    at: number;
  },
) {
  if (
    !/^[a-f0-9]{40,64}$/i.test(input.sha) ||
    !Number.isSafeInteger(input.pr) ||
    !Number.isSafeInteger(input.at) ||
    input.at < 0 ||
    input.pr < 1 ||
    input.files.length > RISK_MEMBERSHIP_MAX ||
    !input.files.every(riskPath)
  )
    throw Error("Invalid code-health file membership");
  const files = [...new Set(input.files)].sort(),
    complete =
      Number.isSafeInteger(input.declaredFiles) &&
      input.declaredFiles !== null &&
      input.declaredFiles >= 0 &&
      input.declaredFiles === files.length;
  const payload = JSON.stringify({ files, declaredFiles: input.declaredFiles, complete });
  if (payload.length > 16 * 1024 * 1024)
    throw Error("Code-health file membership exceeds its bounded limit");
  db.prepare(
    `INSERT INTO code_health_file_memberships(repo_id,pr_number,sha,kind,payload,at)VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,pr_number,sha,kind)DO UPDATE SET payload=excluded.payload,at=excluded.at WHERE payload<>excluded.payload`,
  ).run(input.repoId, input.pr, input.sha, input.kind, payload, input.at);
}
export interface DatedPrFiles {
  pr: number;
  sha: string | null;
  mergedAt: number;
  collectedAt: number | null;
  declaredFiles: number | null;
  files: string[];
  complete: boolean;
  source: MembershipKind | "legacy-unverified";
}
function membership(db: Db, repoId: string, pr: number, sha: unknown, kind: MembershipKind) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(sha)) return null;
  const row = db
    .prepare(
      "SELECT at,length(payload) AS bytes,CASE WHEN length(payload)<=16777216 THEN payload END AS payload FROM code_health_file_memberships WHERE repo_id=? AND pr_number=? AND sha=? AND kind=?",
    )
    .get(repoId, pr, sha, kind);
  if (!row) return null;
  if (Number(row.bytes) > 16 * 1024 * 1024)
    throw Error("Code-health membership exceeds its bounded limit");
  const value: unknown = JSON.parse(String(row.payload));
  if (
    !value ||
    typeof value !== "object" ||
    !("files" in value) ||
    !Array.isArray(value.files) ||
    value.files.length > RISK_MEMBERSHIP_MAX ||
    !value.files.every(riskPath)
  )
    throw Error("Unreadable code-health file membership");
  const declared =
    "declaredFiles" in value &&
    typeof value.declaredFiles === "number" &&
    Number.isSafeInteger(value.declaredFiles) &&
    value.declaredFiles >= 0
      ? value.declaredFiles
      : null;
  const files = [...new Set(value.files as string[])];
  return {
    files,
    declaredFiles: declared,
    complete: declared !== null && declared === files.length,
    bytes: Number(row.bytes),
    collectedAt: Number(row.at),
  };
}
/** Explicit scope, shared by counts, snapshots and git collection. It is not a defect classifier. */
export function riskFile(path: unknown): path is string {
  return (
    riskPath(path) &&
    !/(^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|generated)(?:\/|$)/i.test(path) &&
    !/(?:^|\/)(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json)$/.test(path) &&
    !/(?:\.min\.[cm]?js|\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|sqlite))$/i.test(path)
  );
}
function bounded(rows: Row[], limit: number) {
  if (rows.length > limit)
    throw Error("Code-health dated file evidence exceeds its bounded query limit");
  return rows;
}
function validWindow(from: number, until: number) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || until <= from)
    throw Error("Invalid code-health risk window");
}
/** Half-open dated membership. Completeness means the observed PR's complete diff, not all GitHub history. */
export function datedPrFiles(db: Db, repoId: string, from: number, until: number): DatedPrFiles[] {
  validWindow(from, until);
  const prs = bounded(
    db
      .prepare(
        `SELECT number,merged_at,json_extract(record,'$.headSha') AS head_sha,json_extract(record,'$.mergeCommitSha') AS merge_sha FROM pr_history WHERE repo_id=? AND merged_at>=? AND merged_at<? ORDER BY merged_at,number LIMIT ?`,
      )
      .all(repoId, from, until, RISK_PR_MAX + 1) as Row[],
    RISK_PR_MAX,
  );
  let bytes = 0,
    rows = 0;
  return prs.map((row) => {
    const pr = Number(row.number),
      merge = membership(db, repoId, pr, row.merge_sha, "git-merge"),
      head = merge?.complete ? null : membership(db, repoId, pr, row.head_sha, "github-head"),
      selected = merge?.complete ? merge : (head ?? merge);
    bytes += selected?.bytes ?? 0;
    rows += selected?.files.length ?? 0;
    if (bytes > 16 * 1024 * 1024 || rows > RISK_MEMBERSHIP_MAX)
      throw Error("Code-health dated membership exceeds its bounded limit");
    return {
      pr,
      sha: selected ? String(merge?.complete || !head ? row.merge_sha : row.head_sha) : null,
      mergedAt: Number(row.merged_at),
      collectedAt: selected?.collectedAt ?? null,
      declaredFiles: selected?.declaredFiles ?? null,
      files: selected?.files ?? [],
      complete: selected?.complete ?? false,
      source: merge?.complete
        ? "git-merge"
        : head
          ? "github-head"
          : merge
            ? "git-merge"
            : "legacy-unverified",
    };
  });
}
export function aggregateDatedRisk(prs: readonly DatedPrFiles[]) {
  const complete = prs.every((pr) => pr.complete),
    touches = new Map<string, Set<number>>(),
    couplingFiles = new Map<string, number>(),
    pairs = new Map<string, number>();
  let pairLimit = false,
    excludedBroadPrs = 0;
  for (const pr of prs) {
    const paths = [...new Set(pr.files.filter(riskFile))].sort();
    for (const path of paths) {
      const members = touches.get(path) ?? new Set<number>();
      members.add(pr.pr);
      touches.set(path, members);
    }
    if (!pr.complete) continue;
    if ((pr.declaredFiles ?? Infinity) > MAP_COUPLING_PR_FILES_MAX) {
      excludedBroadPrs++;
      continue;
    }
    for (const path of paths) couplingFiles.set(path, (couplingFiles.get(path) ?? 0) + 1);
    if (pairLimit) continue;
    for (let i = 0; i < paths.length && !pairLimit; i++)
      for (let j = i + 1; j < paths.length; j++) {
        const key = JSON.stringify([paths[i], paths[j]]);
        if (!pairs.has(key) && pairs.size >= RISK_PAIR_MAX) {
          pairLimit = true;
          pairs.clear();
          break;
        }
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  const coupling =
    complete && !pairLimit
      ? [...pairs]
          .flatMap(([key, sharedPrs]) => {
            const [left, right] = JSON.parse(key) as [string, string],
              denominator = Math.min(couplingFiles.get(left) ?? 0, couplingFiles.get(right) ?? 0);
            return mapCouplingEligible(sharedPrs, denominator)
              ? [
                  {
                    left,
                    right,
                    sharedPrs,
                    lessFrequentlyChangedFilePrs: denominator,
                    sharePercent: (sharedPrs / denominator) * 100,
                    excludedBroadPrThreshold: MAP_COUPLING_PR_FILES_MAX,
                  },
                ]
              : [];
          })
          .sort(
            (a, b) =>
              b.sharedPrs - a.sharedPrs ||
              a.left.localeCompare(b.left) ||
              a.right.localeCompare(b.right),
          )
          .slice(0, MAP_COUPLING_CAP)
      : [];
  return {
    complete,
    prs: prs.length,
    observedFrom: prs.length ? Math.min(...prs.map((pr) => pr.mergedAt)) : null,
    observedUntil: prs.length ? Math.max(...prs.map((pr) => pr.mergedAt)) : null,
    collectedAt:
      prs.length && prs.every((pr) => pr.collectedAt !== null)
        ? Math.max(...prs.map((pr) => pr.collectedAt ?? 0))
        : null,
    touches,
    coupling,
    couplingComplete: complete && !pairLimit,
    excludedBroadPrs,
    pairLimit,
  };
}
/** Eligible reviewed PR membership for an incidence denominator, including unmerged reviewed PRs. */
export function reviewedFileMembership(db: Db, repoId: string, from: number, until: number) {
  validWindow(from, until);
  const heads = bounded(
    db
      .prepare(
        `SELECT DISTINCT pr_number AS number,sha FROM reviews WHERE repo_id=? AND state='reported' AND ended_at>=? AND ended_at<? ORDER BY pr_number,sha LIMIT ?`,
      )
      .all(repoId, from, until, RISK_PR_MAX + 1) as Row[],
    RISK_PR_MAX,
  );
  const files = new Map<number, Set<string>>(),
    eligible = new Set<number>();
  const provenance: { pr: number; sha: string; files: string[]; complete: boolean }[] = [];
  let complete = true,
    bytes = 0,
    rows = 0;
  for (const head of heads) {
    const pr = Number(head.number);
    eligible.add(pr);
    const source = membership(db, repoId, pr, head.sha, "github-head");
    provenance.push({
      pr,
      sha: String(head.sha),
      files: source?.files ?? [],
      complete: source?.complete ?? false,
    });
    if (!source?.complete) complete = false;
    bytes += source?.bytes ?? 0;
    rows += source?.files.length ?? 0;
    if (bytes > 16 * 1024 * 1024 || rows > RISK_MEMBERSHIP_MAX)
      throw Error("Code-health reviewed membership exceeds its bounded limit");
    const paths = files.get(pr) ?? new Set<string>();
    for (const path of source?.files ?? []) paths.add(path);
    files.set(pr, paths);
  }
  return { eligiblePrs: [...eligible].map((pr) => ({ repoId, pr })), files, complete, provenance };
}
