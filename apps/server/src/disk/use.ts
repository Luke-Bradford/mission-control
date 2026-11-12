/** What the hub holds on disk, by kind (#1756): the figures the Mac panel and the disk flag show. */
import { join } from "node:path";
import { DATA_DIRS, measure } from "./measure.ts";

export interface DiskUse {
  worktrees: number;
  pictures: number;
  evidence: number;
  scratch: number;
  database: number;
  total: number;
}

/** The database file and its write-ahead and shared-memory companions. */
const DATABASE_FILES = ["mc.sqlite", "mc.sqlite-wal", "mc.sqlite-shm"];
/** One measurement serves every reader for this long. */
export const DISK_USE_CACHE_MS = 60_000;

export interface DiskUseSource {
  dataDir: string;
  worktrees: string | undefined;
}

export async function diskUse(i: DiskUseSource): Promise<DiskUse> {
  // one kind after another: a walk of many gigabytes should not also hammer the disk
  const sum = async (...paths: string[]): Promise<number> => {
    let n = 0;
    for (const p of paths) n += (await measure(p)).bytes;
    return n;
  };
  const at = (dir: string): string => join(i.dataDir, dir);
  const use = {
    worktrees: i.worktrees === undefined ? 0 : await sum(i.worktrees),
    pictures: await sum(at(DATA_DIRS.qaAssets), at(DATA_DIRS.reviewShots), at(DATA_DIRS.hudShots)),
    evidence: await sum(at(DATA_DIRS.evidence)),
    scratch: await sum(
      at(DATA_DIRS.controller),
      at(DATA_DIRS.evidenceWork),
      at(DATA_DIRS.designPreviews),
    ),
    database: await sum(...DATABASE_FILES.map(at)),
  };
  return { ...use, total: Object.values(use).reduce((a, b) => a + b, 0) };
}

export interface DiskUseReader {
  /** The holdings, measured at most once per cache window; concurrent callers share one walk. */
  read(): Promise<DiskUse>;
  /** The last measurement, or null before the first one finished. For readers that must not wait. */
  last(): DiskUse | null;
}

export function cachedDiskUse(
  source: DiskUseSource,
  now: () => number = Date.now,
  measureUse: (s: DiskUseSource) => Promise<DiskUse> = diskUse,
): DiskUseReader {
  let cached: { at: number; use: DiskUse } | null = null;
  let walking: Promise<DiskUse> | null = null;
  return {
    read() {
      if (cached !== null && now() - cached.at < DISK_USE_CACHE_MS)
        return Promise.resolve(cached.use);
      walking ??= measureUse(source)
        .then((use) => {
          cached = { at: now(), use };
          return use;
        })
        .finally(() => {
          walking = null;
        });
      return walking;
    },
    last: () => cached?.use ?? null,
  };
}
