import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { startStream } from "../src/data.ts";
import { LiveIndicator } from "../src/shell/LiveIndicator.tsx";

class Stream extends EventTarget {
  static CLOSED = 2;
  static current: Stream;
  readyState = 1;
  constructor() {
    super();
    Stream.current = this;
  }
  close() {}
}
let stop: (() => void) | undefined;
afterEach(() => {
  cleanup();
  stop?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("tracks message age, stale threshold, disconnect and recovery with a fake clock", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal("EventSource", Stream);
  stop = startStream();
  render(<LiveIndicator />);
  expect(screen.getByText("LIVE · reconnecting").className).toContain("down");
  act(() => Stream.current.dispatchEvent(new Event("open")));
  expect(screen.getByText("LIVE · —")).toBeTruthy();
  act(() =>
    Stream.current.dispatchEvent(new MessageEvent("changed", { data: '{"topic":"agents"}' })),
  );
  expect(screen.getByText("LIVE · 0s").className).toContain("fresh");
  act(() => vi.advanceTimersByTime(15000));
  expect(screen.getByText("LIVE · 15s").className).toContain("fresh");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("LIVE · 16s").className).toContain("stale");
  act(() => Stream.current.dispatchEvent(new MessageEvent("message")));
  expect(screen.getByText("LIVE · 0s").className).toContain("fresh");
  act(() => Stream.current.dispatchEvent(new Event("error")));
  expect(screen.getByText("LIVE · reconnecting").className).toContain("down");
  act(() => Stream.current.dispatchEvent(new Event("open")));
  expect(screen.getByText("LIVE · 0s").className).toContain("fresh");
});
