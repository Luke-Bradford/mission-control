import "./temp-home.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATOR_HEADER } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppDeps } from "../src/api.ts";

/**
 * A work Mac's hub (docs/runbooks/work-mac.md): a fresh clone started with no config file, a new
 * database and port 7431 as its live port. It writes the sessions-only starter config, comes up on
 * it, lists the cmux workspaces, listens on loopback only, and makes no GitHub write and starts
 * no seat while it runs.
 */

const FAKE_CMUX = fileURLToPath(new URL("./fixtures/fake-cmux.mjs", import.meta.url));
const PORT = 7431;

const seen = vi.hoisted(() => ({
  app: null as FastifyInstance | null,
  deps: null as AppDeps | null,
  listen: [] as unknown[],
  cmuxState: "",
  gh: [] as string[][],
  github: [] as { url: string; method: string; body: string }[],
  seatStarts: [] as string[],
}));

vi.mock("../src/api.ts", async (original) => {
  const real = await original<typeof import("../src/api.ts")>();
  return {
    ...real,
    buildApp: (deps: AppDeps) => {
      seen.deps = deps;
      const app = real.buildApp({ ...deps, logger: false });
      seen.app = app;
      // No socket: record where the hub would listen and serve the routes in process.
      vi.spyOn(app, "listen").mockImplementation((async (opts: unknown) => {
        seen.listen.push(opts);
        await app.ready();
        return `http://127.0.0.1:${PORT}`;
      }) as never);
      return app;
    },
  };
});
// The real cmux client, pointed at the fake cmux and its state file.
vi.mock("../src/runtime/cmux.ts", async (original) => {
  const real = await original<typeof import("../src/runtime/cmux.ts")>();
  return {
    ...real,
    createCmux: (
      command: readonly string[],
      log?: (m: string) => void,
      options?: Parameters<typeof real.createCmux>[2],
    ) =>
      real.createCmux(
        command[0] === real.CMUX_COMMAND
          ? [process.execPath, FAKE_CMUX, "--state", seen.cmuxState]
          : command,
        log,
        { activate: ["/usr/bin/true"], ...options },
      ),
  };
});
vi.mock("../src/mcp/gh.ts", async (original) => {
  const real = await original<typeof import("../src/mcp/gh.ts")>();
  return {
    ...real,
    createGh: () => async (args: string[]) => {
      seen.gh.push(args);
      return { code: 1, stdout: "", stderr: "not in this test" };
    },
  };
});
vi.mock("../src/collectors/github.ts", async (original) => {
  const real = await original<typeof import("../src/collectors/github.ts")>();
  return {
    ...real,
    githubToken: async () => {
      seen.gh.push(["auth", "token"]);
      throw new Error("gh: not signed in");
    },
  };
});
vi.mock("../src/runtime/supervisor.ts", async (original) => {
  const real = await original<typeof import("../src/runtime/supervisor.ts")>();
  return {
    ...real,
    createSupervisor: (deps: Parameters<typeof real.createSupervisor>[0]) => {
      const supervisor = real.createSupervisor(deps);
      const startRun = supervisor.startRun.bind(supervisor);
      vi.spyOn(supervisor, "startRun").mockImplementation((seatId, ...rest) => {
        seen.seatStarts.push(seatId);
        return startRun(seatId, ...rest);
      });
      return supervisor;
    },
  };
});

let dir: string;
let signals: Map<string, ReturnType<typeof process.listeners>>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  vi.resetModules();
  Object.assign(seen, {
    app: null,
    deps: null,
    listen: [],
    gh: [],
    github: [],
    seatStarts: [],
  });
  dir = mkdtempSync(join(tmpdir(), "mc-sessions-only-"));
  seen.cmuxState = join(dir, "cmux-state.json");
  writeFileSync(
    seen.cmuxState,
    JSON.stringify({
      workspaces: [
        { id: "11111111-1111-4111-8111-111111111111", name: "pricing" },
        { id: "22222222-2222-4222-8222-222222222222", name: "billing fix" },
      ],
      sessions: [],
    }),
  );
  // Every request to GitHub is recorded and refused; anything else goes through.
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname.endsWith("github.com")) {
      seen.github.push({
        url,
        method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response("{}", { status: 401 });
    }
    return realFetch(input, init);
  });
  vi.stubEnv("MC_CONFIG", join(dir, "config", "config.yaml"));
  vi.stubEnv("MC_DB", join(dir, "data", "mc.sqlite"));
  vi.stubEnv("MC_PORT", String(PORT));
  vi.stubEnv("MC_LIVE_PORT", String(PORT));
  vi.stubEnv("MC_NO_LOOP_WRITES", "");
  vi.stubEnv("MC_CREW", "");
  signals = new Map(["SIGINT", "SIGTERM"].map((s) => [s, process.listeners(s)]));
});

afterEach(async () => {
  await seen.app?.close();
  seen.deps?.crewReloader?.stop();
  await seen.deps?.supervisor?.stopAll();
  seen.deps?.store.close();
  for (const [signal, before] of signals)
    for (const listener of process.listeners(signal))
      if (!before.includes(listener)) process.removeListener(signal, listener);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A GitHub write: any request that is not a read, or a GraphQL mutation. */
const githubWrites = () =>
  seen.github.filter(
    (r) =>
      !["GET", "HEAD"].includes(r.method) &&
      !(r.url.endsWith("/graphql") && !/\bmutation\b/.test(r.body)),
  );

it("a hub started with no config writes the sessions-only starter, comes up on it on loopback, lists cmux sessions, and neither writes to GitHub nor starts a seat", async () => {
  const configPath = join(dir, "config", "config.yaml");
  expect(existsSync(configPath)).toBe(false);
  await (await import("../src/main.ts")).main();

  // The starter config: no accounts, repositories, loops or crew.
  const { loadConfig } = await import("../src/config.ts");
  const config = loadConfig(configPath);
  expect(config.accounts).toEqual([]);
  expect(config.repos).toEqual([]);
  expect(config.loops).toEqual([]);
  expect(config.crew).toBeUndefined();

  // Loopback only, on the chosen port.
  expect(seen.listen).toEqual([{ host: "127.0.0.1", port: PORT }]);

  const app = seen.app;
  if (!app) throw new Error("hub has not served");
  const token = readFileSync(join(dir, "data", "operator-token"), "utf8").trim();
  const res = await app.inject({
    url: "/api/sessions",
    headers: { host: `127.0.0.1:${PORT}`, [OPERATOR_HEADER]: token },
  });
  expect(res.statusCode).toBe(200);
  expect(
    res
      .json<{ sessions: { name: string }[] }>()
      .sessions.map((s) => s.name)
      .sort(),
  ).toEqual(["billing fix", "pricing"]);

  // Let the hub's start-up work and first timers run.
  await new Promise((r) => setTimeout(r, 2000));
  expect(githubWrites()).toEqual([]);
  expect(seen.gh.filter((args) => args[0] !== "auth")).toEqual([]);
  expect(seen.seatStarts).toEqual([]);
  // No seat or session was opened in cmux either.
  const cmuxLog = existsSync(`${seen.cmuxState}.log`)
    ? readFileSync(`${seen.cmuxState}.log`, "utf8")
    : "";
  expect(cmuxLog).toContain("list-workspaces");
  expect(cmuxLog).not.toContain("new-workspace");
}, 30_000);
