import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strayFiles } from "../scripts/check-stray-files.ts";

const ROOT = join(import.meta.dirname, "../../..");

describe("repo hygiene (PR 1752 sed backups; the 11 November proof-file policy)", () => {
  it("flags the sed backups a run/ move committed (PR 1752)", () => {
    const found = strayFiles([
      "apps/server/test/api.test.ts-E",
      "apps/server/test/flight-tools.test.ts-E",
      "apps/server/test/api.test.ts",
    ]);
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("api.test.ts-E");
  });

  it("flags proof screenshots and artifact files under docs (the 11 November policy, PR 1761)", () => {
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
