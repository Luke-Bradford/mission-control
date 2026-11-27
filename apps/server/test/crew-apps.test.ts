import { describe, expect, it, vi } from "vitest";
import { CREW_APP_DEFAULTS, createCrewApps } from "../src/sessions/apps.ts";

const seat = { id: "guido-eb", repoId: "ebull", worktree: "/crew/ebull" };
const cmux = () => ({
  workspaces: vi.fn().mockResolvedValue([{ id: "ws", name: "guido-eb · #1", cwd: "/crew/ebull" }]),
  newPane: vi.fn(),
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
    seats = [];
    await apps.tick();
    expect(run).toHaveBeenCalledWith("sh", expect.any(Array));
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
