import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineSample } from "@mc/core";
import { describe, expect, it } from "vitest";
import { MACHINE_CAPACITY_DEFAULTS, storedMachineCapacity } from "../src/machine-capacity.ts";
import { Store } from "../src/store.ts";

const START = 1_800_000;
const config = { ...MACHINE_CAPACITY_DEFAULTS, diskFreeGb: 1 };
const sample = (minute: number, percent: number | null): MachineSample => ({
  at: START + minute * 60_000,
  cpuPct: 0,
  cores: 10,
  memUsedBytes: 1,
  memTotalBytes: 24 * 1024 ** 3,
  diskFreeBytes: percent === null ? null : percent * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  swapUsedBytes: 1,
  swapTotalBytes: 100,
  memoryPressureFreePct: 40,
  load1: 1,
  agents: null,
});

describe("persisted percentage-disk episodes", () => {
  it("survives a restart and a breach leaving bounded history, then clears after ten minutes above 6%", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-disk-episode-"));
    const path = join(dir, "mc.sqlite");
    let store = new Store(path);
    const read = (minute: number, percent: number) => {
      const value = sample(minute, percent);
      store.addMachineSample(value);
      return storedMachineCapacity(store, value.at, config);
    };
    try {
      expect(read(0, 4.5).blocked).toBe(true);
      for (let minute = 1; minute <= 14; minute++) {
        if (minute === 8) {
          store.close();
          store = new Store(path);
        }
        expect(read(minute, 5.3).blocked).toBe(true);
      }
      for (let minute = 15; minute < 25; minute++) expect(read(minute, 6.1).blocked).toBe(true);
      expect(read(25, 6.1)).toEqual({ blocked: false, reason: null });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not prove recovery with unknown disk readings", () => {
    const store = new Store(":memory:");
    try {
      for (let minute = 0; minute <= 14; minute++) {
        const value = sample(minute, minute === 0 ? 4.5 : minute === 10 ? null : 6.1);
        store.addMachineSample(value);
        expect(storedMachineCapacity(store, value.at, config).blocked).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("restarts the ten-minute recovery after a gap in collection", () => {
    const store = new Store(":memory:");
    try {
      store.addMachineSample(sample(0, 4.5));
      expect(storedMachineCapacity(store, sample(0, 4.5).at, config).blocked).toBe(true);
      store.addMachineSample(sample(1, 6.1));
      expect(storedMachineCapacity(store, sample(1, 6.1).at, config).blocked).toBe(true);
      // Collection stops for fifteen minutes, then resumes above the clear line.
      for (let minute = 16; minute < 26; minute++) {
        const value = sample(minute, 6.1);
        store.addMachineSample(value);
        expect(storedMachineCapacity(store, value.at, config).blocked).toBe(true);
      }
      const last = sample(26, 6.1);
      store.addMachineSample(last);
      expect(storedMachineCapacity(store, last.at, config)).toEqual({
        blocked: false,
        reason: null,
      });
    } finally {
      store.close();
    }
  });
});
