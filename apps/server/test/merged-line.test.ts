import { describe, expect, it } from "vitest";
import { recordExternalMerge } from "../src/flight/merged-line.ts";

type Recorded = { ref: string | null; decision: string; about: string; seatId: string | null };
const recorder = () => {
  const seen: Recorded[] = [];
  return { seen, record: (d: Recorded) => (seen.push(d), 77) };
};
const m = { pr: 15, repoId: "mc", text: "Merged.", basis: "Read it", seatId: null };

describe("recordExternalMerge", () => {
  it("gives the decision its linked ticket's ref", () => {
    const r = recorder();
    expect(recordExternalMerge({ record: r.record as never }, { ...m, ticket: 9 })).toBe(77);
    expect(r.seen[0]).toMatchObject({ ref: "mc#9", about: "External PR #15" });
  });

  it("names the protected paths FLIGHT's call covered, and leaves a plain merge alone", () => {
    const r = recorder();
    recordExternalMerge(
      { record: r.record as never },
      { ...m, paths: [".github/workflows/ci.yml"] },
    );
    recordExternalMerge({ record: r.record as never }, { ...m, paths: [] });
    expect(r.seen[0]?.decision).toBe(
      "Merged. FLIGHT's call covered it: touches .github/workflows/ci.yml.",
    );
    expect(r.seen[0]?.ref).toBeNull();
    expect(r.seen[1]?.decision).toBe("Merged.");
  });
});
