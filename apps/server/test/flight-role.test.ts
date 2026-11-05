import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const role = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../roles/FLIGHT.md"),
  "utf8",
);

/** A sentence that waits on a controller's say-so: an approval, an independent check, a wait. */
const WAITS_ON_CONTROLLER =
  /\b(approval|approve|independent)\b|\b(waits?|waiting|needs?)\b[^.]*\bcontroller\b|\bcontroller\b[^.]*\b(waits?|waiting)\b/i;

describe("roles/FLIGHT.md", () => {
  it("no line of the role waits on a controller", () => {
    const sentences = role
      .split("\n")
      .filter((line) => /controller/i.test(line))
      .flatMap((line) => line.split(/(?<=\.)\s+/))
      .filter((sentence) => /controller/i.test(sentence));
    // the ticket's own check is the one mention that names the word, and it is FLIGHT's to do
    expect(sentences.some((s) => /## Controller check.*is yours/.test(s))).toBe(true);
    expect(sentences.filter((s) => WAITS_ON_CONTROLLER.test(s))).toEqual([]);
  });

  it("clears every PR itself and keeps only the operator's holds", () => {
    expect(role).toContain("Clear every other PR yourself with `mc merge_pr`");
    expect(role).toContain("`CLAUDE.md` and `.github/**` included");
    expect(role).toContain("Keep a hold the operator set in force");
    expect(role).toContain("- change branch protection or rulesets on GitHub;");
    expect(role).not.toMatch(/loosen a gate/i);
  });
});
