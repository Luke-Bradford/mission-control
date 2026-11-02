import type { DatabaseSync } from "node:sqlite";
import type { collectGitFileSource, GitFileCommit } from "./git-source.ts";
import { RISK_MEMBERSHIP_MAX, RISK_PR_MAX, recordRiskMembership, riskPath } from "./risk.ts";

type Db = Pick<DatabaseSync, "prepare">;
export type GitSource = Awaited<ReturnType<typeof collectGitFileSource>>;
export function installGitFileSources(db: Pick<DatabaseSync, "exec">) {
  db.exec(`CREATE TABLE IF NOT EXISTS code_health_git_sources(
    repo_id TEXT PRIMARY KEY,checkout TEXT NOT NULL,sha TEXT,version INTEGER NOT NULL,
    captured_from INTEGER,collected_at INTEGER,checked_at INTEGER NOT NULL,
    elapsed_ms REAL,status TEXT NOT NULL,payload TEXT)`);
}
function validatedCommits(value: unknown): GitFileCommit[] {
  if (!Array.isArray(value) || value.length > RISK_PR_MAX)
    throw Error("Invalid stored git file evidence");
  const shas = new Set<string>();
  let memberships = 0;
  for (const commit of value) {
    if (
      !commit ||
      typeof commit !== "object" ||
      !/^[a-f0-9]{40,64}$/.test(commit.sha) ||
      shas.has(commit.sha) ||
      !Number.isSafeInteger(commit.committedAt) ||
      !Array.isArray(commit.parents) ||
      commit.parents.length > 100 ||
      !commit.parents.every(
        (parent: unknown) => typeof parent === "string" && /^[a-f0-9]{40,64}$/.test(parent),
      ) ||
      !Array.isArray(commit.rawPaths) ||
      !commit.rawPaths.every(riskPath) ||
      !Array.isArray(commit.excludedPaths) ||
      !commit.excludedPaths.every(riskPath) ||
      !Array.isArray(commit.changes)
    )
      throw Error("Invalid stored git commit");
    const rawPaths = new Set<string>(commit.rawPaths);
    if (commit.excludedPaths.some((path: string) => !rawPaths.has(path)))
      throw Error("Invalid excluded git path");
    shas.add(commit.sha);
    memberships += commit.rawPaths.length;
    if (memberships > 2 * RISK_MEMBERSHIP_MAX) throw Error("Stored raw membership limit");
    const paths = new Set<string>();
    const covered = new Set<string>();
    for (const row of commit.changes) {
      const number = (n: unknown) =>
        n === null || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
      if (
        !row ||
        !riskPath(row.path) ||
        !rawPaths.has(row.path) ||
        paths.has(row.path) ||
        (row.previousPath !== null &&
          (!riskPath(row.previousPath) || !rawPaths.has(row.previousPath))) ||
        !number(row.additions) ||
        !number(row.deletions) ||
        (row.additions === null) !== (row.deletions === null) ||
        ++memberships > 2 * RISK_MEMBERSHIP_MAX
      )
        throw Error("Invalid stored git numstat");
      paths.add(row.path);
      covered.add(row.path);
      if (row.previousPath !== null) covered.add(row.previousPath);
    }
    const excluded = new Set<string>(commit.excludedPaths);
    if (commit.rawPaths.some((path: string) => !excluded.has(path) && !covered.has(path)))
      throw Error("Stored raw paths lack numstat coverage");
  }
  return value as GitFileCommit[];
}
export function gitFileSource(db: Db, repoId: string, checkout: string) {
  const row = db
    .prepare(`SELECT sha,version,captured_from,collected_at,checked_at,elapsed_ms,status,
    CASE WHEN length(payload)<=16777216 THEN payload END AS payload,length(payload) AS bytes
    FROM code_health_git_sources WHERE repo_id=? AND checkout=?`)
    .get(repoId, checkout);
  if (!row) return null;
  if (Number(row.bytes) > 16 * 1024 * 1024) throw Error("Stored git file evidence limit");
  const commits =
    row.status === "available" && row.version === 1
      ? validatedCommits(JSON.parse(String(row.payload)))
      : [];
  return {
    analysedSha: typeof row.sha === "string" ? row.sha : null,
    version: Number(row.version),
    from: Number(row.captured_from),
    collectedAt: row.collected_at === null ? null : Number(row.collected_at),
    checkedAt: Number(row.checked_at),
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    status: String(row.status),
    commits,
  };
}
export function recordGitFileSource(
  db: Db,
  repoId: string,
  checkout: string,
  source: GitSource,
  at: number,
) {
  validatedCommits(source.commits);
  const payload = JSON.stringify(source.commits);
  if (
    payload.length > 16 * 1024 * 1024 ||
    !/^[a-f0-9]{40,64}$/.test(source.analysedSha) ||
    source.version !== 1
  )
    throw Error("Invalid git file snapshot");
  db.prepare(`INSERT INTO code_health_git_sources VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(repo_id) DO UPDATE SET checkout=excluded.checkout,sha=excluded.sha,version=excluded.version,
    captured_from=excluded.captured_from,collected_at=excluded.collected_at,checked_at=excluded.checked_at,
    elapsed_ms=excluded.elapsed_ms,status=excluded.status,payload=excluded.payload`).run(
    repoId,
    checkout,
    source.analysedSha,
    source.version,
    source.from,
    at,
    at,
    source.elapsedMs,
    "available",
    payload,
  );
  linkGitFileMemberships(db, repoId, source.from, source.commits, at);
}
export function linkGitFileMemberships(
  db: Db,
  repoId: string,
  from: number,
  sourceCommits: GitFileCommit[],
  at: number,
) {
  const prs = db
    .prepare(`SELECT number,json_extract(record,'$.mergeCommitSha') AS sha
    FROM pr_history WHERE repo_id=? AND merged_at>=? ORDER BY merged_at,number LIMIT ?`)
    .all(repoId, from, RISK_PR_MAX + 1);
  if (prs.length > RISK_PR_MAX) return; // The bounded risk reader publishes the source limit separately.
  const commits = new Map(sourceCommits.map((commit) => [commit.sha, commit]));
  for (const pr of prs) {
    const commit = commits.get(String(pr.sha));
    if (!commit || commit.parents.length < 2) continue;
    const files = commit.rawPaths;
    recordRiskMembership(db, {
      repoId,
      pr: Number(pr.number),
      sha: commit.sha,
      kind: "git-merge",
      files,
      excludedFiles: commit.excludedPaths,
      declaredFiles: files.length,
      at,
    });
  }
}
export function markGitFileChecked(
  db: Db,
  repoId: string,
  checkout: string,
  sha: string,
  at: number,
) {
  db.prepare(
    "UPDATE code_health_git_sources SET checked_at=? WHERE repo_id=? AND checkout=? AND sha=? AND status='available'",
  ).run(at, repoId, checkout, sha);
  const source = gitFileSource(db, repoId, checkout);
  if (source?.status === "available" && source.analysedSha === sha)
    linkGitFileMemberships(db, repoId, source.from, source.commits, at);
}
export function failGitFileSource(
  db: Db,
  repoId: string,
  checkout: string,
  sha: string | null,
  at: number,
) {
  db.prepare(`INSERT INTO code_health_git_sources(repo_id,checkout,sha,version,checked_at,status)VALUES(?,?,?,1,?,'unavailable')
    ON CONFLICT(repo_id)DO UPDATE SET checkout=excluded.checkout,sha=excluded.sha,checked_at=excluded.checked_at,status=excluded.status,payload=NULL`).run(
    repoId,
    checkout,
    sha,
    at,
  );
}

/** Merge dates select the PR cohort; commit dates are evidence only, never its window filter. */
export function gitFileMetrics(
  db: Db,
  repoId: string,
  checkout: string,
  from: number,
  until: number,
  at: number,
) {
  const source = gitFileSource(db, repoId, checkout);
  const prs = db
    .prepare(`SELECT number,merged_at,json_extract(record,'$.mergeCommitSha') AS sha
    FROM pr_history WHERE repo_id=? AND merged_at>=? AND merged_at<? ORDER BY merged_at,number LIMIT ?`)
    .all(repoId, from, until, RISK_PR_MAX + 1);
  if (prs.length > RISK_PR_MAX) throw Error("Git file PR cohort limit");
  const commits = new Map(source?.commits.map((commit) => [commit.sha, commit]));
  const rows = prs.map((pr) => ({
    pr: Number(pr.number),
    mergedAt: Number(pr.merged_at),
    commit: commits.get(String(pr.sha)),
  }));
  return {
    source,
    rows,
    complete:
      !!source &&
      source.status === "available" &&
      source.from <= from &&
      source.checkedAt <= at &&
      at - source.checkedAt < 15 * 60000 &&
      rows.every((row) => !!row.commit && row.commit.parents.length >= 2),
  };
}
