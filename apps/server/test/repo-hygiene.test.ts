import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

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

describe("repo hygiene (review findings 1752, 1761)", () => {
  it("flags the sed backups a run/ move committed (PR 1752)", () => {
    const found = strayFiles([
      "apps/server/test/api.test.ts-E",
      "apps/server/test/flight-tools.test.ts-E",
      "apps/server/test/api.test.ts",
    ]);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("api.test.ts-E");
  });

  it("flags proof screenshots and artifact files under docs (PR 1761)", () => {
    const found = strayFiles([
      "docs/evidence/agent-density-1361/capture.ts",
      "docs/evidence/1378-standing-instructions/artifacts.json",
      "docs/reviews/2026-11-09/x/after-agent-1600x700-one-dark.png",
      "docs/evidence/notes.md",
      "docs/prototype/shot.png",
    ]);
    expect(found).toHaveLength(3);
  });

  it("finds none among the files tracked now", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
    expect(strayFiles(tracked)).toEqual([]);
  });
});
