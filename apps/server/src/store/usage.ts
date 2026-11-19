import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AccountId, UsageSample } from "@mc/core";

type Row = Record<string, SQLInputValue>;

export const toSample = (r: Row): UsageSample => ({
  accountId: r.account_id as string,
  window: r.window as "5h" | "7d",
  at: r.at as number,
  pct: r.pct as number,
  resetAt: r.reset_at as number,
  source: r.source as string,
});

/**
 * The queries over the `usage_samples` table.
 */
export function usageQueries(db: DatabaseSync) {
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
  };
}
