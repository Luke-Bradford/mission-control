/** Sizes under the hub's data folder, shared by the sweep and the disk report (#1756). */
import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Folder names under the data folder; one place for the sweep, the sizes and the tests. */
export const DATA_DIRS = {
  evidence: "pr-evidence",
  evidenceWork: "pr-evidence-work",
  qaAssets: "qa-report-assets",
  reviewShots: "review-screenshots",
  hudShots: "hud-screenshots",
  attentionMaterials: "attention-material-assets",
  designPreviews: "design-previews",
  controller: "controller",
} as const;

/** Directory entries read at once while walking: enough to keep the disk busy, few enough to yield. */
const WALK_CONCURRENCY = 8;

/**
 * Bytes under `path` and the newest file modification time in it (a folder's own time only when
 * empty); a symlink counts as itself only. Async, so a walk of many gigabytes never stops the hub.
 */
export async function measure(path: string): Promise<{ bytes: number; newest: number }> {
  let st: Stats;
  try {
    st = await lstat(path);
  } catch {
    return { bytes: 0, newest: 0 };
  }
  if (!st.isDirectory()) return { bytes: st.isSymbolicLink() ? 0 : st.size, newest: st.mtimeMs };
  const names = await safeList(path);
  let bytes = 0;
  let newest = names.length === 0 ? st.mtimeMs : 0;
  for (let i = 0; i < names.length; i += WALK_CONCURRENCY) {
    const parts = await Promise.all(
      names.slice(i, i + WALK_CONCURRENCY).map((n) => measure(join(path, n))),
    );
    for (const m of parts) {
      bytes += m.bytes;
      newest = Math.max(newest, m.newest);
    }
  }
  return { bytes, newest };
}

export async function safeList(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
