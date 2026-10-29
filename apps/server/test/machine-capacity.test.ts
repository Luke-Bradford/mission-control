import type { MachineSample } from "@mc/core";
import { describe, expect, it } from "vitest";
import { MACHINE_CAPACITY_DEFAULTS, machineCapacity } from "../src/machine-capacity.ts";

const NOW = 1_000_000;
const sample = (over: Partial<MachineSample> = {}): MachineSample => ({
  at: NOW,
  cpuPct: 0,
  cores: 10,
  memUsedBytes: 1,
  memTotalBytes: 2,
  diskFreeBytes: 20 * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  swapUsedBytes: 1,
  swapTotalBytes: 100,
  memoryPressureFreePct: 20,
  load1: 1,
  agents: null,
  ...over,
});

describe("machineCapacity", () => {
  it.each([
    ["absolute disk", { diskFreeBytes: 14 * 1024 ** 3 }, "disk free"],
    [
      "percentage disk",
      { diskFreeBytes: 20 * 1024 ** 3, diskTotalBytes: 500 * 1024 ** 3 },
      "disk free",
    ],
    ["swap", { swapUsedBytes: 86 }, "swap"],
    ["memory", { memoryPressureFreePct: 9 }, "memory free"],
  ])("blocks on %s", (_name, over, reason) => {
    expect(machineCapacity([sample(over)], NOW)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining(reason),
    });
  });

  it("blocks sustained load, then clears only after five minutes of headroom", () => {
    const high = Array.from({ length: 6 }, (_, i) =>
      sample({ at: NOW - (5 - i) * 60_000, load1: 16 }),
    );
    expect(machineCapacity(high, NOW)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("load"),
    });
    expect(
      machineCapacity([...high, sample({ at: NOW + 4 * 60_000 })], NOW + 4 * 60_000),
    ).toMatchObject({ blocked: true });
    expect(
      machineCapacity([...high, sample({ at: NOW + 5 * 60_000 })], NOW + 5 * 60_000),
    ).toMatchObject({ blocked: true });
    expect(
      machineCapacity([...high, sample({ at: NOW + 5 * 60_000 + 1 })], NOW + 5 * 60_000 + 1),
    ).toEqual({ blocked: false, reason: null });
  });

  it("keeps a direct threshold held for five minutes of headroom", () => {
    const tight = sample({ diskFreeBytes: 14 * 1024 ** 3 });
    expect(
      machineCapacity([tight, sample({ at: NOW + 4 * 60_000 })], NOW + 4 * 60_000),
    ).toMatchObject({ blocked: true });
    expect(
      machineCapacity([tight, sample({ at: NOW + 5 * 60_000 + 1 })], NOW + 5 * 60_000 + 1),
    ).toEqual({ blocked: false, reason: null });
  });

  it("does not block while there are no samples", () => {
    expect(machineCapacity([], NOW, MACHINE_CAPACITY_DEFAULTS)).toEqual({
      blocked: false,
      reason: null,
    });
  });
});
