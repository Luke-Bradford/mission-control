import { type MapSnapshot, mapDeltaFixture, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewMapView, LiveCrewMap } from "../src/map/CrewMap.tsx";
import { LiveMap } from "../src/map/live.ts";
import { stubFetch } from "./fetchStub.ts";

vi.mock("../src/map/MapScene.tsx", () => ({
  MapScene: ({ focus }: { focus: string | null }) => <div data-focus={focus}>3D scene</div>,
}));
const GAP = LiveMap.REFETCH_GAP_MS;
// these exercise ordering and resync; the throttle has its own test below
beforeEach(() => {
  LiveMap.REFETCH_GAP_MS = 0;
});
afterEach(() => {
  LiveMap.REFETCH_GAP_MS = GAP;
  vi.unstubAllGlobals();
});
it("renders the fixture, searches and opens the file drawer with honest changes and findings", async () => {
  render(<CrewMapView snapshot={mapSnapshotFixture} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file or folder" }), {
    target: { value: "main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "src/main.ts" }));
  expect(screen.getByRole("complementary", { name: "Selected file" }).textContent).toContain(
    "edit churn",
  );
  expect(screen.getByRole("complementary", { name: "Selected file" }).textContent).toContain(
    "GUIDO-1",
  );
  expect(screen.getByRole("button", { name: "⌖ Zoom to file" })).toBeTruthy();
  expect(await screen.findByText("3D scene")).toBeTruthy();
});
it("loads live data, resyncs a gap and reconnect, and closes its subscription", async () => {
  const sources: {
    listeners: Record<string, (e: MessageEvent) => void>;
    close: ReturnType<typeof vi.fn>;
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
  const get = vi.fn().mockResolvedValue({ ...mapSnapshotFixture, seq: 10 });
  const receive = vi.fn();
  const live = new LiveMap("sample", get, receive, vi.fn());
  live.start();
  sources[0].listeners.open(new MessageEvent("open"));
  await waitFor(() => expect(receive).toHaveBeenCalled());
  sources[0].listeners.map(
    new MessageEvent("map", {
      data: JSON.stringify({
        type: "diff",
        seq: 11,
        seat: "GUIDO-1",
        file: "src/main.ts",
        add: 99,
        rem: 1,
      }),
    }),
  );
  expect(receive.mock.lastCall?.[0].seats[0].scope.modified[0].add).toBe(99);
  sources[0].listeners.map(
    new MessageEvent("map", {
      data: JSON.stringify({ type: "state", seq: 13, seat: "GUIDO-1", state: "idle", since: 4 }),
    }),
  );
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  sources[0].listeners.open(new MessageEvent("open"));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  live.stop();
  expect(sources[0].close).toHaveBeenCalledOnce();
});

it("treats zero-sequence snapshots as authoritative instead of double-counting edit churn", async () => {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  const snapshot = { ...structuredClone(mapSnapshotFixture), seq: 0 };
  const get = vi.fn().mockImplementation(async () => structuredClone(snapshot));
  const receive = vi.fn();
  const live = new LiveMap("sample", get, receive, vi.fn());
  live.start();
  await waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
  listeners.map(
    new MessageEvent("map", {
      data: JSON.stringify({
        type: "edit",
        seq: 1,
        seat: "GUIDO-1",
        file: "src/main.ts",
        add: 12,
        rem: 3,
      }),
    }),
  );
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(receive.mock.lastCall?.[0].seats[0].scope.modified[0].add).toBe(12);
  live.stop();
});

it("reports calls skipped while hidden without replaying motion", async () => {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const skipped = vi.fn();
  const receive = vi.fn();
  const live = new LiveMap(
    "sample",
    async () => ({ ...structuredClone(mapSnapshotFixture), seq: 10 }),
    receive,
    vi.fn(),
    skipped,
  );
  live.start();
  await waitFor(() => expect(receive).toHaveBeenCalled());
  listeners.map(
    new MessageEvent("map", {
      data: JSON.stringify({
        type: "call.start",
        seq: 11,
        seat: "GUIDO-1",
        tool: "Read",
        detail: "src/util.ts",
        files: ["src/util.ts"],
      }),
    }),
  );
  listeners.map(
    new MessageEvent("map", {
      data: JSON.stringify({
        type: "message",
        seq: 12,
        from: "GUIDO-1",
        to: "CAPCOM",
        kind: "question",
        ticket: 7,
      }),
    }),
  );
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(skipped).toHaveBeenCalledWith(1, 1);
  live.stop();
  hidden.mockRestore();
});

it("renders live file changes in the open drawer", async () => {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  stubFetch({
    "/api/repos": [{ id: "sample" }],
    "/api/crew": { rows: [] },
    "/api/config": { crew: { sessions: [] } },
    "/api/repos/sample/map": { ...mapSnapshotFixture, seq: 10 },
  });
  render(<LiveCrewMap repo="sample" />);
  const search = await screen.findByRole("searchbox", { name: "Find a file or folder" });
  fireEvent.change(search, { target: { value: "util" } });
  fireEvent.click(screen.getByRole("button", { name: "src/util.ts" }));
  act(() =>
    listeners.map(
      new MessageEvent("map", {
        data: JSON.stringify({
          type: "diff",
          seq: 11,
          seat: "GUIDO-1",
          file: "src/util.ts",
          add: 55,
          rem: 2,
        }),
      }),
    ),
  );
  expect(screen.getByRole("complementary", { name: "Selected file" }).textContent).toContain(
    "+55 −2 · branch diff",
  );
});

it("finds individual files in a collapsed tree and focuses their folder", async () => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.tree = Array.from({ length: 2001 }, (_, i) => ({ path: `src/file-${i}.ts`, lines: 1 }));
  snapshot.tree.push({ path: "settings.ts", lines: 1 });
  render(<CrewMapView snapshot={snapshot} />);
  const search = screen.getByRole("searchbox", { name: "Find a file or folder" });
  fireEvent.change(search, { target: { value: "file-2000" } });
  fireEvent.click(screen.getByRole("button", { name: "src/file-2000.ts" }));
  expect(screen.getByRole("heading", { name: "src/file-2000.ts" })).toBeTruthy();
  await waitFor(() => expect(screen.getByText("3D scene").getAttribute("data-focus")).toBe("src"));
  fireEvent.change(search, { target: { value: "settings.ts" } });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.getByRole("heading", { name: "settings.ts" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByText("3D scene").getAttribute("data-focus")).toBe("(root files)"),
  );
});

it("refreshes an open checkout diff after a live map delta", async () => {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats[0].scope.modified = [{ file: "src/util.ts", add: 1, rem: 0, source: "diff" }];
  let text = "before edit";
  stubFetch({
    "/api/repos": [{ id: "sample" }],
    "/api/crew": { rows: [] },
    "/api/config": { crew: { sessions: [] } },
    "/api/repos/sample/map": { ...snapshot, seq: 10 },
    "/api/agents/GUIDO-1/files/diff?path=src%2Futil.ts": () => ({
      status: 200,
      body: { text, binary: false, truncated: false },
    }),
  });
  render(<LiveCrewMap repo="sample" />);
  fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "util" } });
  fireEvent.click(screen.getByRole("button", { name: "src/util.ts" }));
  fireEvent.click(screen.getByRole("button", { name: "Current checkout diff" }));
  await screen.findByText("before edit");
  text = "after edit";
  act(() =>
    listeners.map(
      new MessageEvent("map", {
        data: JSON.stringify({
          type: "diff",
          seq: 11,
          seat: "GUIDO-1",
          file: "src/util.ts",
          add: 55,
          rem: 2,
        }),
      }),
    ),
  );
  await screen.findByText("after edit");
  expect(screen.queryByText("before edit")).toBeNull();
});

it("delivers each live animation once, including events that require a snapshot refetch", async () => {
  const listeners: Record<string, (e: MessageEvent) => void> = {};
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(k: string, cb: (e: MessageEvent) => void) {
        listeners[k] = cb;
      }
      close() {}
    },
  );
  const animate = vi.fn();
  const get = vi.fn(async () => structuredClone(mapSnapshotFixture));
  const live = new LiveMap("sample", get, vi.fn(), vi.fn(), vi.fn(), animate);
  live.start();
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  for (const delta of mapDeltaFixture) {
    const event = new MessageEvent("map", { data: JSON.stringify(delta) });
    listeners.map(event);
    listeners.map(event);
  }
  expect(animate.mock.calls.map(([event]) => event.delta)).toEqual(mapDeltaFixture);
  expect(get.mock.calls.length).toBeGreaterThan(1);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  listeners.map(
    new MessageEvent("map", { data: JSON.stringify({ ...mapDeltaFixture[0], seq: 8 }) }),
  );
  expect(animate).toHaveBeenCalledTimes(mapDeltaFixture.length);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(animate).toHaveBeenCalledTimes(mapDeltaFixture.length);
  live.stop();
  hidden.mockRestore();
});

it("throttles delta-driven refetches to one per 2 s, never holding the first load", async () => {
  LiveMap.REFETCH_GAP_MS = GAP;
  vi.useFakeTimers();
  try {
    const listeners: Record<string, (e: MessageEvent) => void> = {};
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener(k: string, cb: (e: MessageEvent) => void) {
          listeners[k] = cb;
        }
        close() {}
      },
    );
    const get = vi.fn(async () => structuredClone({ ...mapSnapshotFixture, seq: 0 }));
    const live = new LiveMap("sample", get, vi.fn(), vi.fn());
    live.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    // a burst of edits and pings, each of which invalidates a seq-0 snapshot
    for (let seq = 1; seq <= 5; seq++) {
      listeners.map(
        new MessageEvent("map", {
          data: JSON.stringify({
            type: "edit",
            seq,
            seat: "GUIDO-1",
            file: "src/main.ts",
            add: 1,
            rem: 0,
          }),
        }),
      );
      listeners.changed(new MessageEvent("changed", { data: JSON.stringify({ topic: "agents" }) }));
    }
    await vi.advanceTimersByTimeAsync(1900);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(get).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(get).toHaveBeenCalledTimes(2);
    live.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("says in the file drawer when a seat's branch went unchecked for conflicts, and lists each pair", () => {
  const snapshot: MapSnapshot = {
    ...structuredClone(mapSnapshotFixture),
    conflictsUnchecked: [{ branch: "feature/7-empty-input", reason: "merge check failed" }],
    conflicts: [
      { file: "src/main.ts", branches: ["a", "b"], shas: ["1".repeat(40), "2".repeat(40)] },
      { file: "src/main.ts", branches: ["a", "c"], shas: ["1".repeat(40), "3".repeat(40)] },
    ],
  };
  render(<CrewMapView snapshot={snapshot} />);
  // one muted rail line; its list reaches every conflict from the keyboard
  const line = screen.getByText(/1 file in conflict · 1 branch not checked/);
  fireEvent.click(line);
  expect(
    within(screen.getByRole("list", { name: "Branches not checked for conflicts" })).getByText(
      "feature/7-empty-input: merge check failed",
    ),
  ).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole("list", { name: "Merge conflicts between open PRs" })).getByRole(
      "button",
      { name: "src/main.ts" },
    ),
  );
  const drawer = screen.getByRole("complementary", { name: "Selected file" });
  expect(drawer.textContent).toContain("Conflicts not checked: merge check failed");
  expect(drawer.textContent).toContain("Conflict: a / b");
  expect(drawer.textContent).toContain("Conflict: a / c");
});
