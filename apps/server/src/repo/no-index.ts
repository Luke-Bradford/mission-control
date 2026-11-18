import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** macOS keeps Spotlight out of a folder that holds this file (#1812). */
export const NO_INDEX_MARKER = ".metadata_never_index";

/** The evidence folders beside the database that fill with crew screenshots and images. */
export const EVIDENCE_FOLDERS = [
  "qa-report-assets",
  "review-screenshots",
  "hud-screenshots",
  "pr-evidence",
  "pr-evidence-work",
  "design-previews",
] as const;

/** Puts the marker at the root of each folder, making the folder if it is missing. Never throws. */
export function keepOutOfSpotlight(dirs: readonly string[], log: (line: string) => void): void {
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, NO_INDEX_MARKER), "", { flag: "a" });
    } catch (e) {
      log(`no-index marker in ${dir} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
