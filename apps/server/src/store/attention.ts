import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AttentionNote, NoteInput, NoteKind } from "./types.ts";

type Row = Record<string, SQLInputValue>;

/** The queries over the attention tables: the open notes and the episodes of each key. */

export function raiseNote(db: DatabaseSync, n: NoteInput): void {
  db.prepare(
    `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL
         WHERE attention_notes.cleared_at IS NOT NULL`,
  ).run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
}

export function refreshNote(db: DatabaseSync, n: NoteInput): void {
  db.prepare(
    `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = excluded.at, cleared_at = NULL, dismissed_at = NULL`,
  ).run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
}

export function refreshNoteInEpisode(db: DatabaseSync, n: NoteInput): void {
  db.prepare(
    `INSERT INTO attention_notes (key, kind, run_id, seat_id, repo_id, text, at, cleared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, run_id = excluded.run_id,
           seat_id = excluded.seat_id, repo_id = excluded.repo_id, text = excluded.text,
           at = CASE WHEN attention_notes.cleared_at IS NULL THEN attention_notes.at ELSE excluded.at END,
           dismissed_at = CASE WHEN attention_notes.cleared_at IS NULL THEN attention_notes.dismissed_at ELSE NULL END,
           cleared_at = NULL`,
  ).run(n.key, n.kind, n.runId, n.seatId, n.repoId, n.text, n.at);
}

export function clearNote(db: DatabaseSync, key: string, at: number): void {
  db.prepare("UPDATE attention_notes SET cleared_at = ? WHERE key = ? AND cleared_at IS NULL").run(
    at,
    key,
  );
}

export function clearNotesFor(db: DatabaseSync, runId: string, at: number): void {
  db.prepare(
    "UPDATE attention_notes SET cleared_at = ? WHERE run_id = ? AND cleared_at IS NULL",
  ).run(at, runId);
}

export function dismissNote(db: DatabaseSync, key: string, at: number): boolean {
  return (
    Number(
      db
        .prepare("UPDATE attention_notes SET dismissed_at = ? WHERE key = ? AND cleared_at IS NULL")
        .run(at, key).changes,
    ) > 0
  );
}

export function notes(db: DatabaseSync): AttentionNote[] {
  const rows = db
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

export function telemetryNoteIntervals(
  db: DatabaseSync,
  seatId: string,
  since: number,
  now: number,
  kinds: string[],
): [number, number][] {
  const rows = db
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

export function openNoteKeys(db: DatabaseSync, runId: string): string[] {
  const rows = db
    .prepare("SELECT key FROM attention_notes WHERE run_id = ? AND cleared_at IS NULL ORDER BY key")
    .all(runId) as { key: string }[];
  return rows.map((r) => r.key);
}

export function noteWaits(db: DatabaseSync, kinds: string[], since: number): number[] {
  if (kinds.length === 0) return [];
  const rows = db
    .prepare(`SELECT cleared_at - at AS wait FROM attention_notes
      WHERE kind IN (${kinds.map(() => "?").join(",")}) AND at >= ? AND cleared_at IS NOT NULL
      ORDER BY at, key`)
    .all(...kinds, since) as Row[];
  return rows.map((r) => r.wait as number);
}

export function noteRunStart(db: DatabaseSync, noteKey: string): number {
  const latest = db
    .prepare(
      `SELECT at FROM attention_episodes WHERE key = ?
         ORDER BY (cleared_at IS NULL) DESC, at DESC LIMIT 1`,
    )
    .get(noteKey) as { at: number } | undefined;
  if (latest === undefined) return 0;
  const before = db.prepare(
    `SELECT at FROM attention_episodes WHERE key = ? AND at < ? AND cleared_at >= ?
       ORDER BY at DESC LIMIT 1`,
  );
  let start = latest.at;
  for (let i = 0; i < 1000; i++) {
    const row = before.get(noteKey, start, start - 60_000) as { at: number } | undefined;
    if (row === undefined) break;
    start = row.at;
  }
  return start;
}
