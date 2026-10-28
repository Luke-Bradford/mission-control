import { type MapDelta, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import * as THREE from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewMapView } from "../src/map/CrewMap.tsx";
import { LiveMap } from "../src/map/live.ts";
import type { MotionEvent } from "../src/map/motion.ts";
import { renderer } from "./mapRendererMock.ts";

await import("../src/map/MapScene.tsx");
const listeners: Record<string, (e: MessageEvent) => void> = {};
let fresh: MapSnapshot;
let getSnapshot: () => Promise<MapSnapshot>;
const events: MotionEvent[] = [];
const edit = (seq: number, seat = "GUIDO-1", file = "src/main.ts"): MapDelta => ({
  type: "edit",
  seq,
  seat,
  file,
  add: 8,
  rem: 0,
});
const emit = async (delta: MapDelta) => {
  await act(async () => listeners.map(new MessageEvent("map", { data: JSON.stringify(delta) })));
  act(() => vi.advanceTimersByTime(40));
};
function Harness() {
  const [snapshot, receive] = useState(fresh);
  const [motion, animate] = useState<MotionEvent[]>([]);
  const [epoch, reconnect] = useState(0);
  useEffect(() => {
    const live = new LiveMap(
      "sample",
      () => getSnapshot(),
      receive,
      vi.fn(),
      vi.fn(),
      (event) => {
        events.push(event);
        animate((old) => [...old, event]);
      },
      reconnect,
    );
    live.start();
    return () => live.stop();
  }, []);
  return <CrewMapView snapshot={snapshot} events={motion} epoch={epoch} />;
}
function points() {
  const scene = renderer.render.mock.lastCall?.[0] as THREE.Scene;
  let result: THREE.Points | undefined;
  scene.traverse((object) => {
    if (object instanceof THREE.Points) result = object;
  });
  return result?.geometry as THREE.BufferGeometry;
}
const GAP = LiveMap.REFETCH_GAP_MS;
beforeEach(() => {
  // reconciliation, not the refetch throttle (CrewMap.test.tsx), is under test here
  LiveMap.REFETCH_GAP_MS = 0;
  vi.useFakeTimers();
  fresh = { ...structuredClone(mapSnapshotFixture), seq: 0 };
  events.length = 0;
  getSnapshot = async () => structuredClone(fresh);
  renderer.render.mockClear();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  LiveMap.REFETCH_GAP_MS = GAP;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function start() {
  await act(async () => {
    render(<Harness />);
  });
  await act(async () => listeners.open(new MessageEvent("open")));
  act(() => vi.advanceTimersByTime(40));
}
it("resets motion after reconnect from sequence 100 to 1 without replaying retained events", async () => {
  await start();
  await emit(edit(100));
  expect(points().drawRange.count).toBe(1);
  act(() => vi.advanceTimersByTime(7000));
  await act(async () => listeners.open(new MessageEvent("open")));
  act(() => vi.advanceTimersByTime(40));
  expect(points().drawRange.count).toBe(0);
  await emit(edit(1));
  expect(points().drawRange.count).toBe(1);
  await emit(edit(1));
  expect(events).toHaveLength(2);
  expect(points().drawRange.count).toBe(1);
});
it("reconciles a missed call.end with the authoritative snapshot before a later read", async () => {
  await start();
  const startCall: MapDelta = {
    type: "call.start",
    seq: 1,
    seat: "GUIDO-1",
    tool: "Read",
    detail: "read",
    files: ["src/main.ts"],
  };
  await emit(startCall);
  // The first call ended off-stream. The refreshed seat has no in-flight calls.
  fresh.seats[0].calls = [];
  await act(async () =>
    listeners.changed(new MessageEvent("changed", { data: '{"topic":"agents"}' })),
  );
  fresh.seats[0].calls = [
    { tool: "Read", detail: "read", files: ["src/main.ts"], since: Date.now() },
  ];
  await emit({ ...startCall, seq: 2 });
  await emit({
    type: "call.end",
    seq: 3,
    seat: "GUIDO-1",
    files: ["src/main.ts"],
    resultTok: 10,
    error: false,
    refused: false,
    why: null,
    tests: null,
  });
  expect(points().drawRange.count).toBe(1);
});
it("waits for a new seat and branch-only file in the refetch, retaining the event timestamp", async () => {
  await start();
  fresh.seats.push({
    ...structuredClone(fresh.seats[0]),
    seat: "NEW-1",
    calls: [],
    scope: { read: [], modified: [{ file: "branch/new.ts", add: 8, rem: 0, source: "diff" }] },
  });
  await emit(edit(1, "NEW-1", "branch/new.ts"));
  expect(points().drawRange.count).toBe(1);
  expect(events[0].at).toBeLessThan(Date.now());
});

it("retries a delayed refetch against branch-only display nodes without restarting the spark lifetime", async () => {
  await start();
  let resolve: (snapshot: MapSnapshot) => void = () => {
    throw new Error("No request");
  };
  getSnapshot = () =>
    new Promise((done) => {
      resolve = done;
    });
  await emit(edit(1, "GUIDO-1", "branch/new.ts"));
  expect(points().drawRange.count).toBe(0);
  act(() => vi.advanceTimersByTime(300));
  fresh.seats[0].scope.modified.push({ file: "branch/new.ts", add: 8, rem: 0, source: "diff" });
  await act(async () => resolve(structuredClone(fresh)));
  act(() => vi.advanceTimersByTime(40));
  expect(points().drawRange.count).toBe(1);
  act(() => vi.advanceTimersByTime(500));
  expect(points().drawRange.count).toBe(0);
});

it("ignores an old connection's in-flight snapshot so its watermark cannot suppress new motion", async () => {
  await start();
  await emit(edit(100));
  act(() => vi.advanceTimersByTime(7000));
  let resolve: (snapshot: MapSnapshot) => void = () => {
    throw new Error("No request");
  };
  getSnapshot = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<MapSnapshot>((done) => {
          resolve = done;
        }),
    )
    .mockImplementation(async () => structuredClone(fresh));
  await act(async () =>
    listeners.changed(new MessageEvent("changed", { data: '{"topic":"agents"}' })),
  );
  await act(async () => listeners.open(new MessageEvent("open")));
  await act(async () => resolve({ ...structuredClone(fresh), seq: 100 }));
  await act(async () => vi.advanceTimersByTimeAsync(40));
  await emit(edit(1));
  expect(events).toHaveLength(2);
  expect(points().drawRange.count).toBe(1);
});
