import "./temp-home.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ConfigView,
  type Crew,
  OPERATOR_BOOTSTRAP_CAPABILITY_HEADER,
  OPERATOR_BOOTSTRAP_PATH,
  OPERATOR_HEADER,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../src/api.ts";
import { EVIDENCE_FOLDERS, NO_INDEX_MARKER } from "../src/repo/no-index.ts";
import type { CodexModels, ModelDeps } from "../src/runtime/codex-models.ts";
import { fakeModels, MODEL_PAGES } from "./config-codex.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";

skipTestsIf(await blockedHere("crew-run"));

const boot = vi.hoisted(() => ({
  app: null as FastifyInstance | null,
  deps: null as AppDeps | null,
  onStreamCount: null as ((count: number) => void) | null,
  hasViewClients: null as (() => boolean) | null,
  serving: false,
  evidenceLive: false,
  hubOwner: undefined as string | null | undefined,
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
vi.mock("../src/config.ts", async (original) => {
  const real = await original<typeof import("../src/config.ts")>();
  return {
    ...real,
    isPreview: (...args: Parameters<typeof real.isPreview>) =>
      boot.evidenceLive ? false : real.isPreview(...args),
  };
});
vi.mock("../src/preview/repo.ts", async (original) => {
  const real = await original<typeof import("../src/preview/repo.ts")>();
  return {
    ...real,
    resolvePreviewRepo: (...args: Parameters<typeof real.resolvePreviewRepo>) =>
      boot.evidenceLive ? Promise.resolve("mission-control") : real.resolvePreviewRepo(...args),
    resolveHubRepo: (...args: Parameters<typeof real.resolveHubRepo>) =>
      boot.hubOwner === undefined ? real.resolveHubRepo(...args) : Promise.resolve(boot.hubOwner),
  };
});

vi.mock("../src/queue/claim.ts", async (original) => ({
  ...(await original<typeof import("../src/queue/claim.ts")>()),
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
  boot.evidenceLive = false;
  boot.hubOwner = undefined;
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

  it("prints a one-time operator bootstrap URL that signs the HUD in once", async () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      boot.models = preparing.deps;
      boot.expectSupervisorEnabled = false;
      await (await import("../src/main.ts")).main();
      const match = output.mock.calls
        .map(([line]) => String(line))
        .join("")
        .match(/Open Mission Control: http:\/\/127\.0\.0\.1:7431\/\?bootstrap=([^\n]+)/);
      expect(match?.[1]).toBeDefined();
      const capability = decodeURIComponent(match?.[1] ?? "");
      const bootstrap = (given?: string) =>
        boot.app?.inject({
          method: "GET",
          url: OPERATOR_BOOTSTRAP_PATH,
          headers: {
            "sec-fetch-site": "same-origin",
            ...(given === undefined ? {} : { [OPERATOR_BOOTSTRAP_CAPABILITY_HEADER]: given }),
          },
        });

      expect((await bootstrap())?.statusCode).toBe(403);
      expect((await bootstrap("wrong"))?.statusCode).toBe(403);
      const accepted = await bootstrap(capability);
      expect(accepted?.statusCode).toBe(200);
      expect(accepted?.json()).toEqual({ token: boot.deps?.operatorToken });
      expect((await bootstrap(capability))?.statusCode).toBe(403);
      expect(output.mock.calls.map(([line]) => String(line)).join("")).not.toContain(
        boot.deps?.operatorToken ?? "",
      );
    } finally {
      output.mockRestore();
    }
  });

  it("starts the focus-import retry timer, which retries a failed import until it clears, and stops it at shutdown (#2215)", async () => {
    const { INSTRUCTION_FOCUS_RETRY_MS } = await import("../src/instructions/notices.ts");
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      boot.models = preparing.deps;
      boot.expectSupervisorEnabled = false;
      await (await import("../src/main.ts")).main();
      const store = boot.deps?.store;
      if (!store) throw new Error("hub has not started");
      const key = "instruction-focus:claude";
      const open = () => store.notes().some((n) => n.key === key);
      const warn = () =>
        store.raiseNote({
          key,
          kind: "blocked",
          runId: null,
          seatId: "claude",
          repoId: "mission-control",
          text: "Configured focus could not be imported.",
          at: Date.now(),
        });
      const sync = vi.spyOn(store.instructions, "syncFocus");
      // the cause is gone and nobody calls the hub: the interval alone retries and clears the note
      warn();
      expect(open()).toBe(true);
      await vi.advanceTimersByTimeAsync(INSTRUCTION_FOCUS_RETRY_MS);
      expect(sync).toHaveBeenCalled();
      expect(open()).toBe(false);
      // shutdown cancels the interval: another period retries nothing
      const handlers = process
        .listeners("SIGTERM")
        .filter((l) => !(signals.get("SIGTERM") ?? []).includes(l));
      expect(handlers.length).toBeGreaterThan(0);
      for (const h of handlers) (h as (s: string) => void)("SIGTERM");
      // the handler does not return its promise; shutdown has ended once it exits
      for (let i = 0; i < 200 && exit.mock.calls.length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(exit).toHaveBeenCalledWith(0);
      sync.mockClear();
      warn();
      await vi.advanceTimersByTimeAsync(2 * INSTRUCTION_FOCUS_RETRY_MS);
      expect(sync).not.toHaveBeenCalled();
      expect(open()).toBe(true);
    } finally {
      exit.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the live evidence sweep after serving with shutdown hooks registered beforehand", async () => {
    boot.evidenceLive = true;
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await expect((await import("../src/main.ts")).main()).resolves.toBeUndefined();
    expect(boot.serving).toBe(true);
    expect(boot.discoveryStarted).toBe(true);
    await expect(boot.app?.close()).resolves.toBeUndefined();
  });

  const evidenceMarkers = () =>
    EVIDENCE_FOLDERS.map((name) => join(dir, "data", name, NO_INDEX_MARKER));
  const crewMarker = join("/tmp/mc-startup-worktrees", NO_INDEX_MARKER);

  it("keeps Spotlight out of the evidence folders and the crew worktrees folder at start", async () => {
    rmSync(crewMarker, { force: true });
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    expect(evidenceMarkers().map((path) => existsSync(path))).toEqual(
      EVIDENCE_FOLDERS.map(() => true),
    );
    expect(existsSync(crewMarker)).toBe(true);
  });

  it("leaves the crew worktrees folder alone when crew is off", async () => {
    rmSync(crewMarker, { force: true });
    vi.stubEnv("MC_CREW", "0");
    vi.stubEnv("MC_NO_CREW", "1");
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    expect(evidenceMarkers().every((path) => existsSync(path))).toBe(true);
    expect(existsSync(crewMarker)).toBe(false);
  });

  const plantStaleWork = (): string[] => {
    const work = join(dir, "data/pr-evidence-work");
    const leftovers = [join(work, "capture-x"), join(work, "sides/abc")];
    for (const path of leftovers) mkdirSync(path, { recursive: true });
    return leftovers;
  };

  it("clears a dead capture's work folder when the live hub starts", async () => {
    const leftovers = plantStaleWork();
    boot.evidenceLive = true;
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    expect(leftovers.map((path) => existsSync(path))).toEqual([false, false]);
  });

  it("leaves the work folder alone in a preview hub, which never captures", async () => {
    const leftovers = plantStaleWork();
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    expect(leftovers.map((path) => existsSync(path))).toEqual([true, true]);
  });

  it("hands the config file it loaded to the routes that only read it, so the rules read answers", async () => {
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    expect(boot.deps?.configReadPath).toBe(join(dir, "config.yaml"));
    const read = (await get("/api/repos/mission-control/rules")).json<{ rules: object }>();
    expect(Object.keys(read.rules)).toHaveLength(18);
  });

  it("treats every configured repo as foreign when the hub's own repo is not configured", async () => {
    boot.hubOwner = null;
    boot.models = preparing.deps;
    boot.expectSupervisorEnabled = false;
    await (await import("../src/main.ts")).main();
    const { ownsHubFiles } = await import("../src/config.ts");
    const config = boot.deps?.config;
    if (!config) throw new Error("hub has not served");
    expect(config.hubRepo).toBeNull();
    expect(config.repos.map((r) => ownsHubFiles(config, r.id))).toEqual(
      config.repos.map(() => false),
    );
  });

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
