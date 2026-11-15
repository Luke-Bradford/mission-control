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
      .flatMap((line) => line.split(/(?<=\.)\s+/))
      .filter((sentence) => /controller/i.test(sentence));
    expect(sentences.some((s) => /There is no controller/.test(s))).toBe(true);
    expect(sentences.filter((s) => WAITS_ON_CONTROLLER.test(s))).toEqual([]);
  });

  it("starts from the purpose and says how to unblock and pass things on", () => {
    expect(role).toContain("## What this is for");
    expect(role).toContain("## What the operator sees");
    expect(role).toContain("## How to unblock");
    expect(role).toContain("## How to pass things on");
    expect(role).toContain("clear a PR yourself with `mc merge_pr`");
    expect(role).toContain("Never leave a block silent");
    // the operator's own protections are never routed around
    expect(role).toContain("you never route around them");
  });
});
