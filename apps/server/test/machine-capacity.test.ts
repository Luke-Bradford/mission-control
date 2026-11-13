import type { MachineSample } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  fileServiceFault,
  MACHINE_CAPACITY_DEFAULTS,
  machineCapacity,
} from "../src/machine-capacity.ts";

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
    ["memory", { memoryPressureFreePct: 9 }, "memory free"],
  ])("blocks on %s", (_name, over, reason) => {
    expect(machineCapacity([sample(over)], NOW)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining(reason),
    });
  });

  it("uses physical RAM and memory pressure, not the shrinking macOS swap file", () => {
    const gb = 1024 ** 3;
    const recovered = sample({
      memTotalBytes: 24 * gb,
      swapUsedBytes: 5.2 * gb,
      swapTotalBytes: 7.2 * gb,
      memoryPressureFreePct: 46,
    });
    expect(machineCapacity([recovered], NOW)).toEqual({ blocked: false, reason: null });

    const softSwapWithHealthyPressure = sample({
      memTotalBytes: 24 * gb,
      swapUsedBytes: 16 * gb,
      swapTotalBytes: 40 * gb,
      memoryPressureFreePct: 50,
    });
    expect(machineCapacity([softSwapWithHealthyPressure], NOW)).toEqual({
      blocked: false,
      reason: null,
    });

    const softSwapWithLowPressure = sample({
      memTotalBytes: 24 * gb,
      swapUsedBytes: 16 * gb,
      swapTotalBytes: 40 * gb,
      memoryPressureFreePct: 9,
    });
    expect(machineCapacity([softSwapWithLowPressure], NOW)).toMatchObject({
      blocked: true,
      reason: "swap used is 16.0 GB of 24.0 GB RAM (above 60%) and memory free is 9.0% (below 10%)",
    });

    const criticallySwapped = sample({
      memTotalBytes: 18.4 * gb,
      swapUsedBytes: 17.5 * gb,
      swapTotalBytes: 18.4 * gb,
      memoryPressureFreePct: 50,
    });
    expect(machineCapacity([criticallySwapped], NOW)).toMatchObject({
      blocked: true,
      reason: "swap used is 17.5 GB of 18.4 GB RAM (above 90%)",
    });

    expect(
      machineCapacity(
        [
          sample({
            memTotalBytes: 24 * gb,
            swapUsedBytes: 22 * gb,
            swapTotalBytes: 40 * gb,
            memoryPressureFreePct: 50,
          }),
        ],
        NOW,
        { ...MACHINE_CAPACITY_DEFAULTS, swapUsedPct: 97 },
      ),
    ).toMatchObject({
      blocked: true,
      reason: "swap used is 22.0 GB of 24.0 GB RAM (above 90%)",
    });
  });

  it("blocks when the swap file is over 85% full, though RAM and memory pressure look fine", () => {
    const gb = 1024 ** 3;
    const full = sample({
      memTotalBytes: 24 * gb,
      swapUsedBytes: 19 * gb,
      swapTotalBytes: 20 * gb,
      memoryPressureFreePct: 44,
    });
    expect(machineCapacity([full], NOW)).toEqual({
      blocked: true,
      reason: "the swap file is 19.0 GB full of 20.0 GB (above 85%)",
    });
    expect(fileServiceFault(full)).toContain("swap file");
    const roomy = { ...full, swapUsedBytes: 16 * gb };
    expect(machineCapacity([roomy], NOW)).toEqual({ blocked: false, reason: null });
    expect(fileServiceFault(roomy)).toBeNull();
  });

  it("blocks when fseventsd holds over 2 GB, and names it in plain words", () => {
    const gb = 1024 ** 3;
    const top = (rssBytes: number) => [
      { pid: 1, command: "Docker", rssBytes: 9 * gb, cpuPct: 1 },
      { pid: 2, command: "fseventsd", rssBytes, cpuPct: 1 },
    ];
    expect(machineCapacity([sample({ topConsumers: top(28 * gb) })], NOW)).toEqual({
      blocked: true,
      reason: "the file-change service (fseventsd) holds 28.0 GB of memory (above 2.0 GB)",
    });
    expect(machineCapacity([sample({ topConsumers: top(1.5 * gb) })], NOW)).toEqual({
      blocked: false,
      reason: null,
    });
  });

  it("clears the file-change block after the usual headroom once the reading recovers", () => {
    const gb = 1024 ** 3;
    const bad = sample({
      topConsumers: [{ pid: 2, command: "fseventsd", rssBytes: 3 * gb, cpuPct: 0 }],
    });
    const ok = (at: number) => sample({ at, topConsumers: [] });
    expect(machineCapacity([bad, ok(NOW + 4 * 60_000)], NOW + 4 * 60_000)).toMatchObject({
      blocked: true,
    });
    expect(machineCapacity([bad, ok(NOW + 5 * 60_000 + 1)], NOW + 5 * 60_000 + 1)).toEqual({
      blocked: false,
      reason: null,
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

  it("keeps a percentage-disk episode until ten minutes of headroom above the clear threshold", () => {
    const config = { ...MACHINE_CAPACITY_DEFAULTS, diskFreeGb: 1 };
    const nearThreshold = Array.from({ length: 11 }, (_, i) =>
      sample({
        at: NOW + (i + 1) * 60_000,
        diskFreeBytes: 5.3 * 1024 ** 3,
      }),
    );
    const breach = sample({ diskFreeBytes: 4.5 * 1024 ** 3 });
    expect(machineCapacity([breach, ...nearThreshold], NOW + 11 * 60_000, config)).toMatchObject({
      blocked: true,
      reason: expect.stringContaining("waiting 10 minutes above 6%"),
    });
    const recovered = Array.from({ length: 11 }, (_, i) =>
      sample({
        at: NOW + (i + 12) * 60_000,
        diskFreeBytes: 6.1 * 1024 ** 3,
      }),
    );
    expect(
      machineCapacity([breach, ...nearThreshold, ...recovered], NOW + 22 * 60_000, config),
    ).toEqual({ blocked: false, reason: null });
  });

  it("does not block while there are no samples", () => {
    expect(machineCapacity([], NOW, MACHINE_CAPACITY_DEFAULTS)).toEqual({
      blocked: false,
      reason: null,
    });
  });
});
