/**
 * The hub's housekeeping of its own data folder (#1756): pictures and evidence live only while the
 * work they belong to is open, and scratch copies go after a few days. Deletes only inside the data
 * folder and never follows a symlink: a link, or anything that resolves outside the folder, is left.
 */
import { lstatSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { join, sep } from "node:path";

/** A scratch folder untouched this long is removed. */
export const SCRATCH_MAX_AGE_MS = 3 * 86_400_000;
/** A finished PR's files stay this long, so a PR that has only just closed can still be read. */
export const FINISHED_GRACE_MS = 3_600_000;
/** How often the hub runs the sweep. */
export const DISK_SWEEP_EVERY_MS = 3_600_000;
/** The one folder under `controller/` that is kept. */
export const CONTROLLER_KEEP = "designs";

/** Folder names under the data folder; one place for the sweep, the sizes and the tests. */
export const DATA_DIRS = {
  evidence: "pr-evidence",
  evidenceWork: "pr-evidence-work",
  qaAssets: "qa-report-assets",
  reviewShots: "review-screenshots",
  hudShots: "hud-screenshots",
  designPreviews: "design-previews",
  controller: "controller",
} as const;

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
  log: (line: string) => void;
}

export interface SweepResult {
  /** Items removed (a folder counts once). */
  files: number;
  bytes: number;
}

/** Bytes under `path` and the newest file modification time in it (a folder's own time only when empty); a symlink counts as itself only. */
export function measure(path: string): { bytes: number; newest: number } {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return { bytes: 0, newest: 0 };
  }
  if (!st.isDirectory()) return { bytes: st.isSymbolicLink() ? 0 : st.size, newest: st.mtimeMs };
  let bytes = 0;
  let newest = 0;
  const names = safeList(path);
  if (names.length === 0) newest = st.mtimeMs;
  for (const name of names) {
    const m = measure(join(path, name));
    bytes += m.bytes;
    newest = Math.max(newest, m.newest);
  }
  return { bytes, newest };
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
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
  if (result.files > 0) {
    i.log(
      `disk sweep: removed ${result.files} item(s), ${result.bytes} bytes, from the data folder`,
    );
  }
  return result;
}
