import type { DatabaseSync } from "node:sqlite";
import { type AuditItem, auditTier } from "@mc/core";

/**
 * Records an Audit item once per kind and subject; its tier comes from the kind (unknown kinds
 * are Go-ahead). A repeat leaves the item as it was, except that an open item may become done.
 */
export function recordAuditItem(
  db: DatabaseSync,
  i: {
    kind: string;
    subject: string;
    state: AuditItem["state"];
    detail: string;
    at: number;
  },
): void {
  db.prepare(
    `INSERT INTO audit_items (kind, subject, tier, state, detail, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, subject) DO UPDATE SET state = excluded.state, detail = excluded.detail
         WHERE audit_items.state = 'open' AND excluded.state = 'done'`,
  ).run(i.kind, i.subject, auditTier(i.kind), i.state, i.detail, i.at);
}

/** Items recorded in range, newest first. */
export function auditItems(db: DatabaseSync, since: number, until: number): AuditItem[] {
  return db
    .prepare(
      `SELECT id, kind, subject, tier, state, detail, at FROM audit_items
         WHERE at >= ? AND at <= ? ORDER BY at DESC, id DESC`,
    )
    .all(since, until) as unknown as AuditItem[];
}

/** Keeps an Audit event's most recent successful occurrence. */
export function recordAuditEvent(db: DatabaseSync, kind: string, at: number): void {
  db.prepare(
    `INSERT INTO audit_events (kind, last_seen_at) VALUES (?, ?)
     ON CONFLICT(kind) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
  ).run(kind, at);
}

/** The observed time of a watched event, or null when the hub has never seen it. */
export function auditEventLastSeen(db: DatabaseSync, kind: string): number | null {
  const row = db.prepare("SELECT last_seen_at FROM audit_events WHERE kind = ?").get(kind) as
    | { last_seen_at: number }
    | undefined;
  return row?.last_seen_at ?? null;
}

/** Opens or clears the one Audit item representing a watched event's current silence. */
export function recordSilenceAlarm(
  db: DatabaseSync,
  subject: string,
  state: AuditItem["state"],
  detail: string,
  at: number,
): void {
  if (state === "done") {
    db.prepare(
      `UPDATE audit_items SET state = 'done', detail = ?, at = ?
       WHERE kind = 'silence-alarm' AND subject = ? AND state = 'open'`,
    ).run(detail, at, subject);
    return;
  }
  db.prepare(
    `INSERT INTO audit_items (kind, subject, tier, state, detail, at) VALUES ('silence-alarm', ?, 'flight', 'open', ?, ?)
     ON CONFLICT(kind, subject) DO UPDATE SET state = 'open', detail = excluded.detail, at = excluded.at`,
  ).run(subject, detail, at);
}

/** Records that a run's transcript could not give call times, so it is not tried again. */
export function markTokenTimesChecked(db: DatabaseSync, runId: string): void {
  db.prepare("UPDATE run_token_audit SET timestamps_checked = 1 WHERE run_id = ?").run(runId);
}
