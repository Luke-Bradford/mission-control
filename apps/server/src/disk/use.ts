/** What the hub holds on disk, by kind (#1756): the figures the Mac panel and the disk flag show. */
import { join } from "node:path";
import { DATA_DIRS, measure } from "./sweep.ts";

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

export function diskUse(i: { dataDir: string; worktrees: string | undefined }): DiskUse {
  const sum = (...paths: string[]): number => paths.reduce((n, p) => n + measure(p).bytes, 0);
  const at = (dir: string): string => join(i.dataDir, dir);
  const use = {
    worktrees: i.worktrees === undefined ? 0 : sum(i.worktrees),
    pictures: sum(at(DATA_DIRS.qaAssets), at(DATA_DIRS.reviewShots), at(DATA_DIRS.hudShots)),
    evidence: sum(at(DATA_DIRS.evidence)),
    scratch: sum(
      at(DATA_DIRS.controller),
      at(DATA_DIRS.evidenceWork),
      at(DATA_DIRS.designPreviews),
    ),
    database: sum(...DATABASE_FILES.map(at)),
  };
  return { ...use, total: Object.values(use).reduce((a, b) => a + b, 0) };
}
