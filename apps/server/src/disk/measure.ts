/** Sizes under the hub's data folder, shared by the sweep and the disk report (#1756). */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

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

export function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
