import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  APP_RESTART_MS,
  appCommand,
  CREW_APP_DEFAULTS,
  createCrewApps,
} from "../src/sessions/apps.ts";

const seat = { id: "guido-eb", repoId: "ebull", worktree: "/crew/ebull" };
const cmux = () => ({
  workspaces: vi.fn().mockResolvedValue([{ id: "ws", name: "guido-eb · #1", cwd: "/crew/ebull" }]),
  newPane: vi.fn().mockResolvedValue("pane"),
  closePane: vi.fn().mockResolvedValue(undefined),
  setStatus: vi.fn(),
  readPane: vi.fn().mockResolvedValue("ready"),
});
describe("crew apps", () => {
  it("executes an app command with its assigned eBull environment", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mc-crew-app-command-"));
    mkdirSync(join(cwd, "frontend"));
    try {
      const output = execFileSync(
        "sh",
        [
          "-lc",
          appCommand(
            "ebull",
            'cd frontend && printf "%s|%s|%s" "$PORT" "$BACKEND_PORT" "$VITE_API_PROXY_TARGET"',
            5174,
            5173,
          ),
        ],
        { cwd, encoding: "utf8" },
      );
      expect(output).toBe("5174|5173|http://127.0.0.1:5173");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("adds eBull panes to its seat workspace on distinct ports without jobs", async () => {
    const pane = cmux();
    const apps = createCrewApps({
      cmux: pane,
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
    expect(pane.setStatus).toHaveBeenCalledWith(
      "ws",
      "app-health",
      "http://127.0.0.1:5173 starting · http://127.0.0.1:5174 starting",
    );
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
    pane.readPane.mockImplementation(async (surface: string) => `${surface} lines`);
    const apps = createCrewApps({
      cmux: pane,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
    });
    await apps.start(seat.id);
    await expect(apps.status(seat.id)).resolves.toBe(
      "App 1 (http://127.0.0.1:5173):\nbackend-pane lines\n\nApp 2 (http://127.0.0.1:5174):\nfrontend-pane lines",
    );
    expect(pane.readPane).toHaveBeenCalledWith("backend-pane", 40);
    expect(pane.readPane).toHaveBeenCalledWith("frontend-pane", 40);
  });
  it("keeps an alive but non-answering app pane running and clears both app statuses on stop", async () => {
    let seats = [seat];
    const pane = cmux();
    const apps = createCrewApps({
      cmux: pane,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => seats,
      probe: vi.fn().mockResolvedValue(false),
    });
    await apps.start(seat.id);
    await apps.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(2);
    expect(pane.setStatus).toHaveBeenCalledWith(
      "ws",
      "app-health",
      "http://127.0.0.1:5173 not answering · http://127.0.0.1:5174 not answering",
    );
    pane.closePane.mockClear();
    seats = [];
    await apps.tick();
    expect(pane.closePane).toHaveBeenCalledTimes(2);
    expect(pane.setStatus).toHaveBeenCalledWith("ws", "app", "");
    expect(pane.setStatus).toHaveBeenCalledWith("ws", "app-health", "");
  });
  it("restarts a stopped pane once in five minutes and logs the restart", async () => {
    let at = 0;
    const pane = cmux();
    const log = vi.fn();
    const apps = createCrewApps({
      cmux: pane,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
      now: () => at,
      probe: vi.fn().mockResolvedValue(false),
      log,
    });
    await apps.start(seat.id);
    pane.readPane.mockRejectedValue(new Error("pane is gone"));
    await apps.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(4);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Restarting guido-eb's ebull app panes"),
    );
    at = APP_RESTART_MS - 1;
    await apps.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(4);
  });
  it("adopts persisted panes after the hub restarts instead of opening duplicate ports", async () => {
    const pane = cmux();
    const state = {
      value: null as string | null,
      get: () => state.value,
      set: (value: string) => {
        state.value = value;
      },
    };
    const deps = {
      cmux: pane,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
      state,
    };
    const beforeRestart = createCrewApps(deps);
    await beforeRestart.start(seat.id);
    expect(pane.newPane).toHaveBeenCalledTimes(2);

    const afterRestart = createCrewApps(deps);
    await afterRestart.tick();
    expect(afterRestart.view()[0]?.running).toBe(true);
    expect(pane.newPane).toHaveBeenCalledTimes(2);
  });
  it("keeps the five-minute restart throttle across a hub restart", async () => {
    let at = 0;
    const pane = cmux();
    const state = {
      value: null as string | null,
      get: () => state.value,
      set: (value: string) => {
        state.value = value;
      },
    };
    const deps = {
      cmux: pane,
      repos: () => [{ id: "ebull", commands: CREW_APP_DEFAULTS.ebull ?? [] }],
      seats: () => [seat],
      now: () => at,
      probe: vi.fn().mockResolvedValue(false),
      state,
    };
    const beforeRestart = createCrewApps(deps);
    await beforeRestart.start(seat.id);
    pane.readPane.mockRejectedValue(new Error("pane is gone"));
    at = 1_000;
    await beforeRestart.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(4);

    at = APP_RESTART_MS;
    const afterRestart = createCrewApps(deps);
    await afterRestart.tick();
    expect(pane.newPane).toHaveBeenCalledTimes(4);
  });
  it("refuses eBull's launchd-owned jobs command", async () => {
    const apps = createCrewApps({
      cmux: cmux(),
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
