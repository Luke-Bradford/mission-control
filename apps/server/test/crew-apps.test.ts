import { describe, expect, it, vi } from "vitest";
import { CREW_APP_DEFAULTS, createCrewApps } from "../src/sessions/apps.ts";

const seat = { id: "guido-eb", repoId: "ebull", worktree: "/crew/ebull" };
const cmux = () => ({
  workspaces: vi.fn().mockResolvedValue([{ id: "ws", name: "guido-eb · #1", cwd: "/crew/ebull" }]),
  newPane: vi.fn().mockResolvedValue("pane"),
  closePane: vi.fn().mockResolvedValue(undefined),
  setStatus: vi.fn(),
  readScreen: vi.fn().mockResolvedValue("ready"),
});
describe("crew apps", () => {
  it("adds eBull panes to its seat workspace on distinct ports without jobs", async () => {
    const pane = cmux();
    const apps = createCrewApps({
      cmux: pane,
      run: vi.fn(),
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
    });
    await apps.start(seat.id);
    expect(pane.newPane).toHaveBeenCalledTimes(2);
    expect(pane.newPane).toHaveBeenCalledWith(
      "ws",
      "/crew/ebull",
      expect.stringContaining("PORT=5173 BACKEND_PORT=5173"),
    );
    expect(pane.newPane).toHaveBeenCalledWith(
      "ws",
      "/crew/ebull",
      expect.stringContaining("PORT=5174 BACKEND_PORT=5173"),
    );
    expect(pane.setStatus).toHaveBeenCalledWith("ws", "app", "http://127.0.0.1:5173");
  });
  it("keeps autonomy-engine and eBull in their own live seat workspaces", async () => {
    const ae = { id: "guido-ae", repoId: "autonomy-engine", worktree: "/crew/autonomy" };
    const pane = cmux();
    pane.workspaces.mockResolvedValue([
      { id: "ae", name: "guido-ae · #2", cwd: ae.worktree },
      { id: "eb", name: "guido-eb · #1", cwd: seat.worktree },
    ]);
    const apps = createCrewApps({
      cmux: pane,
      run: vi.fn(),
      repos: () => [
        { id: "autonomy-engine", commands: CREW_APP_DEFAULTS["autonomy-engine"] ?? [] },
        { id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] },
      ],
      seats: () => [ae, seat],
    });
    await apps.start(ae.id);
    await apps.start(seat.id);
    expect(pane.newPane).toHaveBeenCalledWith(
      "ae",
      ae.worktree,
      expect.stringContaining("PORT=5173"),
    );
    expect(pane.newPane).toHaveBeenCalledWith(
      "eb",
      seat.worktree,
      expect.stringContaining("PORT=5183"),
    );
  });
  it("keeps a running seat's port block when live seats churn", async () => {
    const first = { id: "guido-aa", repoId: "autonomy-engine", worktree: "/crew/aa" };
    const later = { id: "guido-zz", repoId: "autonomy-engine", worktree: "/crew/zz" };
    let seats = [first, seat];
    const pane = cmux();
    pane.workspaces.mockResolvedValue([
      { id: "aa", name: "guido-aa · #1", cwd: first.worktree },
      { id: "eb", name: "guido-eb · #1", cwd: seat.worktree },
      { id: "zz", name: "guido-zz · #1", cwd: later.worktree },
    ]);
    const apps = createCrewApps({
      cmux: pane,
      run: vi.fn(),
      repos: () => [
        { id: "autonomy-engine", commands: CREW_APP_DEFAULTS["autonomy-engine"] ?? [] },
        { id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] },
      ],
      seats: () => seats,
    });
    await apps.start(first.id);
    await apps.start(seat.id);
    seats = [seat, later];
    await apps.tick();
    await apps.start(later.id);
    expect(apps.view().find((app) => app.id === seat.id)?.apps[0]?.url).toBe(
      "http://127.0.0.1:5183",
    );
    expect(apps.view().find((app) => app.id === later.id)?.apps[0]?.url).toBe(
      "http://127.0.0.1:5173",
    );
  });
  it("reads each retained app pane rather than the selected workspace surface", async () => {
    const pane = cmux();
    pane.newPane.mockResolvedValueOnce("backend-pane").mockResolvedValueOnce("frontend-pane");
    pane.readScreen.mockImplementation(async (surface: string) => `${surface} lines`);
    const apps = createCrewApps({
      cmux: pane,
      run: vi.fn(),
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
    });
    await apps.start(seat.id);
    await expect(apps.status(seat.id)).resolves.toBe(
      "App 1 (http://127.0.0.1:5173):\nbackend-pane lines\n\nApp 2 (http://127.0.0.1:5174):\nfrontend-pane lines",
    );
    expect(pane.readScreen).toHaveBeenCalledWith("backend-pane", 40);
    expect(pane.readScreen).toHaveBeenCalledWith("frontend-pane", 40);
  });
  it("restarts a stopped endpoint once in five minutes and stops it when its run ends", async () => {
    let seats = [seat];
    let at = 0;
    const pane = cmux();
    const run = vi.fn();
    const apps = createCrewApps({
      cmux: pane,
      run,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => seats,
      now: () => at,
      probe: vi.fn().mockResolvedValue(false),
    });
    await apps.start(seat.id);
    await apps.tick();
    await apps.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(4);
    at = 5 * 60_000;
    await apps.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(6);
    run.mockClear();
    pane.closePane.mockClear();
    seats = [];
    await apps.tick();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pane.closePane).toHaveBeenCalledTimes(2);
  });
  it("refuses eBull's launchd-owned jobs command", async () => {
    const apps = createCrewApps({
      cmux: cmux(),
      run: vi.fn(),
      repos: () => [
        {
          id: "ebull",
          commands: [{ command: "uv run python -m app.jobs", url: "http://127.0.0.1:$PORT" }],
        },
      ],
      seats: () => [seat],
    });
    await expect(apps.start(seat.id)).rejects.toThrow("eBull jobs");
  });
});
