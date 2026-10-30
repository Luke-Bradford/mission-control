import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import type { Run, TicketView } from "@mc/core";
import {
  applyFacts,
  branchTicket,
  DIGEST_RETENTION_MS,
  FOLD_WINDOW_MS,
  type FoldState,
  foldPath,
} from "./collectors/common.ts";
import { GqlError } from "./collectors/github.ts";
import { isRateLimitedError } from "./collectors/rate-limit.ts";
import { agentIds, type CcConfig } from "./config.ts";
import { parseTicket } from "./runview.ts";
import { crewDirPath, type Store } from "./store.ts";
import type { TranscriptFacts } from "./streamjson.ts";
import { transcriptFilePath } from "./transcript-file.ts";

/** Runs taken from the store per query. */
export const BACKFILL_BATCH = 20;

/** True when `path` is a non-empty regular file this process may read. Never throws. */
function readable(path: string): boolean {
  if (path === "") return false;
  try {
    const actual = transcriptFilePath(path);
    accessSync(actual, constants.R_OK);
    const st = statSync(actual);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * True when `path`, once symlinks and `..` are resolved, lies inside the crew transcript dir.
 * A stored `transcript_path` is data, not trusted: crew runs are read only from there.
 */
function inCrewDir(store: Store, path: string): boolean {
  try {
    return realpathSync(transcriptFilePath(path)).startsWith(
      `${realpathSync(crewDirPath(store.path))}${sep}`,
    );
  } catch {
    return false;
  }
}

/** True when the transcript named nothing: no session, no usage, no result (all lines cut or junk). */
const noFacts = (facts: TranscriptFacts): boolean =>
  facts.sessionId === null &&
  facts.resultCount === 0 &&
  Object.values(facts.tokens).every((n) => n === 0);

/**
 * Folds the transcripts of ended runs that started before the collectors' fold window
 * (FOLD_WINDOW_MS) and were never folded, newest first, for at most `budgetMs` (#26 A3, A7). The
 * budget is checked between runs, so one transcript is never split across calls. Each run is
 * marked folded once read, so the next call (or the next process) continues where this one
 * stopped. A run whose transcript is missing, empty, unreadable or names nothing, or whose agent
 * (a loop or a crew seat) is no longer configured, is marked folded unchanged: it is done, never
 * retried. So is a run whose read, fold or write throws (counted in `failed`); only a failure to
 * mark it folded propagates, so a busy database is retried on the next call. Only reads
 * transcripts (through foldPath), into a fresh map: never the collectors' or the supervisor's fold
 * state.
 */
export function backfillRuns(i: {
  config: CcConfig;
  store: Store;
  now: number;
  budgetMs: number;
  clock?: () => number;
}): { folded: number; left: number; failed: number } {
  const { config, store, now, budgetMs } = i;
  const clock = i.clock ?? (() => performance.now());
  const startedBefore = now - FOLD_WINDOW_MS;
  const agents = new Set(agentIds(config));
  const seats = new Set(crewSeatIds(config));
  const start = clock();
  let folded = 0;
  let failed = 0;

  const fold = (run: Run) => {
    if (
      !agents.has(run.agentId) ||
      !readable(run.transcriptPath) ||
      (seats.has(run.agentId) && !inCrewDir(store, run.transcriptPath))
    ) {
      store.upsertRun(run, true);
      return;
    }
    const facts = foldPath(new Map<string, FoldState>(), run.transcriptPath, undefined, run.vendor);
    if (facts === null || noFacts(facts)) {
      store.upsertRun(run, true); // gone between the check and the read, or nothing in it
      return;
    }
    const branch = run.branch;
    applyFacts(run, facts);
    run.branch = branch ?? run.branch; // a stored branch stays
    run.ticket = branchTicket(run);
    store.upsertRun(run, true);
    if (run.startedAt >= now - DIGEST_RETENTION_MS) store.setDigest(run.id, facts.digest);
  };

  outer: while (clock() - start < budgetMs) {
    const batch = store.runsToFold(BACKFILL_BATCH, startedBefore);
    if (batch.length === 0) break;
    for (const run of batch) {
      if (clock() - start >= budgetMs) break outer;
      const stored = structuredClone(run); // fold() writes the transcript's facts onto `run`
      try {
        fold(run);
      } catch {
        store.upsertRun(stored, true); // done, unchanged; if this throws, the next call retries
        failed += 1;
      }
      folded += 1;
    }
  }
  return { folded, left: store.countToFold(startedBefore), failed };
}

const crewSeatIds = (config: CcConfig): string[] =>
  (config.crew?.sessions ?? []).flatMap((s) => s.seats.map((x) => x.id));

/** Set once every past crew run's summary has been rewritten (see rewriteCrewSummaries). */
export const SUMMARY_REWRITE_DONE = "crew-summaries-rewritten";
/** Where the rewrite stopped: `<startedAt>:<run id>` of the last run it read. */
const SUMMARY_REWRITE_CURSOR = "crew-summaries-cursor";

/**
 * One-off, for crew runs folded before summaries described the work (they read "DONE."): reads
 * the ended crew runs' transcripts, newest first, for at most `budgetMs`, and rewrites each
 * summary (and the digest, where one is kept) from the transcript. The cursor is kept in the store,
 * so a restart continues where it stopped; once the last run is read SUMMARY_REWRITE_DONE is set
 * and later calls do nothing (a config with no crew seats does not set it). A run whose transcript is gone, unreadable, empty or
 * outside the crew transcript dir is left as it is.
 *
 * Crash windows, both accepted: the cursor is written before each run is read, so a crash while
 * reading a run skips it for good (a transcript that crashes the process is never retried). The
 * summary and the digest are separate writes (`setRunSummary`, `setDigest`), so a crash between
 * them leaves the new summary with the old digest; the run is not read again.
 */
export function rewriteCrewSummaries(i: {
  config: CcConfig;
  store: Store;
  budgetMs: number;
  clock?: () => number;
}): { rewritten: number; done: boolean } {
  const { config, store, budgetMs } = i;
  if (store.getSetting(SUMMARY_REWRITE_DONE) !== null) return { rewritten: 0, done: true };
  const clock = i.clock ?? (() => performance.now());
  const start = clock();
  const seats = crewSeatIds(config);
  // No seats configured (yet): nothing to rewrite, and not done for good either.
  if (seats.length === 0) return { rewritten: 0, done: true };
  const saved = store.getSetting(SUMMARY_REWRITE_CURSOR);
  const colon = saved === null ? -1 : saved.indexOf(":");
  let after =
    saved === null || colon < 0
      ? null
      : { startedAt: Number(saved.slice(0, colon)), id: saved.slice(colon + 1) };
  let rewritten = 0;
  while (clock() - start < budgetMs) {
    const batch = store.endedRunsPage(seats, after, BACKFILL_BATCH);
    if (batch.length === 0) {
      store.setSetting(SUMMARY_REWRITE_DONE, "1");
      store.deleteSetting(SUMMARY_REWRITE_CURSOR);
      return { rewritten, done: true };
    }
    for (const run of batch) {
      if (clock() - start >= budgetMs) return { rewritten, done: false };
      after = { startedAt: run.startedAt, id: run.id };
      store.setSetting(SUMMARY_REWRITE_CURSOR, `${run.startedAt}:${run.id}`);
      if (!readable(run.transcriptPath) || !inCrewDir(store, run.transcriptPath)) continue;
      try {
        const facts = foldPath(
          new Map<string, FoldState>(),
          run.transcriptPath,
          undefined,
          run.vendor,
        );
        if (facts === null || facts.summary === null) continue;
        if (facts.summary !== run.summary) {
          store.setRunSummary(run.id, facts.summary);
          rewritten += 1;
        }
        if (store.digest(run.id) !== null) store.setDigest(run.id, facts.digest);
      } catch {
        // Unreadable or unfoldable: left as it was, and not tried again.
      }
    }
  }
  return { rewritten, done: false };
}

/** Set once every past crew run's ticket has had its title looked up (see fillTicketTitles). */
export const TITLES_FILLED_DONE = "crew-titles-filled";
/** Where the title fill stopped: `<startedAt>:<run id>` of the last run it handled. */
const TITLES_CURSOR = "crew-titles-cursor";
/** GitHub reads per fillTicketTitles call. */
export const TITLE_FETCH_MAX = 20;

/**
 * One-off, for crew runs whose ticket is off the project board and that have no stored title:
 * reads each ticket's title from GitHub (at most `max` reads per call, newest run first), and sets
 * it on every run of that ticket. A ticket GitHub does not have is skipped. The cursor is kept in
 * the store, so a restart continues where it stopped; once the last run is handled
 * TITLES_FILLED_DONE is set and later calls do nothing (a config with no crew seats does not set
 * it). A failed read stops the call without moving the cursor, so the next call retries it.
 * Returns how many runs got a title. A crash after the cursor moves loses nothing: the cursor is
 * written after the title.
 */
export async function fillTicketTitles(i: {
  config: CcConfig;
  store: Store;
  fetchTicket: (
    repo: CcConfig["repos"][number],
    n: number,
  ) => Promise<Pick<TicketView, "title"> | null>;
  max?: number;
}): Promise<{ filled: number; done: boolean }> {
  const { config, store, fetchTicket } = i;
  const max = i.max ?? TITLE_FETCH_MAX;
  if (store.getSetting(TITLES_FILLED_DONE) !== null) return { filled: 0, done: true };
  const seats = crewSeatIds(config);
  if (seats.length === 0) return { filled: 0, done: true };
  const saved = store.getSetting(TITLES_CURSOR);
  const colon = saved === null ? -1 : saved.indexOf(":");
  let after =
    saved === null || colon < 0
      ? null
      : { startedAt: Number(saved.slice(0, colon)), id: saved.slice(colon + 1) };
  let filled = 0;
  let fetched = 0;
  for (;;) {
    const batch = store.untitledRunsPage(seats, after, BACKFILL_BATCH);
    if (batch.length === 0) {
      store.setSetting(TITLES_FILLED_DONE, "1");
      store.deleteSetting(TITLES_CURSOR);
      return { filled, done: true };
    }
    for (const run of batch) {
      const t = run.ticket === null ? null : parseTicket(run.ticket);
      const repo = t === null ? undefined : config.repos.find((r) => r.id === t.repoId);
      // Another run of the same ticket in this call may have set the title already.
      if (t !== null && repo !== undefined && store.run(run.id)?.ticketTitle == null) {
        if (fetched >= max) return { filled, done: false };
        fetched += 1;
        let ticket: Pick<TicketView, "title"> | null;
        try {
          ticket = await fetchTicket(repo, t.number);
        } catch (e) {
          // a transport or rate-limit failure: the cursor stays and the next call retries it;
          // GitHub answered about this ticket (no repo, no access): skip it
          if (!(e instanceof GqlError) || e.errors.some(isRateLimitedError))
            return { filled, done: false };
          ticket = null;
        }
        const title = ticket?.title.trim() ?? "";
        if (title !== "") filled += store.setTicketTitle(run.repoId, run.ticket as string, title);
      }
      after = { startedAt: run.startedAt, id: run.id };
      store.setSetting(TITLES_CURSOR, `${run.startedAt}:${run.id}`);
    }
  }
}
