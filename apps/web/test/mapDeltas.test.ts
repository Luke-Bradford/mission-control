import { type MapSeat, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { describe, expect, it } from "vitest";
import { applyDelta } from "../src/map/deltas.ts";
import { pickRepo } from "../src/map/repos.ts";
import { stateLabel } from "../src/map/Selector.tsx";

describe("map rules", () => {
  it("applies ordered changes, ignores duplicates and requests resync on gaps", () => {
    const s: MapSnapshot = structuredClone(mapSnapshotFixture);
    const d = {
      type: "diff" as const,
      seq: s.seq + 1,
      seat: s.seats[0].seat,
      file: "new.ts",
      add: 55,
      rem: 2,
    };
    const next = applyDelta(s, d, 100);
    expect(next?.seats[0].scope.modified.find((c) => c.file === "new.ts")?.source).toBe("diff");
    // only the seats are copied: the tree keeps its identity
    expect(next?.tree).toBe(s.tree);
    expect(applyDelta(s, { ...d, seq: s.seq }, 100)).toBe(s);
    expect(applyDelta(s, { ...d, seq: s.seq + 2 }, 100)).toBeNull();
    expect(s.seats[0].scope.modified.some((c) => c.file === "new.ts")).toBe(false);
  });

  it("picks the busiest repo, breaks ties by start, and retains a manual idle choice", () => {
    expect(
      pickRepo(
        ["a", "b"],
        [
          { repoId: "a", started: 1 },
          { repoId: "b", started: 2 },
        ],
        "a",
      ),
    ).toBe("b");
    expect(pickRepo(["a", "b"], [], "b")).toBe("b");
    expect(pickRepo(["a", "b"], [], "removed")).toBe("a");
  });

  it("names observed calls, thinking only during a running turn, and stalls", () => {
    const s: MapSeat = structuredClone(mapSnapshotFixture.seats[0]);
    expect(stateLabel(s, 44_000)).toBe("reading src/util.ts 42s");
    s.calls[0] = { tool: "Bash", detail: "pnpm -s vitest run", files: [], since: 2000 };
    expect(stateLabel(s, 44_000)).toBe("running pnpm -s vitest run 42s");
    s.calls = [];
    expect(stateLabel(s, 15_000)).toBe("thinking");
    s.state = "stalled";
    expect(stateLabel(s, 362_000)).toBe("stalled 6m 00s");
    s.state = "idle";
    expect(stateLabel(s, 182_000)).toBe("idle 3m 00s");
  });
});
