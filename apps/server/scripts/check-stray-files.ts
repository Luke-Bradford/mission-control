// Fails when a tracked file is an editor or sed backup, or a screenshot or proof run under docs.
// Run from the repo root: node --experimental-strip-types apps/server/scripts/check-stray-files.ts
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Editor and `sed -i` leftovers: `api.test.ts-E` is what macOS `sed -i -E` leaves behind. */
const BACKUP_SUFFIX = /(?:-E|\.orig|\.bak|\.rej|~)$/;
/** Screenshots and proof runs: the hub keeps them while a change waits, the repo does not (.gitignore). */
const PROOF_FILE = /^docs\/(?:evidence|reviews)\/.+\.(?:png|jpe?g|webp|gif|json|ts)$/i;
const DOCS_IMAGE = /^docs\/.+\.(?:png|jpe?g|webp|gif)$/i;
const IMAGE_HOMES = /^docs\/(?:prototype|mockups|design)\//;

/** Each tracked path that should not be committed, with why, so the failure names the fix. */
export function strayFiles(paths: string[]): string[] {
  const found: string[] = [];
  for (const p of paths) {
    if (BACKUP_SUFFIX.test(p))
      found.push(`${p}: backup file left by an editor or sed -i; delete it`);
    else if (PROOF_FILE.test(p) || (DOCS_IMAGE.test(p) && !IMAGE_HOMES.test(p)))
      found.push(
        `${p}: screenshot or proof run; the hub keeps these, the repo does not (.gitignore)`,
      );
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const found = strayFiles(tracked);
  for (const line of found) console.error(line);
  if (found.length > 0) process.exit(1);
  console.log(`Stray files: none among ${tracked.length} tracked files.`);
}
