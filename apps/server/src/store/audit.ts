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
