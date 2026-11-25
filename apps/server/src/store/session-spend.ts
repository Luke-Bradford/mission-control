import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SpendTokens } from "@mc/core";

type Row = Record<string, SQLInputValue>;

/** Who a session's spend belongs to, decided when its lines were read. */
export type SpendOwner = "operator" | "crew" | "flight";

/**
 * One transcript file's tokens for one session, local day and model; counts only, never
 * transcript text. Owner and repo are decided when the row is first written and never change.
 */
export interface SessionSpendRecord {
  /** The transcript file the counts were read from. */
  path: string;
  sessionId: string;
  /** Local YYYY-MM-DD. */
  day: string;
  model: string;
  owner: SpendOwner;
  /** Null when the session's folder is in no repo. */
  repo: string | null;
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** ~USD; null when the model has no price. */
  costUsd: number | null;
  messages: number;
  lastAt: number;
}

/** The message last counted in a file: what was added for it, so a fuller later line adds only the rest. */
export interface SessionSpendLastUsage {
  id: string;
  sessionId: string;
  day: string;
  model: string;
  fast: boolean;
  tokens: SpendTokens;
}

/** Where the reader stopped in one transcript file. */
export interface SessionSpendFile {
  path: string;
  offset: number;
  /** The size read to; -1 when a pass stopped short, so the next pass reads on. */
  size: number;
  mtime: number;
  /** The message last counted (ids and counts only). */
  last: SessionSpendLastUsage | null;
}

const toRecord = (r: Row): SessionSpendRecord => ({
  path: r.path as string,
  sessionId: r.session_id as string,
  day: r.day as string,
  model: r.model as string,
  owner: r.owner as SpendOwner,
  repo: (r.repo as string | null) ?? null,
  input: r.input as number,
  output: r.output as number,
  cacheWrite5m: r.cache_write_5m as number,
  cacheWrite1h: r.cache_write_1h as number,
  cacheRead: r.cache_read as number,
  costUsd: (r.cost_usd as number | null) ?? null,
  messages: r.messages as number,
  lastAt: r.last_at as number,
});

const parseLast = (text: string | null): SessionSpendLastUsage | null => {
  if (text === null) return null;
  try {
    return JSON.parse(text) as SessionSpendLastUsage;
  } catch {
    return null;
  }
};

/** The queries over `session_spend` and `session_spend_files`. */
export function sessionSpendQueries(db: DatabaseSync, transaction: (fn: () => void) => void) {
  return {
    sessionSpendFile(path: string): SessionSpendFile | null {
      const r = db.prepare("SELECT * FROM session_spend_files WHERE path = ?").get(path) as
        | Row
        | undefined;
      if (!r) return null;
      return {
        path,
        offset: r.offset as number,
        size: r.size as number,
        mtime: r.mtime as number,
        last: parseLast((r.last_usage as string | null) ?? null),
      };
    },

    /**
     * Adds `records` to the stored counts and moves the file's offset, in one transaction. With
     * `reset` (the file shrank and was read again from its start) the file's earlier rows go first.
     * A row's owner and repo stay as first written.
     */
    addSessionSpend(
      file: SessionSpendFile,
      records: readonly SessionSpendRecord[],
      reset = false,
    ): void {
      transaction(() => {
        if (reset) db.prepare("DELETE FROM session_spend WHERE path = ?").run(file.path);
        const add = db.prepare(
          `INSERT INTO session_spend (path, session_id, day, model, owner, repo, input, output,
             cache_write_5m, cache_write_1h, cache_read, cost_usd, messages, last_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (path, session_id, day, model) DO UPDATE SET
             input = input + excluded.input, output = output + excluded.output,
             cache_write_5m = cache_write_5m + excluded.cache_write_5m,
             cache_write_1h = cache_write_1h + excluded.cache_write_1h,
             cache_read = cache_read + excluded.cache_read,
             cost_usd = cost_usd + excluded.cost_usd, messages = messages + excluded.messages,
             last_at = MAX(last_at, excluded.last_at)`,
        );
        for (const r of records)
          add.run(
            r.path,
            r.sessionId,
            r.day,
            r.model,
            r.owner,
            r.repo,
            r.input,
            r.output,
            r.cacheWrite5m,
            r.cacheWrite1h,
            r.cacheRead,
            r.costUsd,
            r.messages,
            r.lastAt,
          );
        db.prepare(
          `INSERT INTO session_spend_files (path, offset, size, mtime, last_usage) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, size = excluded.size,
             mtime = excluded.mtime, last_usage = excluded.last_usage`,
        ).run(
          file.path,
          file.offset,
          file.size,
          file.mtime,
          file.last === null ? null : JSON.stringify(file.last),
        );
      });
    },

    /** Every stored row on or after local day `sinceDay` (YYYY-MM-DD). */
    sessionSpendSince(sinceDay: string): SessionSpendRecord[] {
      return (db.prepare("SELECT * FROM session_spend WHERE day >= ?").all(sinceDay) as Row[]).map(
        toRecord,
      );
    },

    /** The rows of `sessionIds` on or after local day `sinceDay`. */
    sessionSpendOf(sessionIds: readonly string[], sinceDay: string): SessionSpendRecord[] {
      if (sessionIds.length === 0) return [];
      const marks = sessionIds.map(() => "?").join(",");
      return (
        db
          .prepare(`SELECT * FROM session_spend WHERE day >= ? AND session_id IN (${marks})`)
          .all(sinceDay, ...sessionIds) as Row[]
      ).map(toRecord);
    },

    /**
     * The crew seat behind `sessionId` if the hub knows it: a run's session, else a seat's live
     * CLI session. repoId is the run's, or null for a seat session with no run.
     */
    sessionSpendOwner(sessionId: string): { agentId: string; repoId: string | null } | null {
      const run = db
        .prepare("SELECT agent_id, repo_id FROM runs WHERE session_id = ? LIMIT 1")
        .get(sessionId) as Row | undefined;
      if (run) return { agentId: run.agent_id as string, repoId: run.repo_id as string };
      const seat = db
        .prepare(
          `SELECT s.seat_id AS agent, r.repo_id AS repo FROM seat_sessions s
           LEFT JOIN runs r ON r.id = s.run_id WHERE s.cli_session_id = ? LIMIT 1`,
        )
        .get(sessionId) as Row | undefined;
      return seat
        ? { agentId: seat.agent as string, repoId: (seat.repo as string | null) ?? null }
        : null;
    },

    /**
     * Drops rows last written before `before`, and the offsets of files that are gone or last
     * changed before it. Returns the rows and offsets deleted.
     */
    pruneSessionSpend(
      before: number,
      exists: (path: string) => boolean,
    ): { rows: number; files: number } {
      const rows = Number(
        db.prepare("DELETE FROM session_spend WHERE last_at < ?").run(before).changes,
      );
      const gone = (
        db.prepare("SELECT path, mtime FROM session_spend_files").all() as Row[]
      ).filter((r) => (r.mtime as number) < before || !exists(r.path as string));
      if (gone.length > 0)
        transaction(() => {
          const del = db.prepare("DELETE FROM session_spend_files WHERE path = ?");
          for (const r of gone) del.run(r.path as string);
        });
      return { rows, files: gone.length };
    },
  };
}
