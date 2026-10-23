import { readFileSync } from "node:fs";
import type { TestLock } from "../guard/lock.ts";
import type { RunTokens } from "../mcp/tokens.ts";
import { crewTokenPath, type Store } from "../store.ts";

export interface RestoreDeps {
  store: Store;
  dbPath: string;
  tokens: RunTokens;
  lock: TestLock;
  log: (line: string) => void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Before the server listens: each active run's token (from its 0600 file) and its stored test-lock
 * holds, so a seat that kept running across a restart is not locked out. Never throws. The
 * supervisor drops what belongs to a run it does not reattach.
 */
export function restoreRuns(deps: RestoreDeps): { tokens: number; holds: number } {
  const { store, dbPath, tokens, lock, log } = deps;
  const result = { tokens: 0, holds: 0 };
  let active: ReturnType<Store["activeSeatSessions"]>;
  try {
    active = store.activeSeatSessions();
  } catch (e) {
    log(`crew: could not restore runs: ${message(e)}`);
    return result;
  }
  const activeRuns = new Set<string>();
  for (const row of active) {
    if (row.runId === null) continue;
    activeRuns.add(row.runId);
    try {
      const text = readFileSync(crewTokenPath(dbPath, row.runId), "utf8");
      if (tokens.adopt(row.seatId, row.runId, text)) result.tokens++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      log(`crew: could not read the token of ${row.runId}: ${message(e)}`);
    }
  }
  try {
    const rows = store.lockHolds();
    for (const runId of new Set(rows.map((r) => r.runId))) {
      if (!activeRuns.has(runId)) store.deleteLockHolds(runId);
    }
    const kept = rows.filter((r) => activeRuns.has(r.runId));
    lock.restore(kept);
    result.holds = kept.length;
  } catch (e) {
    log(`test lock: could not store a hold: ${message(e)}`);
  }
  return result;
}
