import { type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrewMapView, LiveCrewMap } from "../src/map/CrewMap.tsx";
import { LiveMap } from "../src/map/live.ts";
import { stubFetch } from "./fetchStub.ts";

const GAP = LiveMap.REFETCH_GAP_MS;
// these exercise ordering and resync; the throttle has its own test below
beforeEach(() => {
  LiveMap.REFETCH_GAP_MS = 0;
});
afterEach(() => {
  LiveMap.REFETCH_GAP_MS = GAP;
  vi.unstubAllGlobals();
});
it("finds a file and shows each seat that touched it: changed with its +/−, read, or both", async () => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.seats.push({
    ...structuredClone(snapshot.seats[0]),
    seat: "GUIDO-2",
    calls: [],
    scope: {
      read: ["src/main.ts"],
      modified: [{ file: "src/main.ts", add: 30, rem: 4, source: "diff" }],
    },
  });
  snapshot.seats.push({
    ...structuredClone(snapshot.seats[0]),
    seat: "RETRO-1",
    calls: [],
    scope: { read: ["src/main.ts"], modified: [] },
  });
  render(<CrewMapView snapshot={snapshot} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a file" }), {
    target: { value: "main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "src/main.ts" }));
  const card = screen.getByRole("complementary", { name: "Selection detail" });
  expect(within(card).getByRole("heading", { name: "src/main.ts" })).toBeTruthy();
  const who = within(card).getByRole("list", { name: "Seats that touched it" });
  expect([...who.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "GUIDO-1changed +12 −3 edit churn · read",
    "GUIDO-2changed +30 −4 · read",
    "RETRO-1read",
  ]);
  expect(within(card).queryByRole("button", { name: "Show on map" })).toBeNull();
  expect(screen.getByRole("group", { name: "Changes treemap" })).toBeTruthy();
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

it("updates the open card as live changes arrive", async () => {
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
    "/api/crew?shape=summary": { rows: [] },
    "/api/config": { crew: { sessions: [] } },
    "/api/repos/sample/map": { ...mapSnapshotFixture, seq: 10 },
  });
  render(<LiveCrewMap repo="sample" />);
  const search = await screen.findByRole("searchbox", { name: "Find a file" });
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
  expect(
    within(screen.getByRole("list", { name: "Seats that touched it" }))
      .getByText("GUIDO-1")
      .closest("li")?.textContent,
  ).toBe("GUIDO-1changed +55 −2 · read");
});

it("finds and focuses individual files in a large tree", async () => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.tree = Array.from({ length: 2001 }, (_, i) => ({ path: `src/file-${i}.ts`, lines: 1 }));
  snapshot.tree.push({ path: "settings.ts", lines: 1 });
  render(<CrewMapView snapshot={snapshot} />);
  const search = screen.getByRole("searchbox", { name: "Find a file" });
  fireEvent.change(search, { target: { value: "file-2000" } });
  fireEvent.click(screen.getByRole("button", { name: "src/file-2000.ts" }));
  expect(screen.getByRole("heading", { name: "src/file-2000.ts" })).toBeTruthy();
  fireEvent.change(search, { target: { value: "settings.ts" } });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(screen.getByRole("heading", { name: "settings.ts" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "src/file-2000.ts" })).toBeNull();
}, 20_000);

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

it("ignores an old connection's in-flight snapshot after a reconnect", async () => {
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
  let resolve: (snapshot: MapSnapshot) => void = () => {};
  const get = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<MapSnapshot>((done) => {
          resolve = done;
        }),
    )
    .mockImplementation(async () => ({ ...structuredClone(mapSnapshotFixture), seq: 5 }));
  const receive = vi.fn();
  const live = new LiveMap("sample", get, receive, vi.fn());
  live.start();
  listeners.open(new MessageEvent("open"));
  // the connection drops and comes back while the first snapshot is still on its way
  listeners.open(new MessageEvent("open"));
  await act(async () => resolve({ ...structuredClone(mapSnapshotFixture), seq: 100 }));
  await waitFor(() => expect(receive).toHaveBeenCalled());
  expect(receive.mock.calls.map(([s]) => s.seq)).toEqual([5]);
  live.stop();
});

it("shows Changes and the timeline with no lens tabs, and badges conflicting files and seats", () => {
  const snapshot: MapSnapshot = structuredClone(mapSnapshotFixture);
  snapshot.conflicts = [
    {
      file: "src/main.ts",
      branches: ["feature/7-empty-input", "feature/9-other"],
      shas: ["a".repeat(40), "b".repeat(40)],
    },
  ];
  render(<CrewMapView snapshot={snapshot} />);
  for (const name of ["Impact", "History", "Ownership", "Review", "Conflicts"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(screen.getByRole("group", { name: "Changes treemap" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Session timeline" })).toBeTruthy();

  const tile = document.querySelector<HTMLElement>(".map-treemap-tile[title='src/main.ts']");
  expect(tile?.hasAttribute("data-conflict")).toBe(true);
  expect(tile?.textContent).toContain("conflict");
  // the seat keeps its colour at full strength under the badge
  expect(tile?.style.getPropertyValue("--tile-colour")).toBe("var(--seat-1)");
  expect(tile?.getAttribute("aria-description")).toContain(
    "conflicts between feature/7-empty-input, feature/9-other",
  );
  const seat = screen.getByRole("button", { name: /^GUIDO-1/ });
  expect(seat.textContent).toContain("1 conflict");
  expect(seat.getAttribute("aria-label")).toContain(", 1 file in conflict");
  expect(screen.getByRole("note", { name: "Changes colour key" }).textContent).toContain(
    "1 file conflicts between open branches · 1 branch pair",
  );

  fireEvent.click(tile as HTMLElement);
  const detail = screen.getByRole("complementary", { name: "Selection detail" });
  expect(detail.textContent).toContain("feature/7-empty-input");
  expect(detail.textContent).toContain("feature/9-other");
});

it("shows no conflict badge, and no conflict line in the key, when nothing conflicts", () => {
  render(<CrewMapView snapshot={structuredClone(mapSnapshotFixture)} />);
  expect(screen.getByRole("button", { name: /^GUIDO-1/ }).textContent).not.toContain("conflict");
  expect(screen.getByRole("note", { name: "Changes colour key" }).textContent).not.toMatch(
    /conflict/i,
  );
});
