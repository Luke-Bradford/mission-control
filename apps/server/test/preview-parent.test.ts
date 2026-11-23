import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPreviewParent } from "../src/runtime/preview-parent.ts";

describe("watchPreviewParent", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exits when the parent is gone, and stops checking once its timer is cleared", () => {
    const exit = vi.fn();
    const alive = vi.fn();
    const timer = watchPreviewParent(4242, exit, alive);
    expect(timer).toBeDefined();
    vi.advanceTimersByTime(15_000);
    expect(alive).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    clearInterval(timer);
    vi.advanceTimersByTime(60_000);
    expect(alive).toHaveBeenCalledTimes(1); // cleared on shutdown: no further check
  });

  it("exits with 0 when the parent no longer answers", () => {
    const exit = vi.fn();
    const timer = watchPreviewParent(4242, exit, () => {
      throw new Error("ESRCH");
    });
    vi.advanceTimersByTime(15_000);
    expect(exit).toHaveBeenCalledWith(0);
    clearInterval(timer);
  });

  it("watches nothing for a pid that is not a real parent", () => {
    expect(watchPreviewParent(1)).toBeUndefined();
    expect(watchPreviewParent(Number.NaN)).toBeUndefined();
  });
});
