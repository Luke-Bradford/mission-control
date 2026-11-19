import { NEW_LOOP, type RunLoop } from "@mc/core";
import { describe, expect, it } from "vitest";
import { withLegacyHoldFields } from "../src/legacy-hold.ts";

describe("the old park and set-aside fields the web app still reads", () => {
  const off: RunLoop = {
    ...NEW_LOOP,
    phase: "parked",
    hold: { kind: "review", reason: "x", ended: false, worktree: "/w", wake: true, ask: 3 },
  };

  it("are filled on a run loop from its hold, at any depth", () => {
    const out = withLegacyHoldFields({ runs: [{ loop: off }, { loop: NEW_LOOP }] });
    expect(out.runs[0]?.loop).toMatchObject({
      hold: off.hold,
      parked: { kind: "review", reason: "x", ended: false },
      aside: { worktree: "/w", wake: true, ask: 3 },
    });
    expect(out.runs[1]?.loop).toMatchObject({ hold: null, parked: null, aside: null });
  });

  it("fill a crew loop's parked reason and a crew row's asideRuns", () => {
    const out = withLegacyHoldFields({
      loop: {
        phase: "parked",
        text: "Blocked: x",
        prNumber: null,
        hold: { kind: "ci", reason: "x", offSeat: false },
      },
      offSeatRuns: [{ runId: "a" }],
    });
    expect((out.loop as { parked?: string | null }).parked).toBe("x");
    expect(out.offSeatRuns).toEqual([{ runId: "a" }]);
    expect((out as unknown as { asideRuns: unknown }).asideRuns).toEqual([{ runId: "a" }]);
  });

  it("copy what they change and leave the stored loop alone", () => {
    const payload = { loop: off };
    const out = withLegacyHoldFields(payload);
    expect(out).not.toBe(payload);
    expect("parked" in off).toBe(false);
    expect(withLegacyHoldFields({ n: 1 })).toEqual({ n: 1 });
  });
});
