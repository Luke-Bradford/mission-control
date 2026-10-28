import { expect, it } from "vitest";
import {
  MACHINE_CHART_HEIGHT,
  MACHINE_CHART_TOP,
  machineAreaGeometry,
  timelineGeometry,
} from "../src/overview/chartGeometry.ts";

it("uses one fixed chart box and baseline for every machine area", () => {
  const cpu = machineAreaGeometry([0, 50, 100], 100);
  const disk = machineAreaGeometry([10, null, 20], 20);

  expect(MACHINE_CHART_HEIGHT).toBeGreaterThan(0);
  expect(cpu.height).toBe(MACHINE_CHART_HEIGHT);
  expect(disk.height).toBe(MACHINE_CHART_HEIGHT);
  expect(cpu.baseline).toBe(disk.baseline);
  expect(cpu.areas[0]).toContain(`L0.0,${cpu.baseline}Z`);
  expect(disk.areas).toEqual([]);
  // The scale's top is exported once: a value at the max is drawn on it.
  expect(cpu.top).toBe(MACHINE_CHART_TOP);
  expect(cpu.line).toContain(`100.0,${MACHINE_CHART_TOP.toFixed(1)}`);
  expect(MACHINE_CHART_TOP).toBeGreaterThan(0);
  expect(MACHINE_CHART_TOP).toBeLessThan(cpu.baseline);
});

it("uses one timeline scale and only square-ended, non-zero-width blocks", () => {
  const timeline = timelineGeometry({ from: 0, to: 60_000 });

  expect(timeline.baseline).toBe(0);
  expect(timeline.position(15_000)).toBe(25);
  expect(timeline.segment(30_000, 30_000)).toBeNull();
  expect(timeline.segment(10_000, 10_001)?.width).toBeGreaterThan(0);
  expect(timeline.segment(10_000, 20_000)?.borderRadius).toBe(0);
  expect(timeline.tick(30_000)).toMatchObject({ left: 50, width: 1, borderRadius: 0 });

  const hour = timelineGeometry({ from: 0, to: 3_600_000 });
  expect(hour.segment(0, 1)?.width).toBeGreaterThan(0);
});
