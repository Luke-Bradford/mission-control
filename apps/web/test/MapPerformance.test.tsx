import { type MapPayload, mapSnapshotFixture, packMapTree } from "@mc/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { hub } from "../src/data.ts";
import { graph, ownershipOf } from "../src/lenses/lenses.tsx";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { useMapTime } from "../src/map/clock.ts";
import { LiveMap } from "../src/map/live.ts";
import { shareMap } from "../src/map/structural.ts";
import { useGraphSnapshot } from "../src/map/useGraphSnapshot.ts";
import { stubFetch } from "./fetchStub.ts";

afterEach(() => {
  cleanup();
  hub.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps tree, rules and analysis identities across live changes and equivalent rules objects", () => {
  const before = structuredClone(mapSnapshotFixture);
  const next = shareMap(before, { ...structuredClone(before), seq: before.seq + 1 });
  for (const part of ["tree", "imports", "hist", "rules"] as const)
    expect(next[part]).toBe(before[part]);
  expect(graph(next)).toBe(graph(before));
  expect(ownershipOf(structuredClone(before.rules))).toBe(ownershipOf(before.rules));
  expect(ownershipOf({ ...before.rules, hardRules: ["other/**"] })).not.toBe(
    ownershipOf(before.rules),
  );
});
it("closes the stream and stops reads while hidden, then reconciles on return", async () => {
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const sources: {
    close: ReturnType<typeof vi.fn>;
    listeners: Record<string, (e: MessageEvent) => void>;
  }[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      listeners: Record<string, (e: MessageEvent) => void> = {};
      close = vi.fn();
      constructor() {
        sources.push(this);
      }
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        this.listeners[k] = cb;
      }
    },
  );
  const get = vi.fn(async () => structuredClone(mapSnapshotFixture));
  const receive = vi.fn();
  const live = new LiveMap("sample", get, receive, vi.fn());
  live.start();
  await waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(sources[0]?.close).toHaveBeenCalledOnce();
  await live.refresh();
  expect(get).toHaveBeenCalledTimes(1);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(sources).toHaveLength(2);
  live.stop();
});
it("does not request a graph until analysis is opened, then reuses it by its tree/history key", async () => {
  const { imports: _, hist: __, ...base } = mapSnapshotFixture;
  const wire: MapPayload = { ...base, tree: packMapTree(base.tree), graphKey: "graph-1" };
  const fetch = stubFetch({
    "/api/repos/sample/map": wire,
    "/api/repos/sample/map/graph?key=graph-1": {
      key: "graph-1",
      imports: [[0, 1]],
      hist: mapSnapshotFixture.hist,
    },
  });
  function View() {
    const [asked, setAsked] = useState(false);
    const data = useGraphSnapshot(asked ? "sample" : null);
    return (
      <>
        <button type="button" onClick={() => setAsked(true)}>
          Open history
        </button>
        <output>{data.data?.imports.length ?? "waiting"}</output>
      </>
    );
  }
  render(<View />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open history" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1"));
  expect(fetch.mock.calls.filter(([path]) => path.includes("/graph?")).length).toBe(1);
  await act(async () => {
    await hub.refetchTopic("boards");
  });
  expect(fetch.mock.calls.filter(([path]) => path.includes("/graph?")).length).toBe(1);
});

it("reconciles the base map when main advances before its lazy graph read", async () => {
  const { imports: _, hist: __, ...base } = mapSnapshotFixture;
  let reads = 0;
  const fetch = stubFetch({
    "/api/repos/sample/map": () => ({
      status: 200,
      body: { ...base, tree: packMapTree(base.tree), graphKey: ++reads === 1 ? "old" : "new" },
    }),
    "/api/repos/sample/map/graph?key=old": () => ({
      status: 409,
      body: { error: "Map graph changed; reload the map" },
    }),
    "/api/repos/sample/map/graph?key=new": {
      key: "new",
      imports: [[0, 1]],
      hist: mapSnapshotFixture.hist,
    },
  });
  function View() {
    const data = useGraphSnapshot("sample");
    return <output>{data.data?.imports.length ?? data.error?.message ?? "loading"}</output>;
  }
  render(<View />);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1"));
  expect(reads).toBe(2);
  expect(fetch.mock.calls.some(([path]) => path.endsWith("key=new"))).toBe(true);
});

it("bounds repeated graph-key conflicts and lets a person retry after the tree settles", async () => {
  const { imports: _, hist: __, ...base } = mapSnapshotFixture;
  let conflict = true;
  const fetch = stubFetch({
    "/api/repos/sample/map": { ...base, tree: packMapTree(base.tree), graphKey: "key" },
    "/api/repos/sample/map/graph?key=key": () => ({
      status: conflict ? 409 : 200,
      body: conflict
        ? { error: "Map graph changed; reload the map" }
        : { key: "key", imports: [[0, 1]], hist: mapSnapshotFixture.hist },
    }),
  });
  function View() {
    const data = useGraphSnapshot("sample");
    return (
      <>
        <output>{data.data?.imports.length ?? data.error?.message ?? "loading"}</output>
        <button type="button" onClick={data.retry}>
          Retry
        </button>
      </>
    );
  }
  render(<View />);
  await screen.findByText("Map graph changed; reload the map");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(fetch.mock.calls.filter(([path]) => path.includes("/graph?")).length).toBeLessThanOrEqual(
    3,
  );
  conflict = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("1"));
});

it("refreshes map time when a newly received seat already crossed a boundary", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:01Z"));
  const first = structuredClone(mapSnapshotFixture.seats);
  function View({ seats }: { seats: typeof first }) {
    return <output>{useMapTime(seats)}</output>;
  }
  try {
    const view = render(<View seats={first} />);
    const before = Date.now();
    vi.setSystemTime(before + 30_000);
    view.rerender(<View seats={structuredClone(first)} />);
    expect(screen.getByRole("status").textContent).toBe(String(Date.now()));
  } finally {
    vi.useRealTimers();
  }
});
it("pauses an open detail clock while hidden and reconciles on return", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:01Z"));
  let visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  stubFetch({ "/api/config": { operator: { timezone: "UTC" } } });
  const rendered = vi.fn();
  try {
    const view = render(
      <Profiler id="map" onRender={rendered}>
        <CrewMapView snapshot={structuredClone(mapSnapshotFixture)} />
      </Profiler>,
    );
    fireEvent.click(view.container.querySelector("button.map-seat") as HTMLButtonElement);
    await act(async () => {});
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    const count = rendered.mock.calls.length;
    act(() => vi.advanceTimersByTime(15_000));
    expect(rendered).toHaveBeenCalledTimes(count);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(rendered.mock.calls.length).toBeGreaterThan(count);
  } finally {
    vi.useRealTimers();
  }
});

it("bounds unused graph entries while retaining active and settling readers", async () => {
  const path = (key: string) => `/api/repos/sample/map/graph?key=${key}`;
  const fetch = stubFetch(
    Object.fromEntries(
      ["active", ...Array.from({ length: 25 }, (_, i) => String(i))].map((key) => [
        path(key),
        { key, imports: [], hist: mapSnapshotFixture.hist },
      ]),
    ),
  );
  await hub.read({ path: path("active"), topic: null });
  const off = hub.subscribe(path("active"), null, () => {});
  const settledOff = hub.subscribeSettled(path("0"), null, () => {});
  try {
    for (let i = 0; i < 25; i++) await hub.read({ path: path(String(i)), topic: null });
    expect(hub.snapshot(path("active"), null).data).toMatchObject({ key: "active" });
    expect(hub.snapshot(path("0"), null).data).toMatchObject({ key: "0" });
    expect(hub.snapshot(path("1"), null).data).toBeUndefined();
    await hub.read({ path: path("1"), topic: null });
    expect(fetch.mock.calls.filter(([key]) => key === path("1"))).toHaveLength(2);
  } finally {
    off();
    settledOff();
  }
});
