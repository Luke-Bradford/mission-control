import { describe, expect, it, vi } from "vitest";
import { createCrewApps } from "../src/sessions/apps.ts";

describe("crew apps", () => {
  it("starts every configured command in one repo workspace with distinct ports", async () => {
    const cmux = { ensure: vi.fn(), workspaces: vi.fn().mockResolvedValue([]), newWorkspace: vi.fn().mockResolvedValue("app-workspace"), newPane: vi.fn(), setStatus: vi.fn(), close: vi.fn() };
    const run = vi.fn().mockResolvedValue("abc123");
    const apps = createCrewApps({
      cmux,
      run,
      repos: () => [{ id: "studio", checkout: "/crew/studio", commands: [{ command: "pnpm dev", url: "http://127.0.0.1:$PORT" }, { command: "pnpm api", url: "http://127.0.0.1:$PORT" }] }],
      root: "/crew/apps",
      now: () => 0,
    });

    await apps.start("studio");

    expect(cmux.newWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "studio · app" }));
    expect(cmux.newPane).toHaveBeenCalledTimes(1);
    expect(cmux.setStatus).toHaveBeenCalledWith("app-workspace", "app", "http://127.0.0.1:5173");
    expect(run).toHaveBeenCalledWith("git", expect.arrayContaining(["fetch", "origin", "main"]));
    expect(cmux.newPane).toHaveBeenCalledWith("app-workspace", "/crew/apps/studio", "PORT=5174 pnpm api");
  });

  it("does not restart a stopped app more than once in five minutes", async () => {
    let at = 0;
    const cmux = { ensure: vi.fn(), workspaces: vi.fn().mockResolvedValue([]), newWorkspace: vi.fn().mockResolvedValue("app-workspace"), newPane: vi.fn(), setStatus: vi.fn(), close: vi.fn() };
    const apps = createCrewApps({
      cmux,
      run: vi.fn().mockResolvedValue("abc123"),
      repos: () => [{ id: "ebull", checkout: "/crew/ebull", commands: [{ command: "frontend", url: "http://127.0.0.1:$PORT" }] }],
      root: "/crew/apps",
      now: () => at,
      probe: vi.fn().mockResolvedValue(false),
    });
    await apps.start("ebull");
    await apps.tick();
    await apps.tick();
    expect(cmux.newWorkspace).toHaveBeenCalledTimes(2);
    at = 5 * 60_000;
    await apps.tick();
    expect(cmux.newWorkspace).toHaveBeenCalledTimes(3);
  });

  it("restarts an app when origin/main changes", async () => {
    const cmux = { ensure: vi.fn(), workspaces: vi.fn().mockResolvedValue([]), newWorkspace: vi.fn().mockResolvedValue("app-workspace"), newPane: vi.fn(), setStatus: vi.fn(), close: vi.fn() };
    let main = "before";
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.includes("rev-parse") ? main : "",
    );
    const apps = createCrewApps({
      cmux,
      run,
      repos: () => [{ id: "studio", checkout: "/crew/studio", commands: [{ command: "pnpm dev", url: "http://127.0.0.1:$PORT" }] }],
      root: "/crew/apps",
      probe: vi.fn().mockResolvedValue(true),
    });
    await apps.start("studio");
    main = "after";
    await apps.tick();
    expect(cmux.newWorkspace).toHaveBeenCalledTimes(2);
  });

  it("never adds an eBull jobs command", () => {
    expect(() => createCrewApps({
      cmux: {} as never,
      run: vi.fn(),
      repos: () => [{ id: "ebull", checkout: "/crew/ebull", commands: [{ command: "uv run python -m app.jobs", url: "http://127.0.0.1:$PORT" }] }],
      root: "/crew/apps",
    })).toThrow("eBull jobs");
  });
});
