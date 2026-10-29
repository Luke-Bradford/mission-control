import { type ConfigView, type MapSnapshot, mapSnapshotFixture } from "@mc/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPage } from "../src/pages/MapPage.tsx";
import { route, usePath } from "../src/router.ts";
import { MAP_REPO_KEY } from "../src/storage.ts";
import { stubFetch } from "./fetchStub.ts";
import { crewRow } from "./fixtures.ts";

vi.mock("../src/map/MapScene.tsx", () => ({
  MapScene: () => <div>3D scene</div>,
}));

/** The app's routing for the Map alone: the page follows the URL it navigates. */
function Harness() {
  const r = route(usePath());
  return r?.page === "map" ? <MapPage repoId={r.repoId} /> : null;
}

const session = (repoId: string) => ({
  id: `${repoId}-session`,
  repoId,
  checkout: `/mc/${repoId}`,
  seats: [{ id: `${repoId}-dev`, role: "GUIDO", loop: "build" }],
});
/** Two crew repos and one watched only by an observed loop, listed first. */
const config = {
  crew: { sessions: [session("sample"), session("second")] },
  loops: [{ id: "watch-loop", repoId: "observed" }],
} as unknown as ConfigView;
const repos = [{ id: "observed" }, { id: "sample" }, { id: "second" }];
const idle: MapSnapshot = {
  ...structuredClone(mapSnapshotFixture),
  seats: mapSnapshotFixture.seats.map((s) => ({
    ...structuredClone(s),
    state: "idle" as const,
    calls: [],
    recent: [],
    scope: { read: [], modified: [] },
    badges: { ...structuredClone(s.badges), questions: [], waiting: null },
  })),
  findings: [],
};

const at = (path: string) => {
  window.history.replaceState(null, "", path);
  return render(<Harness />);
};

beforeEach(() => {
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  localStorage.removeItem(MAP_REPO_KEY);
});
afterEach(() => vi.unstubAllGlobals());

describe("Map page", () => {
  it("/map goes to the first crew repo, skipping one only an observed loop watches", async () => {
    const fetch = stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
      "/api/repos/sample/map": mapSnapshotFixture,
    });
    at("/map");
    await waitFor(() => expect(window.location.pathname).toBe("/map/sample"));
    expect(await screen.findByText("3D scene")).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/repos/sample/map", expect.anything());
    expect(fetch).not.toHaveBeenCalledWith("/api/repos/observed/map", expect.anything());
    const picker = screen.getByRole("combobox", { name: "Map repo" }) as HTMLSelectElement;
    expect(picker.value).toBe("sample");
    const observed = within(picker).getByRole("option", {
      name: "observed · observed loop, not mapped yet",
    }) as HTMLOptionElement;
    expect(observed.disabled).toBe(true);
    expect(
      (within(picker).getByRole("option", { name: "sample · 0 crew seats" }) as HTMLOptionElement)
        .disabled,
    ).toBe(false);
  });

  it("/map goes to the repo with running crew seats", async () => {
    stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": {
        rows: [crewRow({ id: "second-dev", kind: "crew", repoId: "second", hudState: "running" })],
      },
      "/api/repos/second/map": { ...mapSnapshotFixture, repoId: "second" },
    });
    at("/map");
    await waitFor(() => expect(window.location.pathname).toBe("/map/second"));
  });

  it("switches repo from the picker: the URL, the subscription and the map follow", async () => {
    const fetch = stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
      "/api/repos/sample/map": mapSnapshotFixture,
      "/api/repos/second/map": { ...mapSnapshotFixture, repoId: "second" },
    });
    at("/map/sample");
    await screen.findByText("3D scene");
    fireEvent.change(screen.getByRole("combobox", { name: "Map repo" }), {
      target: { value: "second" },
    });
    await waitFor(() => expect(window.location.pathname).toBe("/map/second"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/repos/second/map", expect.anything()),
    );
    expect((screen.getByRole("combobox", { name: "Map repo" }) as HTMLSelectElement).value).toBe(
      "second",
    );
    expect(localStorage.getItem(MAP_REPO_KEY)).toBe("second");
  });

  it("says why an observed repo is not mapped instead of loading it", async () => {
    const fetch = stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
    });
    at("/map/observed");
    expect((await screen.findByRole("status")).textContent).toContain(
      "observed · observed loop, not mapped yet",
    );
    expect(fetch).not.toHaveBeenCalledWith("/api/repos/observed/map", expect.anything());
  });

  it("is honest when no repo has a crew session", async () => {
    stubFetch({
      "/api/repos": repos,
      "/api/config": { crew: null, loops: [] },
      "/api/crew": { rows: [] },
    });
    at("/map");
    expect((await screen.findByRole("status")).textContent).toContain(
      "No repo has a crew session yet",
    );
    expect(window.location.pathname).toBe("/map");
    expect(screen.getByRole("link", { name: "Setup · Sessions" }).getAttribute("href")).toBe(
      "/setup/sessions",
    );
  });

  it("shows the tree with an honest empty state when the repo has no recorded activity", async () => {
    stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
      "/api/repos/sample/map": idle,
    });
    at("/map/sample");
    await screen.findByText("3D scene");
    expect(screen.getByText("No seat is working in this repo right now.")).toBeTruthy();
    expect(screen.getByText(/2 files/)).toBeTruthy();
  });

  it("uses h2 headings for the mapped page's Seats and Selected sections", async () => {
    stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
      "/api/repos/sample/map": idle,
    });
    at("/map/sample");
    await screen.findByText("3D scene");
    expect(screen.getByRole("heading", { level: 1, name: "Crew activity map" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Seats" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Selected" })).toBeTruthy();
  });

  it("says the map is unavailable, and retrying, when the snapshot fails", async () => {
    stubFetch({
      "/api/repos": repos,
      "/api/config": config,
      "/api/crew": { rows: [] },
      "/api/repos/sample/map": () => ({
        status: 503,
        body: { error: "map snapshot unavailable" },
      }),
    });
    at("/map/sample");
    expect(await screen.findByText("Map snapshot unavailable. Retrying every 5 s.")).toBeTruthy();
  });
});
