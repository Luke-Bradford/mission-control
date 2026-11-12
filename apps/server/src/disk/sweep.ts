/**
 * The hub's housekeeping of its own data folder (#1756): pictures and evidence live only while the
 * work they belong to is open, and scratch copies go after a few days. Deletes only inside the data
 * folder and never follows a symlink: a link, or anything that resolves outside the folder, is left.
 */
import { lstatSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join, sep } from "node:path";
import { DATA_DIRS, measure, safeList } from "./measure.ts";
import { diskUse } from "./use.ts";

/** A scratch folder untouched this long is removed. */
export const SCRATCH_MAX_AGE_MS = 3 * 86_400_000;
/** A finished PR's files stay this long, so a PR that has only just closed can still be read. */
export const FINISHED_GRACE_MS = 3_600_000;
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
  /** The most the hub may hold; above it the oldest files go first. Absent: no cap. */
  budgetBytes?: number;
  /** The crew's worktree folder: counted in the log's list of what the hub holds, never swept here. */
  worktrees?: string;
  log: (line: string) => void;
}

export interface SweepResult {
  /** Items removed (a folder counts once). */
  files: number;
  bytes: number;
}

export function sweepDataFolder(i: SweepInput): SweepResult {
  let root: string;
  try {
    root = realpathSync(i.dataDir);
  } catch {
    return { files: 0, bytes: 0 };
  }
  const now = i.now();
  const result: SweepResult = { files: 0, bytes: 0 };

  /** Removes `path` when it is a real entry inside the data folder and `due` says so. */
  const remove = (path: string, due: (newest: number) => boolean): void => {
    let st: Stats;
    try {
      st = lstatSync(path);
      if (st.isSymbolicLink()) return;
      const real = realpathSync(path);
      if (!real.startsWith(root + sep)) return;
    } catch {
      return;
    }
    const m = measure(path);
    if (!due(m.newest)) return;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      return;
    }
    result.files += 1;
    result.bytes += m.bytes;
  };
  const finished = (newest: number): boolean => now - newest > FINISHED_GRACE_MS;
  const stale = (newest: number): boolean => now - newest > SCRATCH_MAX_AGE_MS;

  // evidence: <repo>/<pr>/<head sha>/...
  const evidence = join(root, DATA_DIRS.evidence);
  for (const repo of safeList(evidence)) {
    for (const pr of safeList(join(evidence, repo))) {
      if (!PR_DIR.test(pr) || i.openPrs.has(`${repo}#${pr}`)) continue;
      remove(join(evidence, repo, pr), finished);
    }
  }
  // a picture file keyed by an id: gone unless an open PR's work still cites it
  const pictures = (dir: string, keep: ReadonlySet<string>): void => {
    for (const name of safeList(join(root, dir))) {
      if (!name.endsWith(".png") || keep.has(name.slice(0, -4))) continue;
      remove(join(root, dir, name), finished);
    }
  };
  pictures(DATA_DIRS.qaAssets, i.citedAssets);
  pictures(DATA_DIRS.reviewShots, i.keptShots);
  // scratch: every child of these folders, once untouched for 3 days
  for (const dir of [DATA_DIRS.controller, DATA_DIRS.evidenceWork]) {
    for (const name of safeList(join(root, dir))) {
      if (dir === DATA_DIRS.controller && name === CONTROLLER_KEEP) continue;
      remove(join(root, dir, name), stale);
    }
  }
  if (i.budgetBytes !== undefined) enforceBudget(i, root, remove, result);
  if (result.files > 0) {
    i.log(
      `disk sweep: removed ${result.files} item(s), ${result.bytes} bytes, from the data folder`,
    );
  }
  return result;
}

/** Finished work is already gone; over the budget, scratch goes next, then the oldest pictures. */
function enforceBudget(
  i: SweepInput,
  root: string,
  remove: (path: string, due: (newest: number) => boolean) => void,
  result: SweepResult,
): void {
  const budget = i.budgetBytes ?? 0;
  const before = diskUse({ dataDir: root, worktrees: i.worktrees });
  // worktrees are the crew tidy's to remove; the cap holds the data folder
  let held = before.total - before.worktrees;
  if (held <= budget) return;
  const candidates = (dirs: string[], depth: 1 | 2) =>
    dirs.flatMap((dir) =>
      safeList(join(root, dir)).flatMap((name) => {
        if (dir === DATA_DIRS.controller && name === CONTROLLER_KEEP) return [];
        const top = join(root, dir, name);
        const paths = depth === 1 ? [top] : safeList(top).map((n) => join(top, n));
        return paths.map((path) => ({ path, ...measure(path) }));
      }),
    );
  const oldestFirst = <T extends { newest: number }>(list: T[]): T[] =>
    list.sort((a, b) => a.newest - b.newest);
  const order = [
    ...oldestFirst(candidates([DATA_DIRS.controller, DATA_DIRS.evidenceWork], 1)),
    ...oldestFirst([
      ...candidates([DATA_DIRS.evidence], 2),
      ...candidates([DATA_DIRS.qaAssets, DATA_DIRS.reviewShots], 1),
    ]),
  ];
  i.log(
    `disk budget: the hub is over its budget of ${budget} bytes; it holds worktrees ${before.worktrees}, pictures ${before.pictures}, evidence ${before.evidence}, scratch ${before.scratch}, database ${before.database}`,
  );
  for (const c of order) {
    if (held <= budget) break;
    const was = result.bytes;
    remove(c.path, () => true);
    held -= result.bytes - was;
  }
}
