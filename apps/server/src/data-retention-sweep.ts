import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { decodePng, encodePng } from "./pr-evidence/png.ts";

export const FINISHED_PR_RETENTION_MS = 7 * 86_400_000;
export const SCRATCH_RETENTION_MS = 3 * 86_400_000;

export interface RetainedPr {
  repoId: string;
  number: number;
  state: "open" | "closed" | "merged";
  finishedAt: number | null;
}

interface PrFile {
  id: string;
  repoId: string;
  prNumber: number;
}

export interface HubDataSweep {
  root: string;
  now?: number;
  prs: readonly RetainedPr[];
  qaAssets: readonly PrFile[];
  reviewShots: readonly PrFile[];
  openQuestionPaths?: readonly string[];
  log?: (line: string) => void;
}

export interface HubDataSweepResult {
  removed: number;
  bytes: number;
}

const QA_THUMBNAIL_EDGE = 320;

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    !path.startsWith("..") &&
    !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

/** Removes only resolved descendants of the hub data directory. */
export function sweepHubData(input: HubDataSweep): HubDataSweepResult {
  const now = input.now ?? Date.now();
  const root = realpathSync(input.root);
  let removed = 0;
  let bytes = 0;
  const deletePath = (candidate: string): void => {
    let resolved: string;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
      resolved = realpathSync(candidate);
    } catch {
      return;
    }
    if (!isWithin(root, resolved)) return;
    if (stat.isSymbolicLink()) return;
    const size = stat.isDirectory() ? directoryBytes(candidate) : stat.isFile() ? stat.size : 0;
    try {
      rmSync(candidate, { recursive: stat.isDirectory(), force: true });
      removed += 1;
      bytes += size;
    } catch {
      // A concurrent writer can remove or replace its own file. Leave it for a later sweep.
    }
  };
  const finished = new Set(
    input.prs
      .filter(
        (pr) =>
          pr.state !== "open" &&
          pr.finishedAt !== null &&
          now - pr.finishedAt >= FINISHED_PR_RETENTION_MS,
      )
      .map((pr) => `${pr.repoId}:${pr.number}`),
  );
  for (const key of finished) {
    const [repoId, number] = key.split(":");
    deletePath(join(root, "pr-evidence", repoId as string, number as string));
  }
  for (const asset of input.qaAssets)
    if (finished.has(`${asset.repoId}:${asset.prNumber}`))
      deleteQaAsset(root, asset.id, deletePath);
  for (const shot of input.reviewShots)
    if (finished.has(`${shot.repoId}:${shot.prNumber}`))
      deletePath(join(root, "review-screenshots", `${shot.id}.png`));

  const protectedPaths = new Set((input.openQuestionPaths ?? []).map((path) => safeRealpath(path)));
  for (const parent of ["controller", "previews"]) {
    const folder = join(root, parent);
    let entries: string[];
    try {
      entries = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (parent === "controller" && name === "designs") continue;
      const candidate = join(folder, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isDirectory() || now - stat.mtimeMs < SCRATCH_RETENTION_MS) continue;
      if (protectedPaths.has(safeRealpath(candidate))) continue;
      deletePath(candidate);
    }
  }
  const result = { removed, bytes };
  input.log?.(`data retention: removed ${removed} files (${bytes} bytes)`);
  return result;
}

/** Keeps a bounded history image before deleting the full archived report asset. */
function deleteQaAsset(root: string, id: string, remove: (path: string) => void): void {
  const source = join(root, "qa-report-assets", `${id}.png`);
  const thumbnail = join(root, "qa-report-assets", "thumbnails", `${id}.png`);
  try {
    const raster = decodePng(readFileSync(source));
    const scale = Math.min(1, QA_THUMBNAIL_EDGE / Math.max(raster.width, raster.height));
    const width = Math.max(1, Math.round(raster.width * scale));
    const height = Math.max(1, Math.round(raster.height * scale));
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const fromX = Math.min(raster.width - 1, Math.floor(x / scale));
        const fromY = Math.min(raster.height - 1, Math.floor(y / scale));
        data.set(
          raster.data.subarray(
            (fromY * raster.width + fromX) * 4,
            (fromY * raster.width + fromX + 1) * 4,
          ),
          (y * width + x) * 4,
        );
      }
    }
    mkdirSync(join(root, "qa-report-assets", "thumbnails"), { recursive: true, mode: 0o700 });
    writeFileSync(thumbnail, encodePng({ width, height, data }), { mode: 0o600 });
  } catch {
    return;
  }
  remove(source);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    total += stat.isDirectory() ? directoryBytes(child) : stat.isFile() ? stat.size : 0;
  }
  return total;
}
