import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type Row = Record<string, SQLInputValue>;

/** One session's tokens on one local day with one model; counts only, never transcript text. */
export interface SessionSpendRecord {
  sessionId: string;
  /** Local YYYY-MM-DD. */
  day: string;
  model: string;
  /** The session's working folder, last seen. */
  cwd: string | null;
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

/** Where the reader stopped in one transcript file. */
export interface SessionSpendFile {
  path: string;
  offset: number;
  /** The size read to; -1 when a pass stopped short, so the next pass reads on. */
  size: number;
  mtime: number;
  /** The message id last counted; the next lines repeating it are skipped. */
  lastMessage: string | null;
}

const toRecord = (r: Row): SessionSpendRecord => ({
  sessionId: r.session_id as string,
  day: r.day as string,
  model: r.model as string,
  cwd: (r.cwd as string | null) ?? null,
  input: r.input as number,
  output: r.output as number,
  cacheWrite5m: r.cache_write_5m as number,
  cacheWrite1h: r.cache_write_1h as number,
  cacheRead: r.cache_read as number,
  costUsd: (r.cost_usd as number | null) ?? null,
  messages: r.messages as number,
  lastAt: r.last_at as number,
});

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
        lastMessage: (r.last_message as string | null) ?? null,
      };
    },

    /** Adds `records` to the stored counts and moves the file's offset, in one transaction. */
    addSessionSpend(file: SessionSpendFile, records: readonly SessionSpendRecord[]): void {
      transaction(() => {
        const add = db.prepare(
          `INSERT INTO session_spend (session_id, day, model, cwd, input, output, cache_write_5m,
             cache_write_1h, cache_read, cost_usd, messages, last_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id, day, model) DO UPDATE SET
             cwd = COALESCE(excluded.cwd, cwd), input = input + excluded.input,
             output = output + excluded.output,
             cache_write_5m = cache_write_5m + excluded.cache_write_5m,
             cache_write_1h = cache_write_1h + excluded.cache_write_1h,
             cache_read = cache_read + excluded.cache_read,
             cost_usd = cost_usd + excluded.cost_usd, messages = messages + excluded.messages,
             last_at = MAX(last_at, excluded.last_at)`,
        );
        for (const r of records)
          add.run(
            r.sessionId,
            r.day,
            r.model,
            r.cwd,
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
          `INSERT INTO session_spend_files (path, offset, size, mtime, last_message) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, size = excluded.size,
             mtime = excluded.mtime, last_message = excluded.last_message`,
        ).run(file.path, file.offset, file.size, file.mtime, file.lastMessage);
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
     * The crew seat behind each of `sessionIds` the hub knows: a run's session, else a seat's
     * live CLI session. repoId is the run's, or null for a seat session with no run.
     */
    sessionSpendOwners(
      sessionIds: readonly string[],
    ): Map<string, { agentId: string; repoId: string | null }> {
      const out = new Map<string, { agentId: string; repoId: string | null }>();
      if (sessionIds.length === 0) return out;
      const marks = sessionIds.map(() => "?").join(",");
      for (const r of db
        .prepare(
          `SELECT s.cli_session_id AS sid, s.seat_id AS agent, r.repo_id AS repo FROM seat_sessions s
           LEFT JOIN runs r ON r.id = s.run_id WHERE s.cli_session_id IN (${marks})`,
        )
        .all(...sessionIds) as Row[])
        out.set(r.sid as string, {
          agentId: r.agent as string,
          repoId: (r.repo as string | null) ?? null,
        });
      for (const r of db
        .prepare(
          `SELECT session_id AS sid, agent_id AS agent, repo_id AS repo FROM runs
           WHERE session_id IN (${marks})`,
        )
        .all(...sessionIds) as Row[])
        out.set(r.sid as string, { agentId: r.agent as string, repoId: r.repo as string });
      return out;
    },

    /** Drops rows last written before `before`, and file offsets of gone or older files. */
    pruneSessionSpend(before: number, exists: (path: string) => boolean): void {
      db.prepare("DELETE FROM session_spend WHERE last_at < ?").run(before);
      const gone = (
        db.prepare("SELECT path, mtime FROM session_spend_files").all() as Row[]
      ).filter((r) => (r.mtime as number) < before || !exists(r.path as string));
      if (gone.length === 0) return;
      transaction(() => {
        const del = db.prepare("DELETE FROM session_spend_files WHERE path = ?");
        for (const r of gone) del.run(r.path as string);
      });
    },
  };
}
