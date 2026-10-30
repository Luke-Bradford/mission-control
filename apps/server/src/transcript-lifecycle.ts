import type { Dirent } from "node:fs";
import {
  createReadStream,
  createWriteStream,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { TranscriptFootprint } from "@mc/core";
import type { TranscriptRetention } from "./config.ts";
import { keeperAlive } from "./runtime/keeper.ts";
import { crewDirPath, crewKeeperDirPath, type Store } from "./store.ts";

export const TRANSCRIPT_PASS_INTERVAL_MS = 6 * 60 * 60_000;
export const TRANSCRIPT_PASS_FIRST_DELAY_MS = 60_000;
const TRANSCRIPT = /^(.+)\.jsonl(\.gz)?$/;

export interface TranscriptPassSummary {
  gzipped: number;
  deleted: number;
  skippedLive: number;
  failed: { runId: string; error: string }[];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function maintainTranscripts(i: {
  store: Store;
  now: number;
  retention: TranscriptRetention;
}): Promise<TranscriptPassSummary> {
  const out: TranscriptPassSummary = { gzipped: 0, deleted: 0, skippedLive: 0, failed: [] };
  const dir = crewDirPath(i.store.path);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    return out;
  }
  const active = new Set(i.store.activeSeatSessions().map((s) => s.runId));
  for (const entry of entries) {
    const found = TRANSCRIPT.exec(entry.name);
    if (!found || !entry.isFile()) continue;
    const id = found[1] as string;
    const path = `${dir}/${entry.name}`;
    const run = i.store.run(id);
    if (!run || run.transcriptPath !== `${dir}/${id}.jsonl`) continue;
    try {
      const st = lstatSync(path);
      if (!st.isFile()) continue;
      if (
        run.endedAt === null ||
        run.loop?.aside != null ||
        active.has(id) ||
        keeperAlive(crewKeeperDirPath(i.store.path, id))
      ) {
        out.skippedLive++;
        continue;
      }
      const age = i.now - Math.max(run.endedAt, st.mtimeMs);
      if (age >= i.retention.deleteAfterDays * 24 * 60 * 60_000) {
        rmSync(path);
        out.deleted++;
      } else if (!entry.name.endsWith(".gz") && age >= i.retention.gzipAfterHours * 60 * 60_000) {
        const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
        const tmp = `${path}.gz.tmp`;
        await pipeline(
          createReadStream(path),
          createGzip(),
          createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
        );
        const after = lstatSync(path);
        if (`${after.ino}:${after.size}:${after.mtimeMs}` !== stamp) {
          unlinkSync(tmp);
          out.skippedLive++;
          continue;
        }
        renameSync(tmp, `${path}.gz`);
        utimesSync(`${path}.gz`, st.atime, st.mtime);
        rmSync(path);
        out.gzipped++;
      }
    } catch (e) {
      out.failed.push({ runId: id, error: message(e) });
    }
  }
  return out;
}

/** Current on-disk crew footprint. Never creates the folder. */
export function transcriptFootprint(store: Store): TranscriptFootprint | null {
  const dir = crewDirPath(store.path);
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let totalBytes = 0;
  let oldestAt: number | null = null;
  const seats = new Map<string, { bytes: number; files: number }>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const st = lstatSync(`${dir}/${entry.name}`);
      totalBytes += st.size;
      const m = TRANSCRIPT.exec(entry.name);
      if (!m) continue;
      oldestAt = oldestAt === null ? st.mtimeMs : Math.min(oldestAt, st.mtimeMs);
      const run = store.run(m[1] as string);
      if (!run) continue;
      const seat = seats.get(run.agentId) ?? { bytes: 0, files: 0 };
      seat.bytes += st.size;
      seat.files++;
      seats.set(run.agentId, seat);
    } catch {
      // a concurrently removed file is omitted
    }
  }
  return {
    totalBytes,
    seats: [...seats].map(([seatId, v]) => ({ seatId, ...v })).sort((a, b) => b.bytes - a.bytes),
    oldestAt,
  };
}
