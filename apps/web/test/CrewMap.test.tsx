import { mapSnapshotFixture } from "@mc/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CrewMapPanel, CrewMapView } from "../src/map/CrewMap.tsx";
import { LiveMap } from "../src/map/live.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow } from "./fixtures.ts";

vi.mock("../src/map/MapScene.tsx", () => ({ MapScene: () => <div>3D scene</div> }));
afterEach(() => vi.unstubAllGlobals());
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

it("opens lazily and lets the operator choose a repo while another has running seats", async () => {
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  const fetch = stubFetch({
    "/api/repos": [{ id: "sample" }, { id: "second" }],
    "/api/crew": { rows: [crewRow({ kind: "crew", repoId: "sample", hudState: "running" })] },
    "/api/config": { crew: { sessions: [] } },
    "/api/repos/sample/map": mapSnapshotFixture,
    "/api/repos/second/map": { ...mapSnapshotFixture, repoId: "second" },
  });
  render(<CrewMapPanel />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  await screen.findByRole("option", { name: "second" });
  fireEvent.change(screen.getByRole("combobox", { name: "Map repo" }), {
    target: { value: "second" },
  });
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/repos/second/map", expect.anything()),
  );
  expect((screen.getByRole("combobox", { name: "Map repo" }) as HTMLSelectElement).value).toBe(
    "second",
  );
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
  render(<CrewMapPanel />);
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
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
