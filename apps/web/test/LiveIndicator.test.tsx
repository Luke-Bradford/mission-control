import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { startStream } from "../src/data.ts";
import { LiveIndicator } from "../src/shell/LiveIndicator.tsx";

class Stream extends EventTarget {
  static OPEN = 1;
  static CLOSED = 2;
  static current: Stream;
  readyState = 0;
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
function start() {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal("EventSource", Stream);
  stop = startStream();
  render(<LiveIndicator />);
}
function open() {
  Stream.current.readyState = Stream.OPEN;
  Stream.current.dispatchEvent(new Event("open"));
}
it("connects in amber, stays green through a quiet minute, and reconnects in red after an error", () => {
  start();
  expect(screen.getByText("LIVE · connecting").className).toContain("connecting");
  act(open);
  expect(screen.getByText("LIVE · —").className).toContain("fresh");
  act(() => Stream.current.dispatchEvent(new MessageEvent("message")));
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText("LIVE · 60s").className).toContain("fresh");
  act(() => Stream.current.dispatchEvent(new Event("error")));
  expect(screen.getByText("LIVE · 60s").className).toContain("fresh");
  act(() => {
    Stream.current.readyState = 0;
    Stream.current.dispatchEvent(new Event("error"));
  });
  expect(screen.getByText("LIVE · reconnecting").className).toContain("down");
  act(open);
  expect(screen.getByText("LIVE · 60s").className).toContain("fresh");
});
it("allows ten seconds for the first open, including early errors, then turns red", () => {
  start();
  act(() => Stream.current.dispatchEvent(new Event("error")));
  act(() => vi.advanceTimersByTime(9999));
  expect(screen.getByText("LIVE · connecting").className).toContain("connecting");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("LIVE · reconnecting").className).toContain("down");
  act(open);
  expect(screen.getByText("LIVE · —").className).toContain("fresh");
});
