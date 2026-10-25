import { describe, expect, it } from "vitest";
import { stuckSessionReason } from "../src/runtime/supervisor.ts";

const MIN = 60_000;
const idle = { attaching: false, attachedAt: 0, inTurn: false, lastOutputAt: 0 };

describe("stuck sessions", () => {
  it("bounds a replay even if it continues producing output", () => {
    expect(stuckSessionReason({ ...idle, attaching: true, lastOutputAt: MIN }, MIN - 1)).toBeNull();
    expect(stuckSessionReason({ ...idle, attaching: true, lastOutputAt: MIN }, MIN)).toContain(
      "replay",
    );
  });

  it("bounds a silent turn but lets output extend it", () => {
    expect(stuckSessionReason({ ...idle, inTurn: true }, 30 * MIN - 1)).toBeNull();
    expect(stuckSessionReason({ ...idle, inTurn: true }, 30 * MIN)).toContain("no output");
    expect(stuckSessionReason({ ...idle, inTurn: true, lastOutputAt: MIN }, 30 * MIN)).toBeNull();
  });

  it("never expires an idle seat", () => {
    expect(stuckSessionReason(idle, 24 * 60 * MIN)).toBeNull();
  });
});
