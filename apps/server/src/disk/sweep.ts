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
/** Setting: set once the hub has run the one-off clean of what finished PRs left behind. */
export const DISK_CLEAN_SETTING = "disk-leftovers-cleaned";
/** How often the hub runs the sweep. */
export const DISK_SWEEP_EVERY_MS = 3_600_000;
/** The most each picture store may hold; over it, the oldest pictures go first, cited or not. */
export const IMAGE_CAPS: Readonly<Record<string, number>> = {
  [DATA_DIRS.evidence]: 384 * 1024 ** 2,
  [DATA_DIRS.qaAssets]: 256 * 1024 ** 2,
  [DATA_DIRS.reviewShots]: 128 * 1024 ** 2,
  [DATA_DIRS.hudShots]: 128 * 1024 ** 2,
  [DATA_DIRS.attentionMaterials]: 128 * 1024 ** 2,
};
/** The one folder under `controller/` that is kept. */
export const CONTROLLER_KEEP = "designs";

const PR_DIR = /^[1-9][0-9]*$/;

export interface SweepInput {
  dataDir: string;
  now: () => number;
  /** PRs as `repoId#number` whose work is not finished: open, or merged but not live yet. Every other PR's files go. */
  openPrs: ReadonlySet<string>;
  /** QA image ids (sha256 hex) cited by a report of an open PR. */
  citedAssets: ReadonlySet<string>;
  /** Review screenshot ids that belong to a review of an open PR. */
  keptShots: ReadonlySet<string>;
  /** Needs-you picture ids (file names) cited by a packet of a question still waiting. */
  keptMaterials: ReadonlySet<string>;
  /** The most the hub may hold. Over it, idle scratch goes oldest first; open work is never removed. Absent: no cap. */
  budgetBytes?: number;
  /** What the hub holds by kind, for the budget check and its log line (worktrees are the tidy's). */
  holdings?: () => Promise<DiskUse>;
  /** Size caps by folder name; default `IMAGE_CAPS`. */
  caps?: Readonly<Record<string, number>>;
  /** How long a finished PR's files stay; default `FINISHED_GRACE_MS`. 0 for the one-off clean. */
  graceMs?: number;
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
  const finished = (newest: number): boolean => now - newest > (i.graceMs ?? FINISHED_GRACE_MS);
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
  // a PR's kept snapshot (`kept-<pr>`) is work files: gone with the PR's pictures
  const heldNumbers = new Set([...i.openPrs].map((k) => k.slice(k.lastIndexOf("#") + 1)));
  for (const name of await safeList(join(root, DATA_DIRS.evidenceWork))) {
    const m = /^kept-([1-9][0-9]*)$/.exec(name);
    if (m && !heldNumbers.has(m[1]))
      await remove(join(root, DATA_DIRS.evidenceWork, name), finished);
  }
  // a picture file keyed by an id: gone unless an open PR's work still cites it
  const pictures = async (dir: string, keep: ReadonlySet<string>, ext = ".png"): Promise<void> => {
    for (const name of await safeList(join(root, dir))) {
      if (!name.endsWith(ext) || keep.has(name.slice(0, name.length - ext.length))) continue;
      await remove(join(root, dir, name), finished);
    }
  };
  await pictures(DATA_DIRS.qaAssets, i.citedAssets);
  await pictures(DATA_DIRS.reviewShots, i.keptShots);
  // Needs-you pictures have no extension: the whole name is the id
  await pictures(DATA_DIRS.attentionMaterials, i.keptMaterials, "");
  // scratch: every child of these folders, once untouched for 3 days
  for (const dir of scratchDirs) {
    for (const name of await scratchOf(dir)) await remove(join(root, dir, name), stale);
  }

  // caps: a store over its cap loses its oldest pictures first, open work or not
  for (const [dir, cap] of Object.entries(i.caps ?? IMAGE_CAPS)) {
    const units: { path: string; bytes: number; newest: number }[] = [];
    const add = async (path: string): Promise<void> => {
      if ((await lstat(path).catch(() => null))?.isSymbolicLink()) return;
      units.push({ path, ...(await measure(path)) });
    };
    if (dir === DATA_DIRS.evidence) {
      // <repo>/<pr>/<head sha>: one head is the unit
      for (const repo of await safeList(join(root, dir)))
        for (const pr of await safeList(join(root, dir, repo)))
          for (const head of await safeList(join(root, dir, repo, pr)))
            await add(join(root, dir, repo, pr, head));
    } else {
      for (const name of await safeList(join(root, dir))) await add(join(root, dir, name));
    }
    let total = units.reduce((n, u) => n + u.bytes, 0);
    units.sort((a, b) => a.newest - b.newest);
    for (const u of units) {
      if (total <= cap) break;
      const was = result.bytes;
      await remove(u.path, () => true);
      total -= result.bytes - was;
    }
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
