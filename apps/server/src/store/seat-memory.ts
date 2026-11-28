import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  REPO_LESSONS_BRIEFED,
  type RepoLesson,
  type RepoLessonState,
  RUN_NOTE_EVENTS_MAX,
  type RunNotes,
  type StoredRunNotes,
} from "@mc/core";
import { parseJson } from "../json.ts";

type Row = Record<string, SQLInputValue>;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const toLesson = (r: Row): RepoLesson => ({
  id: r.id as number,
  repoId: r.repo_id as string,
  text: r.text as string,
  seatId: r.seat_id as string,
  runId: (r.run_id as string | null) ?? null,
  at: r.at as number,
  state: r.state as RepoLessonState,
  decidedAt: (r.decided_at as number | null) ?? null,
  decidedBy: (r.decided_by as string | null) ?? null,
});

/** A ticket's run notes (kept per ticket, so a fresh or later run reads them) and each repo's lessons. */
export function seatMemoryQueries(db: DatabaseSync) {
  return {
    /** Replaces the seat's part of the ticket's run notes. */
    putRunNotes(n: StoredRunNotes): void {
      const notes: RunNotes = {
        done: n.done,
        next: n.next,
        blockers: n.blockers,
        decisions: n.decisions,
      };
      db.prepare(
        `INSERT INTO run_notes (repo_id, ticket, run_id, seat_id, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, ticket) DO UPDATE SET
         run_id = excluded.run_id, seat_id = excluded.seat_id, notes = excluded.notes,
         updated_at = excluded.updated_at`,
      ).run(n.repoId, n.ticket, n.runId, n.seatId, JSON.stringify(notes), n.updatedAt);
    },

    runNotes(repoId: string, ticket: string): StoredRunNotes | null {
      const r = db
        .prepare("SELECT * FROM run_notes WHERE repo_id = ? AND ticket = ?")
        .get(repoId, ticket) as Row | undefined;
      if (r === undefined) return null;
      const notes = parseJson<Record<string, unknown>>(r.notes as string, {});
      return {
        repoId,
        ticket,
        runId: r.run_id as string,
        seatId: r.seat_id as string,
        updatedAt: r.updated_at as number,
        done: strings(notes.done),
        next: typeof notes.next === "string" ? notes.next : "",
        blockers: strings(notes.blockers),
        decisions: strings(notes.decisions),
      };
    },

    /** The hub's events on the ticket's runs (pushes, CI, holds, merges), newest last. */
    ticketEvents(repoId: string, ticket: string): { at: number; text: string }[] {
      return (
        db
          .prepare(
            `SELECT * FROM (
               SELECT e.at, e.text, e.key FROM loop_events e JOIN runs r ON r.id = e.run_id
               WHERE r.repo_id = ? AND r.ticket = ? AND e.text != ''
               ORDER BY e.at DESC, e.key DESC LIMIT ?
             ) ORDER BY at, key`,
          )
          .all(repoId, ticket, RUN_NOTE_EVENTS_MAX) as Row[]
      ).map((r) => ({ at: r.at as number, text: r.text as string }));
    },

    proposeLesson(l: {
      repoId: string;
      text: string;
      seatId: string;
      runId: string;
      at: number;
    }): number {
      const r = db
        .prepare(
          "INSERT INTO repo_lessons (repo_id, text, seat_id, run_id, at, state) VALUES (?, ?, ?, ?, ?, 'proposed')",
        )
        .run(l.repoId, l.text, l.seatId, l.runId, l.at);
      return Number(r.lastInsertRowid);
    },

    /** Accepts or rejects a proposed lesson; false when the repo has no such proposal. */
    decideLesson(repoId: string, id: number, accept: boolean, by: string, at: number): boolean {
      return (
        db
          .prepare(
            "UPDATE repo_lessons SET state = ?, decided_at = ?, decided_by = ? WHERE id = ? AND repo_id = ? AND state = 'proposed'",
          )
          .run(accept ? "accepted" : "rejected", at, by, id, repoId).changes === 1
      );
    },

    lesson(id: number): RepoLesson | null {
      const r = db.prepare("SELECT * FROM repo_lessons WHERE id = ?").get(id) as Row | undefined;
      return r === undefined ? null : toLesson(r);
    },

    /** The lessons FLIGHT accepted for a repo, newest first, as many as a brief lists. */
    acceptedLessons(repoId: string): RepoLesson[] {
      return (
        db
          .prepare(
            "SELECT * FROM repo_lessons WHERE repo_id = ? AND state = 'accepted' ORDER BY decided_at DESC, id DESC LIMIT ?",
          )
          .all(repoId, REPO_LESSONS_BRIEFED) as Row[]
      ).map(toLesson);
    },
  };
}
