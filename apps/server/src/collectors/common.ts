import { statSync } from "node:fs";
import { inferTicket, type Run, type RunDigest } from "@mc/core";
import type { AdoptedLoop } from "../config.ts";
import type { Store } from "../store.ts";
import { foldTranscript, type TranscriptFacts } from "../streamjson.ts";
import { readNewLines } from "../tail.ts";

/** The collector-status name a loop's collector writes: `ta-loop:<id>` or `studio-loop:<id>`. */
export const collectorName = (kind: AdoptedLoop["kind"], id: AdoptedLoop["id"]): string =>
  `${kind}:${id}`;

/** The status row holding a loop's note (shown on its HUD row): `<collectorName>:note`. */
export const noteCollectorName = (kind: AdoptedLoop["kind"], id: AdoptedLoop["id"]): string =>
  `${collectorName(kind, id)}:note`;

/** Runs started within this window get their transcript folded (cost/tokens); older runs do not. */
export const FOLD_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Run digests are kept for runs started within this window. */
export const DIGEST_RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface FoldState {
  facts: TranscriptFacts;
  offset: number;
}

/** Read every complete line from `from` to the end of the file, looping over bounded reads. */
export function readAllLines(
  path: string,
  from: number,
  onError?: (err: unknown) => void,
): { lines: string[]; next: number; reset: boolean } {
  const lines: string[] = [];
  let offset = from;
  let reset = false;
  for (;;) {
    const r = readNewLines(path, offset, onError ? { onError } : {});
    if (r.reset) {
      reset = true;
      lines.length = 0;
    }
    lines.push(...r.lines);
    if (r.nextOffset === offset && !r.reset) break;
    offset = r.nextOffset;
  }
  return { lines, next: offset, reset };
}

/**
 * Read any new transcript lines for `path` into the in-memory facts (re-folding from 0 as needed).
 * Folds one bounded read (`maxBytes`, default MAX_READ_BYTES) at a time, so memory is bounded by
 * the read cap plus one line however long the transcript is.
 */
export function foldPath(
  transcripts: Map<string, FoldState>,
  path: string,
  maxBytes?: number,
): TranscriptFacts | null {
  let mtime: number;
  try {
    mtime = Math.floor(statSync(path).mtimeMs);
  } catch {
    return transcripts.get(path)?.facts ?? null;
  }
  const prev = transcripts.get(path);
  let facts = prev?.facts ?? null;
  let offset = prev?.offset ?? 0;
  let folded = false;
  for (;;) {
    const r = readNewLines(path, offset, maxBytes === undefined ? {} : { maxBytes });
    if (r.reset) {
      facts = null;
      folded = false;
    }
    if (r.lines.length > 0) {
      facts = foldTranscript(facts, r.lines, mtime);
      folded = true;
    }
    if (r.nextOffset === offset && !r.reset) break;
    offset = r.nextOffset;
  }
  // Nothing new (or a reset to an empty file): fold no lines, as the mtime still moves the facts.
  if (!folded) facts = foldTranscript(facts, [], mtime);
  transcripts.set(path, { facts: facts as TranscriptFacts, offset });
  return facts;
}

/**
 * Drops the in-memory fold state of runs the collectors will not fold again: `transcripts` (by
 * path) and `digests` (by run id) are read only for in-flight runs and runs started within
 * FOLD_WINDOW_MS, so every other entry is dead weight. An ended run's final fold is already in the
 * store by then. Costs one `runsOverlapping` read of the last 24 h of runs on each poll.
 */
export function pruneFoldState(
  store: Store,
  state: { transcripts: Map<string, FoldState>; digests: Map<string, string> },
  now: number,
): void {
  const live = store.runsOverlapping(now - FOLD_WINDOW_MS, now + 1);
  const ids = new Set(live.map((r) => r.id));
  const paths = new Set(live.map((r) => r.transcriptPath));
  for (const id of state.digests.keys()) if (!ids.has(id)) state.digests.delete(id);
  for (const path of state.transcripts.keys()) if (!paths.has(path)) state.transcripts.delete(path);
}

/**
 * Copies folded transcript facts onto `r`, which holds what is already known of the run (the
 * stored row). A transcript that does not name a session, model or branch never nulls a known
 * one; cost, tokens, PRs and summary are the transcript's.
 */
export function applyFacts(r: Run, facts: TranscriptFacts): void {
  r.sessionId = facts.sessionId ?? r.sessionId;
  r.model = facts.model ?? r.model;
  r.branch = facts.branch ?? r.branch;
  r.costUsd = facts.costUsd;
  r.tokens = facts.tokens;
  r.prs = facts.prs.map((p) => ({ ...p }));
  r.summary = facts.summary;
  if (facts.latestPlan !== undefined) r.latestPlan = facts.latestPlan;
}

/** The ticket `r.branch` names, else the ticket `r` already has (a known ticket is never nulled). */
export const branchTicket = (r: Run): string | null => inferTicket(r.branch, r.repoId) ?? r.ticket;

/**
 * Writes a run's digest when it differs from the last one written for that run (`written`: run id
 * → its JSON). Separate from the run row's own change check: a tool result changes the digest
 * without changing tokens or cost.
 */
export function persistDigest(
  store: Store,
  written: Map<string, string>,
  runId: string,
  digest: RunDigest,
): void {
  const json = JSON.stringify(digest);
  if (written.get(runId) === json) return;
  store.setDigest(runId, digest);
  written.set(runId, json);
}
