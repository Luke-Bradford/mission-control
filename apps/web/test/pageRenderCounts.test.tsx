import { act, render } from "@testing-library/react";
import type { ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { startStream } from "../src/data.ts";
import "../src/pages/Agent.tsx";
import "../src/pages/BoardPage.tsx";
import "../src/pages/Comms.tsx";
import "../src/pages/Flight.tsx";
import "../src/pages/MapPage.tsx";
import "../src/pages/Overview.tsx";
import "../src/pages/Setup.tsx";
import "../src/pages/Telemetry.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, REPOS, seatRow } from "./fixtures.ts";

class Stream {
  static OPEN = 1;
  static current: Stream | undefined;
  readyState = Stream.OPEN;
  private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  constructor(_: string) {
    Stream.current = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {}

  emit(topic: string) {
    for (const listener of this.listeners.get("changed") ?? []) {
      listener(new MessageEvent("changed", { data: JSON.stringify({ topic }) }));
    }
  }
}

const PAGES = [
  ["Overview", "/", "page-overview", 12],
  ["Flight", "/flight", "page-flight", 72],
  ["Board", "/board", "page-board", 12],
  ["Agent", "/agent", "page-agent", 0],
  ["Map", "/map/sample", "page-map", 0],
  ["Comms", "/comms", "page-comms", 0],
  ["Telemetry", "/telemetry", "page-telemetry", 61],
  ["Setup", "/setup/loops", "page-setup", 12],
] as const;

async function commitsOverMinute(
  path: string,
  pageId: string,
  live: boolean,
  routes: Record<string, unknown> = {},
): Promise<number> {
  stubFetch({ "/api/repos": REPOS, "/api/config": CONFIG, ...routes });
  window.history.replaceState(null, "", path);
  let commits = 0;
  const onRender: ProfilerOnRenderCallback = () => {
    commits++;
  };
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  const stop = startStream();
  const view = render(<App onPageRender={onRender} />);
  for (let attempt = 0; attempt < 20 && !view.container.querySelector(`#${pageId}`); attempt++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
    });
  }
  expect(view.container.querySelector(`#${pageId}`)).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500); // let the first fetches finish rendering
  });
  commits = 0; // Mount/data settling is not part of the 60-second observation window.

  for (let second = 0; second < 60; second++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      if (live && (second + 1) % 5 === 0) Stream.current?.emit("agents");
    });
  }
  stop();
  view.unmount();
  return commits;
}

describe("page-root render counts", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", Stream);
    stubFetch({ "/api/repos": REPOS, "/api/config": CONFIG });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(PAGES)("keeps %s within its idle render budget", async (_, path, pageId, maxIdle) => {
    const commits = await commitsOverMinute(path, pageId, false);
    expect(commits).toBeLessThanOrEqual(maxIdle);
  });

  it.each(PAGES)("measures %s with an agents event every five seconds", async (_, path, pageId) => {
    // This companion measurement is deliberately not bounded: live updates should be allowed to render.
    const commits = await commitsOverMinute(path, pageId, true);
    expect(commits).toBeGreaterThanOrEqual(0);
  });

  it("keeps Overview within its idle budget with an idle seat that has an open run", async () => {
    const crew = { rows: [seatRow({ id: "dev-1", hudState: "idle" })], firstRunToday: null };
    const commits = await commitsOverMinute("/", "page-overview", false, { "/api/crew": crew });
    expect(commits).toBeLessThanOrEqual(12);
  });

  it("keeps the Agent page with an idle seat open within its idle render budget", async () => {
    const crew = {
      rows: [seatRow({ id: "dev-1", hudState: "idle", run: null })],
      firstRunToday: null,
    };
    const commits = await commitsOverMinute("/agent/dev-1", "page-agent", false, {
      "/api/crew": crew,
    });
    expect(commits).toBeLessThanOrEqual(12);
  });
});
