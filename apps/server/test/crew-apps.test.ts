import { describe, expect, it, vi } from "vitest";
import { CREW_APP_DEFAULTS, createCrewApps } from "../src/sessions/apps.ts";

describe("crew apps", () => {
  it("starts every configured command in one repo workspace with distinct ports", async () => {
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn().mockResolvedValue([]),
      newWorkspace: vi.fn().mockResolvedValue("app-workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    const run = vi.fn().mockResolvedValue("abc123");
    const apps = createCrewApps({
      cmux,
      run,
      repos: () => [
        {
          id: "studio",
          checkout: "/crew/studio",
          commands: [
            { command: "pnpm dev", url: "http://127.0.0.1:$PORT" },
            { command: "pnpm api", url: "http://127.0.0.1:$PORT" },
          ],
        },
      ],
      root: "/crew/apps",
      now: () => 0,
    });

    await apps.start("studio");

    expect(cmux.newWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "studio · app" }),
    );
    expect(cmux.newPane).toHaveBeenCalledTimes(1);
    expect(cmux.setStatus).toHaveBeenCalledWith("app-workspace", "app", "http://127.0.0.1:5173");
    expect(run).toHaveBeenCalledWith("git", expect.arrayContaining(["fetch", "origin", "main"]));
    expect(cmux.newPane).toHaveBeenCalledWith(
      "app-workspace",
      "/crew/apps/studio",
      "PORT=5174 pnpm api",
    );
  });

  it("renders the real app defaults with separate loopback ports and eBull's backend proxy", async () => {
    const autonomy = CREW_APP_DEFAULTS["autonomy-engine"];
    const ebull = CREW_APP_DEFAULTS.ebull;
    if (!autonomy || !ebull) throw new Error("Crew app defaults are missing.");
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn(),
      newWorkspace: vi.fn().mockResolvedValue("workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    const apps = createCrewApps({
      cmux,
      run: vi.fn().mockResolvedValue("main"),
      repos: () => [
        { id: "autonomy-engine", checkout: "/crew/autonomy", commands: autonomy },
        { id: "ebull", checkout: "/crew/ebull", commands: ebull },
      ],
      root: "/crew/apps",
    });

    await apps.start("autonomy-engine");
    await apps.start("ebull");

    expect(cmux.newWorkspace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command:
          "PORT=5173 cd studio && pnpm install --frozen-lockfile && pnpm dev -- --host 127.0.0.1 --port 5173",
      }),
    );
    expect(cmux.newWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command:
          "PORT=5174 BACKEND_PORT=5174 uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 5174",
      }),
    );
    expect(cmux.newPane).toHaveBeenCalledWith(
      "workspace",
      "/crew/apps/ebull",
      "PORT=5175 BACKEND_PORT=5174 cd frontend && VITE_API_PROXY_TARGET=http://127.0.0.1:5174 pnpm dev -- --host 127.0.0.1 --port 5175",
    );
    expect(apps.view()).toEqual([
      expect.objectContaining({ apps: [{ url: "http://127.0.0.1:5173", answers: null }] }),
      expect.objectContaining({
        apps: [
          { url: "http://127.0.0.1:5174", answers: null },
          { url: "http://127.0.0.1:5175", answers: null },
        ],
      }),
    ]);
  });

  it("refreshes an existing private worktree instead of trying to add it again after a hub restart", async () => {
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn(),
      newWorkspace: vi.fn().mockResolvedValue("workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    const run = vi.fn().mockResolvedValue("main");
    const deps = {
      cmux,
      run,
      repos: () => [
        {
          id: "studio",
          checkout: "/crew/studio",
          commands: [{ command: "pnpm dev", url: "http://127.0.0.1:$PORT" }],
        },
      ],
      root: "/crew/apps",
      worktreeExists: () => true,
    };

    await createCrewApps(deps).start("studio");
    await createCrewApps(deps).start("studio");

    expect(run).not.toHaveBeenCalledWith("git", expect.arrayContaining(["worktree", "add"]));
    expect(run).toHaveBeenCalledWith("git", [
      "-C",
      "/crew/apps/studio",
      "reset",
      "--hard",
      "origin/main",
    ]);
    expect(run).toHaveBeenCalledWith("git", ["-C", "/crew/apps/studio", "clean", "-fdx"]);
  });

  it("does not restart a stopped app more than once in five minutes", async () => {
    let at = 0;
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn().mockResolvedValue([]),
      newWorkspace: vi.fn().mockResolvedValue("app-workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    const apps = createCrewApps({
      cmux,
      run: vi.fn().mockResolvedValue("abc123"),
      repos: () => [
        {
          id: "ebull",
          checkout: "/crew/ebull",
          commands: [{ command: "frontend", url: "http://127.0.0.1:$PORT" }],
        },
      ],
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

  it("uses the production loopback probe: an answering app stays up and a failed endpoint is throttled", async () => {
    let at = 0;
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn(),
      newWorkspace: vi.fn().mockResolvedValue("workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    try {
      const apps = createCrewApps({
        cmux,
        run: vi.fn().mockResolvedValue("main"),
        repos: () => [
          {
            id: "studio",
            checkout: "/crew/studio",
            commands: [{ command: "pnpm dev", url: "http://127.0.0.1:$PORT" }],
          },
        ],
        root: "/crew/apps",
        now: () => at,
      });
      await apps.start("studio");
      await apps.tick();
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:5173", expect.anything());
      expect(cmux.newWorkspace).toHaveBeenCalledTimes(1);

      fetch.mockRejectedValue(new Error("refused"));
      await apps.tick();
      await apps.tick();
      expect(cmux.newWorkspace).toHaveBeenCalledTimes(2);
      at = 5 * 60_000;
      await apps.tick();
      expect(cmux.newWorkspace).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restarts an app when origin/main changes", async () => {
    const cmux = {
      ensure: vi.fn(),
      workspaces: vi.fn().mockResolvedValue([]),
      newWorkspace: vi.fn().mockResolvedValue("app-workspace"),
      newPane: vi.fn(),
      setStatus: vi.fn(),
      close: vi.fn(),
    };
    let main = "before";
    const run = vi.fn(async (_command: string, args: string[]) =>
      args.includes("rev-parse") ? main : "",
    );
    const apps = createCrewApps({
      cmux,
      run,
      repos: () => [
        {
          id: "studio",
          checkout: "/crew/studio",
          commands: [{ command: "pnpm dev", url: "http://127.0.0.1:$PORT" }],
        },
      ],
      root: "/crew/apps",
      probe: vi.fn().mockResolvedValue(true),
    });
    await apps.start("studio");
    main = "after";
    await apps.tick();
    expect(cmux.newWorkspace).toHaveBeenCalledTimes(2);
  });

  it("never adds an eBull jobs command", () => {
    expect(() =>
      createCrewApps({
        cmux: {} as never,
        run: vi.fn(),
        repos: () => [
          {
            id: "ebull",
            checkout: "/crew/ebull",
            commands: [{ command: "uv run python -m app.jobs", url: "http://127.0.0.1:$PORT" }],
          },
        ],
        root: "/crew/apps",
      }),
    ).toThrow("eBull jobs");
  });
});
