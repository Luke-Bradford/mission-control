import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AccountId, UsageSample } from "@mc/core";
import { toSample } from "./rows.ts";

type Row = Record<string, SQLInputValue>;

/** One controller message's token counts, as stored in `controller_messages`. */
export type ControllerMessageUsage = {
  id: string;
  at: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/** The totals `controllerUsageSince` returns. */
export type ControllerUsageTotals = {
  sessions: number;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/**
 * The queries over the `usage_samples`, `controller_messages` and `controller_files` tables.
 * `transaction` is the store's, so a batch of controller messages lands as one write.
 */
export function usageQueries(db: DatabaseSync, transaction: (fn: () => void) => void) {
  return {
    addUsage(s: UsageSample): void {
      db.prepare(
        "INSERT OR IGNORE INTO usage_samples (account_id, window, at, pct, reset_at, source) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(s.accountId, s.window, s.at, s.pct, s.resetAt, s.source);
    },

    usage(accountId: AccountId, window: "5h" | "7d", sinceMs: number): UsageSample[] {
      const rows = db
        .prepare(
          "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? AND at >= ? ORDER BY at ASC",
        )
        .all(accountId, window, sinceMs) as Row[];
      return rows.map(toSample);
    },

    /** The newest sample for an account and window, or null when there is none. */
    latestUsage(accountId: AccountId, window: "5h" | "7d"): UsageSample | null {
      const row = db
        .prepare(
          "SELECT * FROM usage_samples WHERE account_id = ? AND window = ? ORDER BY at DESC LIMIT 1",
        )
        .get(accountId, window) as Row | undefined;
      return row ? toSample(row) : null;
    },

    /**
     * Stores controller messages' usage numbers (never text). A message id seen again, in a resumed
     * session's copy of its history or a subagent file, counts once; the larger output is kept.
     */
    saveControllerMessages(sessionId: string, messages: readonly ControllerMessageUsage[]): void {
      const insert = db.prepare(
        `INSERT INTO controller_messages (message_id, session_id, at, input, cache_read, cache_write, output)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET output = MAX(output, excluded.output)`,
      );
      transaction(() => {
        for (const m of messages) {
          insert.run(m.id, sessionId, m.at, m.input, m.cacheRead, m.cacheWrite, m.output);
        }
      });
    },

    /** Controller usage by message time since `since`: distinct sessions, distinct messages and token sums. */
    controllerUsageSince(since: number): ControllerUsageTotals {
      return db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS calls,
           COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cache_read), 0) AS cacheRead,
           COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(output), 0) AS output
         FROM controller_messages WHERE at >= ?`,
        )
        .get(since) as never;
    },

    /** The mtime a controller file was last read at, or null when it has not been read. */
    controllerFileMtime(path: string): number | null {
      const r = db.prepare("SELECT mtime FROM controller_files WHERE path = ?").get(path) as
        | { mtime: number }
        | undefined;
      return r?.mtime ?? null;
    },

    markControllerFile(path: string, mtime: number): void {
      db.prepare("INSERT OR REPLACE INTO controller_files (path, mtime) VALUES (?, ?)").run(
        path,
        mtime,
      );
    },
  };
}
