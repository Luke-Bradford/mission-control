import { TOPICS } from "@mc/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { RESOURCES, startStream } from "../src/data.ts";
// The pages are lazy in App; loaded here so fake timers never wait on a module import.
import "../src/pages/Agent.tsx";
import "../src/pages/Audit.tsx";
import "../src/pages/BoardPage.tsx";
import "../src/pages/Comms.tsx";
import "../src/pages/Flight.tsx";
import "../src/pages/Needs.tsx";
import "../src/pages/Overview.tsx";
import "../src/pages/Planner.tsx";
import "../src/pages/QaReadiness.tsx";
import "../src/pages/Setup.tsx";
import "../src/pages/Telemetry.tsx";
import { navigate, PAGE_PATHS } from "../src/router.ts";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, REPOS } from "./fixtures.ts";

/** The hub's stream, driven by the test: `emit` sends a `changed` event for a topic. */
class Stream {
  static OPEN = 1;
  static CLOSED = 2;
  static last: Stream | null = null;
  readyState = Stream.OPEN;
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  constructor() {
    Stream.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data?: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

/** The window in which a page may ask for each URL only once. */
const OPENING_MS = 6000;
/** A busy hub: every topic changes this often while the page opens. */
const EVENT_EVERY_MS = 500;

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** Advance `ms`, sending a `changed` event for every topic each EVENT_EVERY_MS. */
async function busyStream(ms: number) {
  for (let spent = 0; spent < ms; spent += EVENT_EVERY_MS) {
    for (const topic of TOPICS) Stream.last?.emit("changed", JSON.stringify({ topic }));
    await tick(Math.min(EVENT_EVERY_MS, ms - spent));
  }
}

type Fetch = ReturnType<typeof stubFetch>;

/** Each GET the app made at or after `since` (fake time) and before `until`, with its count. */
function gets(fetch: Fetch, at: number[], since: number, until: number): Map<string, number> {
  const counts = new Map<string, number>();
  fetch.mock.calls.forEach(([url, init], i) => {
    const t = at[i] ?? 0;
    if (t < since || t >= until || (init?.method ?? "GET") !== "GET") return;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  });
  return counts;
}

function open(path: string, routes: Record<string, unknown> = {}) {
  window.history.replaceState(null, "", path);
  const fetch = stubFetch({ "/api/repos": REPOS, "/api/config": CONFIG, ...routes });
  const at: number[] = [];
  const answer = fetch.getMockImplementation();
  fetch.mockImplementation(async (input: string, init?: RequestInit) => {
    at.push(Date.now());
    if (!answer) throw new Error("stubFetch has no implementation");
    return answer(input, init);
  });
  const stop = startStream();
  Stream.last?.emit("open");
  const view = render(<App />);
  return {
    fetch,
    at,
    close() {
      stop();
      view.unmount();
    },
  };
}

const repeated = (counts: Map<string, number>) => [...counts].filter(([, n]) => n > 1);

describe("load-time fetches", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.stubGlobal("EventSource", Stream);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(Object.entries(PAGE_PATHS))(
    "%s asks for each URL once in its first six seconds, while every topic keeps changing",
    async (_, path) => {
      const t0 = Date.now();
      const page = open(path);
      await busyStream(OPENING_MS);
      const counts = gets(page.fetch, page.at, t0, t0 + OPENING_MS);
      page.close();
      expect(counts.size).toBeGreaterThan(0);
      expect(repeated(counts)).toEqual([]);
    },
  );

  it.each([
    ["Telemetry", PAGE_PATHS.telemetry],
    ["Audit", PAGE_PATHS.audit],
    ["FLIGHT", PAGE_PATHS.flight],
  ])(
    "a switch to %s asks for each URL once in six seconds, while every topic keeps changing",
    async (_, path) => {
      const page = open(PAGE_PATHS.overview);
      await busyStream(10_000);
      const switched = Date.now();
      act(() => navigate(path));
      await busyStream(OPENING_MS);
      const counts = gets(page.fetch, page.at, switched, switched + OPENING_MS);
      page.close();
      expect(repeated(counts)).toEqual([]);
    },
  );

  it("Telemetry asks for the 7-day range only once the range on screen has answered", async () => {
    const shown = RESOURCES.telemetry("24h").path;
    const week = RESOURCES.telemetry("7d").path;
    const page = open(PAGE_PATHS.telemetry, { [shown]: () => new Promise(() => {}) });
    await tick(2000);
    const asked = page.fetch.mock.calls.map(([url]) => url);
    page.close();
    expect(asked).toContain(shown);
    expect(asked).not.toContain(week);
  });
});
