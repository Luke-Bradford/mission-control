import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { startStream } from "../src/data.ts";
import "../src/pages/Agent.tsx";
import "../src/pages/Overview.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, REPOS } from "./fixtures.ts";

class Stream {
  static OPEN = 1;
  readyState = Stream.OPEN;
  addEventListener() {}
  close() {}
}

async function loadFetches(path: string, pageId: string): Promise<Map<string, number>> {
  window.history.replaceState(null, "", path);
  const fetch = stubFetch({ "/api/repos": REPOS, "/api/config": CONFIG });
  const stop = startStream();
  const view = render(<App />);
  for (let i = 0; i < 20 && !view.container.querySelector(`#${pageId}`); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  stop();
  view.unmount();
  const counts = new Map<string, number>();
  for (const [url, init] of fetch.mock.calls as [string, RequestInit?][]) {
    if ((init?.method ?? "GET") !== "GET") continue;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return counts;
}

describe("load-time fetches", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", Stream);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["Overview", "/", "page-overview"],
    ["Agent", "/agent", "page-agent"],
  ])("%s fetches each resource once on load", async (_, path, pageId) => {
    const counts = await loadFetches(path, pageId);
    const dupes = [...counts].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
  });
});
