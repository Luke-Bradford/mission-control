import "./temp-home.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ConfigView, type Crew, OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../src/api.ts";
import type { CodexModels, ModelDeps } from "../src/runtime/codex-models.ts";
import { fakeModels, MODEL_PAGES } from "./config-codex.ts";

const boot = vi.hoisted(() => ({
  app: null as FastifyInstance | null,
  deps: null as AppDeps | null,
  onStreamCount: null as ((count: number) => void) | null,
  hasViewClients: null as (() => boolean) | null,
  serving: false,
  discoveryStarted: false,
  expectSupervisorEnabled: true,
  models: {} as ModelDeps,
  catalog: null as CodexModels | null,
  retryMs: 60_000,
  readGate: null as (() => Promise<Buffer>) | null,
  discoveryComplete: null as (() => void) | null,
  ticket: vi.fn(async () => null),
}));

vi.mock("../src/runtime/codex-models.ts", async (original) => {
  const real = await original<typeof import("../src/runtime/codex-models.ts")>();
  const current = () => {
    if (!boot.catalog) throw new Error("no startup catalog");
    return boot.catalog;
  };
  // Mocked factory imports survive resetModules; every consumer must see this boot's catalog.
  return {
    ...real,
    codexModels: {
      get available() {
        return current().available;
      },
      get reason() {
        return current().reason;
      },
      efforts: (model: string) => current().efforts(model),
      load: async (deps: ModelDeps) => {
        await current().load(deps);
        boot.discoveryComplete?.();
      },
    },
    codexModelsFor: () => current(),
  };
});

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: (...args: Parameters<typeof real.readFile>) =>
      boot.readGate && args[0] === boot.models.authPath ? boot.readGate() : real.readFile(...args),
  };
});
vi.mock("../src/api.ts", async (original) => {
  const real = await original<typeof import("../src/api.ts")>();
  return {
    ...real,
    buildApp: (deps: AppDeps) => {
      boot.deps = deps;
      boot.onStreamCount = deps.onStreamCount ?? null;
      const app = real.buildApp({ ...deps, logger: false });
      boot.app = app;
      // Exercise main's serve/start ordering and real HTTP routes in process; no listening socket.
      vi.spyOn(app, "listen").mockImplementation(async () => {
        expect(boot.discoveryStarted).toBe(false);
        await app.ready();
        boot.serving = true;
        return "http://127.0.0.1:7431";
      });
      return app;
    },
  };
});
vi.mock("../src/runtime/codex-discovery.ts", async (original) => {
  const real = await original<typeof import("../src/runtime/codex-discovery.ts")>();
  return {
    startCodexDiscovery: (deps: Parameters<typeof real.startCodexDiscovery>[0]) => {
      expect(boot.serving).toBe(true);
      if (boot.expectSupervisorEnabled) expect(boot.deps?.supervisor?.status().enabled).toBe(true);
      boot.discoveryStarted = true;
      return real.startCodexDiscovery({
        ...deps,
        models: { ...deps.models, ...boot.models },
        retryMs: boot.retryMs,
      });
    },
  };
});
vi.mock("../src/claim.ts", async (original) => ({
  ...(await original<typeof import("../src/claim.ts")>()),
  readLogin: async () => "operator",
}));
vi.mock("../src/runtime/supervisor.ts", async (original) => {
  const real = await original<typeof import("../src/runtime/supervisor.ts")>();
  return {
    ...real,
    createSupervisor: (deps: Parameters<typeof real.createSupervisor>[0]) =>
      real.createSupervisor({ ...deps, fetchTicket: boot.ticket }),
  };
});
vi.mock("../src/scheduler.ts", async (original) => {
  const real = await original<typeof import("../src/scheduler.ts")>();
  return {
    ...real,
    createScheduler: (deps: Parameters<typeof real.createScheduler>[0]) => {
      boot.hasViewClients = deps.hasViewClients ?? null;
      const scheduler = real.createScheduler(deps);
      vi.spyOn(scheduler, "start").mockImplementation(() => {});
      return scheduler;
    },
  };
});
vi.mock("../src/engine/engine.ts", async (original) => {
  const real = await original<typeof import("../src/engine/engine.ts")>();
  return {
    ...real,
    createEngine: (deps: Parameters<typeof real.createEngine>[0]) => {
      const engine = real.createEngine(deps);
      vi.spyOn(engine, "start").mockImplementation(() => {});
      return engine;
    },
  };
});
vi.mock("../src/flight/watch.ts", async (original) => {
  const real = await original<typeof import("../src/flight/watch.ts")>();
  return {
    ...real,
    createFlightWatch: (deps: Parameters<typeof real.createFlightWatch>[0]) => {
      const watch = real.createFlightWatch(deps);
      vi.spyOn(watch, "start").mockImplementation(() => {});
      return watch;
    },
  };
});

let dir: string;
let signals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;
beforeEach(async () => {
  vi.resetModules();
  boot.catalog = new (await import("../src/runtime/codex-models.ts")).CodexModels();
  boot.app = null;
  boot.deps = null;
  boot.onStreamCount = null;
  boot.hasViewClients = null;
  boot.serving = false;
  boot.discoveryStarted = false;
  boot.expectSupervisorEnabled = true;
  boot.retryMs = 60_000;
  boot.readGate = null;
  boot.discoveryComplete = null;
  boot.ticket.mockClear();
  dir = mkdtempSync(join(tmpdir(), "mc-startup-"));
  const configPath = join(dir, "config.yaml");
  const worktrees = "/tmp/mc-startup-worktrees";
  const checkout = "/tmp/mc-startup-checkout";
  const example = readFileSync(
    resolve(import.meta.dirname, "../../../config.example.yaml"),
    "utf8",
  );
  writeFileSync(
    configPath,
    example.slice(0, example.indexOf("\ncrew:")) +
      `
crew:
  node: ${process.execPath}
  worktrees: ${worktrees}
  sessions:
    - id: mixed
      repo_id: mission-control
      checkout: ${checkout}
      seats:
        - { id: claude, role: GUIDO, account_id: claude-main, model: us.anthropic.claude-sonnet-4-6, area: ["apps/server/**"] }
        - { id: codex, role: INCO, account_id: codex-main, model: gpt-6-astra, effort: ultra, area: ["apps/web/**"] }
`,
  );
  vi.stubEnv("MC_CONFIG", configPath);
  vi.stubEnv("MC_DB", join(dir, "data/mc.sqlite"));
  vi.stubEnv("MC_PORT", "7431");
  vi.stubEnv("MC_CREW", "1");
  vi.stubEnv("MC_NO_CREW", "0");
  signals = new Map(
    ["SIGINT", "SIGTERM"].map((s) => [s as "SIGINT" | "SIGTERM", process.listeners(s)]),
  );
});

afterEach(async () => {
  boot.readGate = null;
  await boot.app?.close();
  boot.deps?.crewReloader?.stop();
  await boot.deps?.supervisor?.stopAll();
  boot.deps?.store.close();
  for (const [signal, before] of signals) {
    for (const listener of process.listeners(signal)) {
      if (!before.includes(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (url: string) => {
  if (!boot.app) throw new Error("hub has not served");
  const response = await boot.app.inject({ url, headers: { host: "127.0.0.1:7431" } });
  expect(response.statusCode).toBe(200);
  return response;
};
const unavailable = async () =>
  (await get("/api/config"))
    .json<ConfigView>()
    .crew?.sessions[0]?.seats.find((s) => s.id === "codex")?.unavailable;

async function claudeCanStart() {
  const config = (await get("/api/config")).json<ConfigView>();
  expect(config.crew?.sessions[0]?.seats.find((s) => s.id === "claude")).toMatchObject({
    model: "us.anthropic.claude-sonnet-4-6",
  });
  // The real supervisor reaches ticket lookup for Claude, before any checkout or CLI is needed.
  await expect(boot.deps?.supervisor?.startRun("claude", 1)).rejects.toMatchObject({
    status: 404,
    message: "unknown issue",
  });
  expect(boot.ticket).toHaveBeenCalled();
  boot.ticket.mockClear();
}

describe("mixed hub startup", () => {
  const preparing = fakeModels();
  it("connects stream counts to scheduler client presence", async () => {
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    if (!boot.onStreamCount || !boot.hasViewClients) throw new Error("missing stream wiring");

    boot.onStreamCount(1);
    expect(boot.hasViewClients()).toBe(true);
    boot.onStreamCount(0);
    expect(boot.hasViewClients()).toBe(false);
  });

  it("serves before discovery filesystem preparation completes", async () => {
    boot.models = preparing.deps;
    let release: (bytes: Buffer) => void = () => {};
    let discovered: () => void = () => {};
    const gate = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    const discovery = new Promise<void>((resolve) => {
      discovered = resolve;
    });
    boot.readGate = () => gate;
    boot.discoveryComplete = discovered;
    try {
      await (await import("../src/main.ts")).main();
      expect(await unavailable()).toContain("discovery pending");
      await claudeCanStart();
      release(Buffer.from('{"fake":"auth"}'));
      await discovery;
      expect(await unavailable()).toBeUndefined();
    } finally {
      release(Buffer.from('{"fake":"auth"}'));
      boot.discoveryComplete = null;
    }
  });
  for (const [name, scenario, reason] of [
    ["missing binary", {}, "could not start"],
    ["missing auth", {}, "could not prepare"],
    ["logged out", { error: true }, "check Codex login"],
    ["hanging", { hang: true }, "timed out"],
    ["malformed", { pages: [{ data: "bad", nextCursor: null }] }, "invalid model/list"],
  ] as const) {
    const fake = fakeModels(scenario);
    it(`serves HTTP and Claude with ${name} Codex`, async () => {
      boot.models =
        name === "missing binary"
          ? { authPath: fake.deps.authPath, command: "/missing/codex", timeoutMs: 500 }
          : { ...fake.deps, timeoutMs: 500 };
      if (name === "missing auth") boot.models.authPath = join(dir, "no-auth.json");
      await (await import("../src/main.ts")).main();
      expect(boot.serving).toBe(true);
      expect(await unavailable()).toMatch(/^unavailable:/);
      await claudeCanStart();
      await expect.poll(unavailable).toContain(reason);
      const crew = (await get("/api/crew")).json<Crew>();
      expect(crew.rows.find((r) => r.id === "codex")?.note).toContain(reason);
      await expect(boot.deps?.supervisor?.startRun("codex", 1)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("unavailable:"),
      });
      expect(boot.ticket).not.toHaveBeenCalled();
      expect(boot.deps?.store.seatSession("codex")).toBeNull();
      const { seatInput } = await import("../src/config.ts");
      const base = boot.deps?.config.crew?.sessions[0]?.seats.map(seatInput) ?? [];
      const saved = await boot.app?.inject({
        method: "POST",
        url: "/api/crew/sessions/mixed/seats",
        headers: { host: "127.0.0.1:7431", [OPERATOR_HEADER]: boot.deps?.operatorToken ?? "" },
        payload: { base, seats: base },
      });
      expect(saved?.statusCode).toBe(400);
    });
  }

  const retryScenario: { error?: boolean; pages?: typeof MODEL_PAGES } = { error: true };
  const retry = fakeModels(retryScenario);
  it("makes Codex available after a successful background retry without restarting", async () => {
    boot.models = retry.deps;
    boot.retryMs = 50;
    await (await import("../src/main.ts")).main();
    await expect.poll(unavailable).toContain("check Codex login");
    await claudeCanStart();
    delete retryScenario.error;
    retryScenario.pages = MODEL_PAGES;
    await expect.poll(unavailable).toBeUndefined();
    await expect(boot.deps?.supervisor?.startRun("codex", 1)).rejects.toMatchObject({
      status: 404,
      message: "unknown issue",
    });
    expect(boot.ticket).toHaveBeenCalled();
    expect(retry.records().filter((r) => r.method === "model/list").length).toBeGreaterThan(
      MODEL_PAGES.length,
    );
  });

  const invalid = fakeModels();
  it("keeps only invalid Codex seats unavailable after discovery, then accepts a live config fix", async () => {
    boot.models = invalid.deps;
    const path = join(dir, "config.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("gpt-6-astra", "gpt-5.6-luna"));
    await (await import("../src/main.ts")).main();
    await expect.poll(unavailable).toContain('does not support effort "ultra"');
    await claudeCanStart();
    writeFileSync(path, readFileSync(path, "utf8").replace("effort: ultra", "effort: high"));
    await boot.deps?.crewReloader?.reload();
    expect(await unavailable()).toBeUndefined();
  });

  const reviewer = fakeModels({ error: true });
  it("keeps an unavailable Codex reviewer's review requirement", async () => {
    boot.models = reviewer.deps;
    const path = join(dir, "config.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("role: INCO", "role: RETRO, mode: scratch")
        .replace(', area: ["apps/web/**"]', ""),
    );
    await (await import("../src/main.ts")).main();
    await expect.poll(unavailable).toContain("check Codex login");
    const { reviewerOf } = await import("../src/engine/engine.ts");
    if (!boot.deps) throw new Error("hub has not served");
    expect(reviewerOf(boot.deps.config, "claude")?.id).toBe("codex");
    await expect(boot.deps.supervisor?.startReview("codex", 1)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("unavailable:"),
    });
  });
});

describe("discovery deadlines", () => {
  for (const exitParent of [false, true]) {
    const fake = fakeModels({ inheritedStdout: true, exitParent, hang: true });
    it(`settles and cleans its process group with inherited stdout (parent exits: ${exitParent})`, async () => {
      const { CodexModels } = await import("../src/runtime/codex-models.ts");
      const models = new CodexModels();
      const start = Date.now();
      await expect(models.load({ ...fake.deps, timeoutMs: 500 })).rejects.toThrow(
        "Codex model/list unavailable",
      );
      expect(Date.now() - start).toBeLessThan(2000);
      const records = fake.records();
      const pid = records.find((r) => r.descendant)?.descendant as number;
      expect(pid).toBeGreaterThan(0);
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      await expect.poll(() => existsSync(records[0]?.home as string)).toBe(false);
    });
  }

  const stalled = fakeModels();
  it("includes filesystem preparation in the deadline and never spawns after a late read", async () => {
    boot.models = stalled.deps;
    let release!: (bytes: Buffer) => void;
    const gate = new Promise<Buffer>((resolve) => {
      release = resolve;
    });
    boot.readGate = () => gate;
    const spawn = vi.fn(() => {
      throw new Error("must not spawn after preparation times out");
    });
    const { CodexModels } = await import("../src/runtime/codex-models.ts");
    const start = Date.now();
    await expect(
      new CodexModels().load({
        ...stalled.deps,
        spawn,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
    release(Buffer.from('{"fake":"auth"}'));
    await gate;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
  });
});
