import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow, useSecond } from "../src/clock.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("shared clocks", () => {
  it("useSecond ticks every second and useNow every 5 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const seen = { second: 0, now: 0 };
    function Probe() {
      seen.second = useSecond();
      seen.now = useNow();
      return null;
    }
    const { unmount } = render(<Probe />);
    expect(seen).toEqual({ second: 1_000_000, now: 1_000_000 });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(seen).toEqual({ second: 1_001_000, now: 1_000_000 });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(seen).toEqual({ second: 1_005_000, now: 1_005_000 });
    unmount();
    expect(vi.getTimerCount()).toBe(0); // the last reader gone, both timers stop
  });
});
