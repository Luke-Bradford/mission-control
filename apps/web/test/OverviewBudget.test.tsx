import { gzipSync } from "node:zlib";
import { act, render, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Overview } from "../src/pages/Overview.tsx";
import { stubFetch } from "./fetchStub.ts";
import { CONFIG, METRICS_VIEW, NOW, OVERVIEW, seatRow } from "./fixtures.ts";

/** The Overview's whole payload may weigh this much compressed (design system §9). */
const PAYLOAD_GZIP_BUDGET = 60 * 1024;
/** One commit per 5 s clock tick, no more, while the crew is idle. */
const IDLE_MINUTE_COMMITS = 12;

const seats = Array.from({ length: 12 }, (_, i) =>
  seatRow({ id: `seat-${i}`, index: i, hudState: "idle", run: null, digest: null }),
);

const api = {
  "/api/overview": OVERVIEW,
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew?shape=summary": { rows: seats, firstRunToday: null },
  "/api/attention": [],
  "/api/machine": { latest: null, warning: null },
  "/api/limits": [],
  "/api/limits/github": { queries: {}, pollCost: null },
  "/api/health": [],
  "/api/activity": [],
  "/api/settings/away": { on: false, until: "", may: {} },
  "/api/config": CONFIG,
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true, note: null },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("re-renders the page only for data and the 5 s clock: at most 12 commits in an idle minute", async () => {
  const fn = stubFetch(api);
  let commits = 0;
  const { container } = render(
    <Profiler id="overview" onRender={() => commits++}>
      <Overview />
    </Profiler>,
  );
  await waitFor(() =>
    expect(container.querySelectorAll(".trow:not(.head)").length).toBeGreaterThan(5),
  );
  await act(async () => {
    await Promise.all(fn.mock.results.map((r) => r.value));
  });
  commits = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(commits).toBeLessThanOrEqual(IDLE_MINUTE_COMMITS);
});

it("fetches an Overview payload under 60 KB gzipped for a 12-seat crew", async () => {
  const fn = stubFetch(api);
  render(<Overview />);
  await waitFor(() => expect(fn.mock.calls.length).toBeGreaterThan(8));
  const paths = new Set(fn.mock.calls.map(([path]) => String(path).split("?")[0]));
  const bytes = [...paths].reduce((total, path) => {
    const body = (api as Record<string, unknown>)[path];
    return total + (body === undefined ? 0 : gzipSync(JSON.stringify(body)).length);
  }, 0);
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(PAYLOAD_GZIP_BUDGET);
});
