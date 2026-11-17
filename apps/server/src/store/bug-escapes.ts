import type { DatabaseSync } from "node:sqlite";
import { type AuditBugEscape, type BugMissedReason, isBugLabelled } from "@mc/core";

type Row = Record<string, unknown>;

/** A closed bug ticket with a merged fix, not yet traced. */
export interface BugFixCandidate {
  issue: number;
  title: string;
  filedAt: number;
  fixPr: number;
  fixSha: string;
}

/**
 * Closed bug tickets of a repo with a merged fix PR (the PR's ticket or a closing issue), not yet
 * recorded: never tried first, then least recently tried, newest filed first within those. The latest merged PR naming the ticket is the fix.
 */
export function bugFixCandidates(
  db: DatabaseSync,
  repoId: string,
  limit: number,
): BugFixCandidate[] {
  const bugs = (
    db
      .prepare(
        `SELECT issue_number, title, labels, created_at FROM board_items
         WHERE repo_id = ? AND closed = 1 AND created_at > 0 AND NOT EXISTS (
           SELECT 1 FROM bug_escapes e WHERE e.repo_id = board_items.repo_id
             AND e.issue_number = board_items.issue_number)
         ORDER BY COALESCE((SELECT tried_at FROM bug_escape_tries t
           WHERE t.repo_id = board_items.repo_id AND t.issue_number = board_items.issue_number), 0),
           created_at DESC`,
      )
      .all(repoId) as Row[]
  ).filter((b) => isBugLabelled(JSON.parse(b.labels as string) as string[]));
  const live = db.prepare(
    `SELECT number, merged_at, merge_commit_sha AS sha FROM pull_requests
     WHERE repo_id = ? AND state = 'merged' AND merge_commit_sha IS NOT NULL AND merged_at IS NOT NULL
       AND (ticket = ? OR EXISTS (SELECT 1 FROM json_each(closing_issues) WHERE value = ?))`,
  );
  const old = db.prepare(
    `SELECT number, merged_at, json_extract(record, '$.mergeCommitSha') AS sha FROM pr_history
     WHERE repo_id = ? AND json_extract(record, '$.mergeCommitSha') IS NOT NULL
       AND (json_extract(record, '$.ticket') = ?
         OR EXISTS (SELECT 1 FROM json_each(record, '$.closingIssues') WHERE value = ?))`,
  );
  const out: BugFixCandidate[] = [];
  for (const b of bugs) {
    const issue = b.issue_number as number;
    const fixes = [
      ...(live.all(repoId, `${repoId}#${issue}`, issue) as Row[]),
      ...(old.all(repoId, `${repoId}#${issue}`, issue) as Row[]),
    ].sort((a, c) => (c.merged_at as number) - (a.merged_at as number));
    const fix = fixes[0];
    if (fix === undefined) continue;
    out.push({
      issue,
      title: b.title as string,
      filedAt: b.created_at as number,
      fixPr: fix.number as number,
      fixSha: fix.sha as string,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Notes that a bug's trace was tried and failed, so the next pass takes other bugs first. */
export function noteBugTraceTried(
  db: DatabaseSync,
  repoId: string,
  issue: number,
  at: number,
): void {
  db.prepare(
    `INSERT INTO bug_escape_tries (repo_id, issue_number, tried_at) VALUES (?, ?, ?)
     ON CONFLICT(repo_id, issue_number) DO UPDATE SET tried_at = excluded.tried_at`,
  ).run(repoId, issue, at);
}

/** What the hub recorded about the PR a bug came in on. */
export interface IntroducingPrFacts {
  /** When the hub saw it merge; null for a PR it never recorded. */
  mergedAt: number | null;
  hasReview: boolean;
  /** The Done-when lines its ticket's runs started with. */
  doneWhen: string[];
}

export function introducingPrFacts(
  db: DatabaseSync,
  repoId: string,
  pr: number,
): IntroducingPrFacts {
  const meta = (
    db
      .prepare(
        `SELECT merged_at, ticket FROM pull_requests WHERE repo_id = ? AND number = ?
       UNION ALL SELECT merged_at, json_extract(record, '$.ticket') FROM pr_history
       WHERE repo_id = ? AND number = ?`,
      )
      .all(repoId, pr, repoId, pr) as Row[]
  )[0];
  const hasReview =
    db
      .prepare(
        "SELECT 1 FROM reviews WHERE repo_id = ? AND pr_number = ? AND state = 'reported' LIMIT 1",
      )
      .get(repoId, pr) !== undefined;
  const number = /#(\d+)$/.exec((meta?.ticket as string | null | undefined) ?? "")?.[1];
  const doneWhen =
    number === undefined
      ? []
      : (
          db
            .prepare(
              `SELECT DISTINCT d.line FROM run_done_when d JOIN runs r ON r.id = d.run_id
               WHERE r.repo_id = ? AND r.ticket IN (?, ?)`,
            )
            .all(repoId, `${repoId}#${number}`, `#${number}`) as Row[]
        ).map((r) => r.line as string);
  return { mergedAt: (meta?.merged_at as number | null | undefined) ?? null, hasReview, doneWhen };
}

/** Records a traced bug once per ticket; a repeat leaves the row as it was. */
export function recordBugEscape(db: DatabaseSync, e: Omit<AuditBugEscape, "discoveryMs">): void {
  db.prepare(
    `INSERT OR IGNORE INTO bug_escapes
       (repo_id, issue_number, filed_at, fix_pr, commit_sha, introduced_pr, merged_at, missed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.repoId, e.issue, e.filedAt, e.fixPr, e.commit, e.introducedPr, e.mergedAt, e.missed);
}

/** Bugs filed in range, newest first, each with the time from the introducing merge to the filing. */
export function bugEscapes(db: DatabaseSync, since: number, until: number): AuditBugEscape[] {
  return (
    db
      .prepare(
        `SELECT repo_id, issue_number, filed_at, fix_pr, commit_sha, introduced_pr, merged_at, missed
         FROM bug_escapes WHERE filed_at >= ? AND filed_at <= ?
         ORDER BY filed_at DESC, issue_number DESC, repo_id`,
      )
      .all(since, until) as Row[]
  ).map((r) => ({
    repoId: r.repo_id as string,
    issue: r.issue_number as number,
    filedAt: r.filed_at as number,
    fixPr: r.fix_pr as number,
    commit: r.commit_sha as string,
    introducedPr: r.introduced_pr as number | null,
    mergedAt: r.merged_at as number,
    missed: r.missed as BugMissedReason,
    discoveryMs: Math.max(0, (r.filed_at as number) - (r.merged_at as number)),
  }));
}
