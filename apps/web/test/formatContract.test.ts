import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/** Lines that build a visible percent by hand; CSS geometry (widths, offsets) is allowed. */
const GEOMETRY =
  /width|left|right|top|bottom|height|translate|--|style=|offset|inset|const pct = |const place = /;
const COMMENT = /^\s*(\*|\/\/|\/\*)/;
const HAND_PERCENT = /(Math\.round\([^)]*\)|toFixed\(\d\))\s*\}?%|\}%`|\}%<|\}%\s*\//;

describe("one formatter per thing", () => {
  it("builds no visible percent outside fmt.ts", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      if (file.endsWith("/fmt.ts")) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (HAND_PERCENT.test(line) && !GEOMETRY.test(line) && !COMMENT.test(line))
            found.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });
});
