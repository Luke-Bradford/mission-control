/**
 * The hub's housekeeping of its own data folder (#1756): pictures and evidence live only while the
 * work they belong to is open, and scratch copies go after a few days. Deletes only inside the data
 * folder and never follows a symlink: a link, or anything that resolves outside the folder, is left.
 */
import type { Stats } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { DATA_DIRS, measure, safeList } from "./measure.ts";
import type { DiskUse } from "./use.ts";

/** A scratch folder untouched this long is removed. */
export const SCRATCH_MAX_AGE_MS = 3 * 86_400_000;
/** A finished PR's files stay this long, so a PR that has only just closed can still be read. */
export const FINISHED_GRACE_MS = 3_600_000;
/** Scratch touched this recently may be a running preview or capture: the budget never removes it. */
export const SCRATCH_IN_USE_MS = 86_400_000;
/** The hub's default disk budget, and the variable that overrides it (whole or decimal GB). */
export const DISK_BUDGET_GB = 10;
export const DISK_BUDGET_ENV = "MC_DISK_BUDGET_GB";
export function diskBudgetBytes(env: NodeJS.ProcessEnv): number {
  const gb = Number(env[DISK_BUDGET_ENV]);
  return (Number.isFinite(gb) && gb > 0 ? gb : DISK_BUDGET_GB) * 1024 ** 3;
}
/** How often the hub runs the sweep. */
export const DISK_SWEEP_EVERY_MS = 3_600_000;
/** The one folder under `controller/` that is kept. */
export const CONTROLLER_KEEP = "designs";

const PR_DIR = /^[1-9][0-9]*$/;

export interface SweepInput {
  dataDir: string;
  now: () => number;
  /** Open PRs as `repoId#number`; every other PR's evidence is finished work. */
  openPrs: ReadonlySet<string>;
  /** QA image ids (sha256 hex) cited by a report of an open PR. */
  citedAssets: ReadonlySet<string>;
  /** Review screenshot ids that belong to a review of an open PR. */
  keptShots: ReadonlySet<string>;
  /** The most the hub may hold. Over it, idle scratch goes oldest first; open work is never removed. Absent: no cap. */
  budgetBytes?: number;
  /** What the hub holds by kind, for the budget check and its log line (worktrees are the tidy's). */
  holdings?: () => Promise<DiskUse>;
  log: (line: string) => void;
}

export interface SweepResult {
  /** Items removed (a folder counts once). */
  files: number;
  bytes: number;
}

export async function sweepDataFolder(i: SweepInput): Promise<SweepResult> {
  let root: string;
  try {
    root = await realpath(i.dataDir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  const now = i.now();
  const result: SweepResult = { files: 0, bytes: 0 };
  // Measured before any removal, so the removals below are subtracted from it exactly once.
  const held = i.budgetBytes !== undefined && i.holdings !== undefined ? await i.holdings() : null;

  /** Removes `path` when it is a real entry inside the data folder and `due` says so. */
  const remove = async (path: string, due: (newest: number) => boolean): Promise<void> => {
    try {
      const st: Stats = await lstat(path);
      if (st.isSymbolicLink()) return;
      if (!(await realpath(path)).startsWith(root + sep)) return;
    } catch {
      return;
    }
    const m = await measure(path);
    if (!due(m.newest)) return;
    try {
      await rm(path, { recursive: true, force: true });
    } catch {
      return;
    }
    result.files += 1;
    result.bytes += m.bytes;
  };
  const finished = (newest: number): boolean => now - newest > FINISHED_GRACE_MS;
  const stale = (newest: number): boolean => now - newest > SCRATCH_MAX_AGE_MS;
  const idle = (newest: number): boolean => now - newest > SCRATCH_IN_USE_MS;
  const scratchDirs = [DATA_DIRS.controller, DATA_DIRS.evidenceWork];
  // Folders only: plain files under controller/ are the controller monitor's own state.
  const scratchOf = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const name of await safeList(join(root, dir))) {
      if (dir === DATA_DIRS.controller && name === CONTROLLER_KEEP) continue;
      if ((await lstat(join(root, dir, name)).catch(() => null))?.isDirectory()) out.push(name);
    }
    return out;
  };

  // evidence: <repo>/<pr>/<head sha>/...
  const evidence = join(root, DATA_DIRS.evidence);
  for (const repo of await safeList(evidence)) {
    for (const pr of await safeList(join(evidence, repo))) {
      if (!PR_DIR.test(pr) || i.openPrs.has(`${repo}#${pr}`)) continue;
      await remove(join(evidence, repo, pr), finished);
    }
  }
  // a picture file keyed by an id: gone unless an open PR's work still cites it
  const pictures = async (dir: string, keep: ReadonlySet<string>): Promise<void> => {
    for (const name of await safeList(join(root, dir))) {
      if (!name.endsWith(".png") || keep.has(name.slice(0, -4))) continue;
      await remove(join(root, dir, name), finished);
    }
  };
  await pictures(DATA_DIRS.qaAssets, i.citedAssets);
  await pictures(DATA_DIRS.reviewShots, i.keptShots);
  // scratch: every child of these folders, once untouched for 3 days
  for (const dir of scratchDirs) {
    for (const name of await scratchOf(dir)) await remove(join(root, dir, name), stale);
  }

  if (i.budgetBytes !== undefined && held !== null) {
    // Open work (evidence, pictures an open PR cites) is never a candidate, and neither is scratch a
    // run may still be using. What is left to remove is idle scratch, oldest first.
    const budget = i.budgetBytes;
    let over = held.total - held.worktrees - result.bytes - budget;
    if (over > 0) {
      i.log(
        `disk budget: the hub is over its budget of ${budget} bytes; it holds worktrees ${held.worktrees}, pictures ${held.pictures}, evidence ${held.evidence}, scratch ${held.scratch}, database ${held.database}`,
      );
      const idleScratch: { path: string; newest: number }[] = [];
      for (const dir of scratchDirs) {
        for (const name of await scratchOf(dir)) {
          const path = join(root, dir, name);
          const m = await measure(path);
          if (idle(m.newest)) idleScratch.push({ path, newest: m.newest });
        }
      }
      idleScratch.sort((a, b) => a.newest - b.newest);
      for (const c of idleScratch) {
        if (over <= 0) break;
        const was = result.bytes;
        await remove(c.path, idle);
        over -= result.bytes - was;
      }
      if (over > 0) i.log("disk budget: only open or in-use work is left; nothing more removed");
    }
  }
  if (result.files > 0) {
    i.log(
      `disk sweep: removed ${result.files} item(s), ${result.bytes} bytes, from the data folder`,
    );
  }
  return result;
}
