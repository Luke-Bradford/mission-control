/**
 * One-off: rewrites the transcripts of ended crew runs in the compact form the keeper now writes
 * (#934; rules in runtime/transcript-compact.ts). Run it once, with the hub stopped or right before
 * an Update restarts it:
 *
 *   node --experimental-strip-types apps/server/src/compact-transcripts.ts [path/to/mc.sqlite]
 *
 * The DB is opened read-only and is never written. Only crew runs are touched: a transcript must
 * be a regular file (not a link) inside the DB's `crew/` folder, which leaves the observed loops'
 * logs alone. A run is skipped when it has no `ended_at`, when its keeper is still alive, when its
 * file changed in the last 10 minutes, or when it is already compact (running it again changes
 * nothing). Each file is written to a temp file in its folder and renamed over the original,
 * after a check that the original has not changed since it was read, so a reader sees the old file
 * or the new one, never half of one. Prints each rewrite's before and after bytes, then the totals.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { keeperAlive } from "./runtime/keeper.ts";
import { compactTranscriptLine, deltaHeartbeats } from "./runtime/transcript-compact.ts";
import { crewDirPath, crewKeeperDirPath } from "./store.ts";

/** A file written to this recently may still have a writer. */
export const COMPACT_MIN_AGE_MS = 10 * 60 * 1000;

export interface CompactResult {
  runId: string;
  path: string;
  before: number;
  after: number;
}

export interface CompactSummary {
  rewritten: CompactResult[];
  /** Runs that may still be writing: no end, a live keeper, or a file written to lately. */
  skippedLive: number;
  /** Runs whose transcript is not a plain file inside `crew/` (the observed loops'). */
  skippedOutside: number;
  /** Files already compact, or not there. */
  unchanged: number;
  failed: { runId: string; error: string }[];
}

/** Compacts a transcript's text: its lines through the keeper's rules; a final unterminated line is kept as it is. */
export function compactTranscriptText(text: string): string {
  const out: string[] = [];
  const heartbeats = deltaHeartbeats();
  const parts = text.split("\n");
  const last = parts.length - 1;
  parts.forEach((line, i) => {
    if (i === last) {
      out.push(line); // "" after the final newline, or a line cut off by an exit
      return;
    }
    const kept = compactTranscriptLine(line, heartbeats);
    if (kept !== null) out.push(kept);
  });
  return out.join("\n");
}

/** A plain file (not a link) whose real path is inside `crewFolder`. */
function plainFileIn(crewFolder: string, path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return realpathSync(path).startsWith(`${realpathSync(crewFolder)}${sep}`);
  } catch {
    return false;
  }
}

const stamp = (path: string) => {
  const s = lstatSync(path);
  return `${s.ino}:${s.size}:${s.mtimeMs}`;
};

/**
 * Rewrites one file atomically; the sizes, or null when it is missing, already compact or changed
 * while it was being read (it is then left as it was).
 */
export function compactTranscriptFile(
  path: string,
  beforeRename: () => void = () => {},
): { before: number; after: number } | null {
  let text: string;
  let seen: string;
  try {
    seen = stamp(path);
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const compact = compactTranscriptText(text);
  if (compact === text) return null;
  const mode = lstatSync(path).mode & 0o777;
  const tmp = `${path}.compact.tmp`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, compact, { flag: "wx", mode: 0o600, flush: true });
    chmodSync(tmp, mode);
    beforeRename();
    if (stamp(path) !== seen) {
      rmSync(tmp, { force: true });
      return null; // a writer got there first
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return { before: Buffer.byteLength(text), after: Buffer.byteLength(compact) };
}

/** Compacts every ended run's transcript in the DB at `dbPath`. */
export function compactTranscripts(
  dbPath: string,
  log: (line: string) => void = () => {},
  now: number = Date.now(),
): CompactSummary {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let runs: { id: string; transcript_path: string; ended_at: number | null }[];
  try {
    runs = db.prepare("SELECT id, transcript_path, ended_at FROM runs").all() as typeof runs;
  } finally {
    db.close();
  }
  const summary: CompactSummary = {
    rewritten: [],
    skippedLive: 0,
    skippedOutside: 0,
    unchanged: 0,
    failed: [],
  };
  for (const run of runs) {
    if (run.ended_at === null || keeperAlive(crewKeeperDirPath(dbPath, run.id))) {
      summary.skippedLive += 1;
      continue;
    }
    if (!plainFileIn(crewDirPath(dbPath), run.transcript_path)) {
      summary.skippedOutside += 1;
      continue;
    }
    try {
      if (now - lstatSync(run.transcript_path).mtimeMs < COMPACT_MIN_AGE_MS) {
        summary.skippedLive += 1;
        continue;
      }
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
      `${s.skippedLive} live skipped, ${s.skippedOutside} outside crew/, ${s.failed.length} failed\n`,
  );
  for (const f of s.failed) process.stderr.write(`failed ${f.runId}: ${f.error}\n`);
  process.exitCode = s.failed.length === 0 ? 0 : 1;
}
