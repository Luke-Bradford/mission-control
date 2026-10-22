import { expect, it } from "vitest";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.parse("2026-10-17T12:00:00Z");

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const time = (fn: () => unknown, runs = 15): number => {
  fn();
  return median(
    Array.from({ length: runs }, () => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    }),
  );
};

it("a 7d machine read over 10 080 minute samples is faster than reading and parsing them", () => {
  const store = new Store(":memory:");
  for (let t = NOW - 7 * DAY + MIN; t <= NOW; t += MIN) {
    store.addMachineSample({
      at: t,
      cpuPct: t % 100,
      cores: 8,
      memUsedBytes: 4,
      memTotalBytes: 8,
      diskFreeBytes: null,
      diskTotalBytes: null,
      agents: null,
    });
  }
  const since = NOW - 7 * DAY;
  const buckets = store.machineBuckets(since, NOW, (7 * DAY) / 72, 72);
  expect(buckets.length).toBeLessThanOrEqual(72);
  const bucketed = time(() => store.machineBuckets(since, NOW, (7 * DAY) / 72, 72));
  const raw = time(() => store.machineSamples(since));
  // Measured at about 2 ms against 6 ms; the bound only has to catch a per-row JSON parse.
  expect(bucketed).toBeLessThan(raw);
});
