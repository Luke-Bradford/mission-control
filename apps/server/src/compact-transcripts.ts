/**
 * One-off: rewrites the transcripts of ended crew runs in the compact form the keeper now writes
 * (#934; rules in runtime/transcript-compact.ts). Run it once after the Update, with the hub
 * running or not:
 *
 *   node --experimental-strip-types apps/server/src/compact-transcripts.ts [path/to/mc.sqlite]
 *
 * The DB is opened read-only and is never written. A run with no `ended_at` is live and is left
 * alone, as is a file that is missing or already compact (running it again changes nothing). Each
 * file is rewritten through a temp file in its folder and renamed over the original, so a reader
 * sees the old file or the new one, never half of one. Prints each rewrite's before and after
 * bytes, then the totals.
 */
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { compactTranscriptLine } from "./runtime/transcript-compact.ts";

export interface CompactResult {
  runId: string;
  path: string;
  before: number;
  after: number;
}

export interface CompactSummary {
  rewritten: CompactResult[];
  /** Runs without an end, and so possibly still writing. */
  skippedLive: number;
  /** Files already compact, or not there. */
  unchanged: number;
  failed: { runId: string; error: string }[];
}

/** Compacts a transcript's text: its lines through the keeper's rules; a final unterminated line is kept as it is. */
export function compactTranscriptText(text: string): string {
  const out: string[] = [];
  const parts = text.split("\n");
  const last = parts.length - 1;
  parts.forEach((line, i) => {
    if (i === last) {
      out.push(line); // "" after the final newline, or a line cut off by an exit
      return;
    }
    const kept = compactTranscriptLine(line);
    if (kept !== null) out.push(kept);
  });
  return out.join("\n");
}

/** Rewrites one file atomically; the sizes, or null when it is missing or already compact. */
export function compactTranscriptFile(path: string): { before: number; after: number } | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const compact = compactTranscriptText(text);
  if (compact === text) return null;
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.compact.tmp`;
  try {
    writeFileSync(tmp, compact, { mode: 0o600, flush: true });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { before: Buffer.byteLength(text), after: Buffer.byteLength(compact) };
}

/** Compacts every ended run's transcript in the DB at `dbPath`. */
export function compactTranscripts(
  dbPath: string,
  log: (line: string) => void = () => {},
): CompactSummary {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let runs: { id: string; transcript_path: string; ended_at: number | null }[];
  try {
    runs = db.prepare("SELECT id, transcript_path, ended_at FROM runs").all() as typeof runs;
  } finally {
    db.close();
  }
  const summary: CompactSummary = { rewritten: [], skippedLive: 0, unchanged: 0, failed: [] };
  for (const run of runs) {
    if (run.ended_at === null) {
      summary.skippedLive += 1;
      continue;
    }
    try {
      const sizes = compactTranscriptFile(run.transcript_path);
      if (sizes === null) {
        summary.unchanged += 1;
        continue;
      }
      summary.rewritten.push({ runId: run.id, path: run.transcript_path, ...sizes });
      log(`${run.id}  ${sizes.before} -> ${sizes.after} bytes`);
    } catch (e) {
      summary.failed.push({ runId: run.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath =
    process.argv[2] ??
    process.env.MC_DB ??
    join(homedir(), ".local", "share", "mission-control", "mc.sqlite");
  const s = compactTranscripts(dbPath, (line) => process.stdout.write(`${line}\n`));
  const before = s.rewritten.reduce((n, r) => n + r.before, 0);
  const after = s.rewritten.reduce((n, r) => n + r.after, 0);
  process.stdout.write(
    `${s.rewritten.length} rewritten (${before} -> ${after} bytes), ${s.unchanged} unchanged, ` +
      `${s.skippedLive} live skipped, ${s.failed.length} failed\n`,
  );
  for (const f of s.failed) process.stderr.write(`failed ${f.runId}: ${f.error}\n`);
  process.exitCode = s.failed.length === 0 ? 0 : 1;
}
