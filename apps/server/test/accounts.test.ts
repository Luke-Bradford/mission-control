import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  script: "",
  mode: "signed",
  calls: [] as string[][],
  envs: [] as NodeJS.ProcessEnv[],
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const realExecFile = original.execFile;
  return {
    ...original,
    execFile: (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
      cb: (...args: unknown[]) => void,
    ) => {
      state.calls.push([file, ...args]);
      state.envs.push(options.env ?? process.env);
      return realExecFile(process.execPath, [state.script, file, state.mode], options, cb);
    },
  };
});

import { readAccountStatus } from "../src/accounts.ts";

const dir = mkdtempSync(join(tmpdir(), "mc-accounts-"));
state.script = join(dir, "fake.cjs");
writeFileSync(
  state.script,
  `
const [provider, mode] = process.argv.slice(2);
if (mode === "timeout") setInterval(() => {}, 1000);
else if (provider === "claude") {
 console.log(mode === "malformed" ? "invalid" : JSON.stringify({
 loggedIn: mode !== "out", email: "fictional-operator", subscriptionType: mode === "plan" ? null : "max",
 accessToken: "secret"
 }));
 process.exitCode = mode === "out" ? 1 : 0;
} else {
 let buf = "";
 process.stdin.on("data", chunk => {
  buf += chunk;
  while (buf.includes("\\n")) {
   const at = buf.indexOf("\\n"); const msg = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
   if (msg.id === 1) console.log(JSON.stringify({id:1,result:{}}));
   if (msg.id === 2) {
    if (msg.method !== "account/read" || msg.params.refreshToken !== false) process.exit(2);
    console.log(JSON.stringify({id:2,result: mode === "malformed" ? {} : {account: mode === "out" ? null : {
     type:"chatgpt", email:"fictional-operator", planType: mode === "plan" ? null : "plus", accessToken:"secret"
    }}}));
   }
  }
 });
}
`,
);
afterEach(() => {
  state.calls = [];
  state.envs = [];
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it.each(["claude", "codex"] as const)(
  "reads %s identity without exposing credentials and refreshes",
  async (vendor) => {
    state.mode = "signed";
    const account = { id: "primary", vendor };
    const first = await readAccountStatus(account, 10);
    expect(first).toMatchObject({
      accountId: "primary",
      provider: vendor,
      status: "logged-in",
      identity: "fictional-operator",
      checkedAt: 10,
      detail: null,
    });
    expect(JSON.stringify(first)).not.toContain("secret");
    state.mode = "out";
    expect(await readAccountStatus(account, 20)).toMatchObject({
      status: "not-logged-in",
      identity: null,
      plan: null,
      checkedAt: 20,
    });
    expect(state.calls).toEqual(
      vendor === "claude"
        ? [
            ["claude", "auth", "status", "--json"],
            ["claude", "auth", "status", "--json"],
          ]
        : [
            ["codex", "app-server"],
            ["codex", "app-server"],
          ],
    );
  },
);
it.each(["claude", "codex"] as const)(
  "keeps unknown plan and failures distinct for %s",
  async (vendor) => {
    state.mode = "plan";
    expect(await readAccountStatus({ id: "primary", vendor }, 10)).toMatchObject({
      status: "logged-in",
      plan: null,
    });
    for (const mode of ["malformed", "timeout"]) {
      state.mode = mode;
      expect(
        await readAccountStatus({ id: "primary", vendor }, 10, {
          timeoutMs: mode === "timeout" ? 100 : 5000,
        }),
      ).toMatchObject({
        status: "unknown",
        identity: null,
        plan: null,
        detail:
          mode === "timeout" ? "CLI status timed out" : "CLI status output was not recognised",
      });
    }
  },
);

it("serves status and fresh checks, guards POSTs, and adds config without invoking a CLI", async () => {
  const { buildApp } = await import("../src/api.ts");
  const { ChangeBus } = await import("../src/bus.ts");
  const { Store } = await import("../src/store.ts");
  const { loadConfig } = await import("../src/config.ts");
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    `operator: { id: operator, timezone: UTC }
accounts: []
repos: []
loops: []
poll: { usage_minutes: 30, github_seconds: 60 }
`,
  );
  const config = loadConfig(configPath);
  const store = new Store(join(dir, "api.sqlite"));
  let now = 10;
  const app = buildApp({
    config,
    configPath,
    store,
    bus: new ChangeBus(),
    now: () => now,
    // GET /api/config reads the gh login: no real gh in a test
    githubGql: async () => {
      throw new Error("no gh in tests");
    },
  });
  try {
    expect((await app.inject("/api/accounts/status")).json()).toEqual([]);
    const added = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { name: "primary", provider: "claude" },
    });
    expect(added.statusCode).toBe(200);
    expect(state.calls).toEqual([]);
    expect(loadConfig(configPath).accounts).toEqual([
      { id: "primary", vendor: "claude", alertAt: 80, stopAt: 100 },
    ]);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/accounts",
      payload: { name: "another", provider: "claude" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toContain("one account per provider");
    expect(state.calls).toEqual([]);
    state.mode = "signed";
    expect((await app.inject("/api/accounts/status")).json()).toMatchObject([
      { status: "logged-in", checkedAt: 10 },
    ]);
    now = 20;
    state.mode = "out";
    const checked = await app.inject({
      method: "POST",
      url: "/api/accounts/primary/check",
      payload: {},
    });
    expect(checked.json()).toMatchObject({
      status: "not-logged-in",
      checkedAt: 20,
      identity: null,
      plan: null,
    });
    const view = (await app.inject("/api/config")).json();
    expect(view.accounts[0]).toMatchObject({
      binding: "machine",
      canCheck: true,
      signInHint: "Sign in with the Claude CLI on this machine.",
    });
    const count = state.calls.length;
    for (const url of ["/api/accounts/primary/check", "/api/accounts"]) {
      expect((await app.inject({ method: "POST", url, payload: "{}" })).statusCode).toBe(415);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            payload: {},
            headers: { origin: "https://foreign.invalid" },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (await app.inject({ method: "POST", url: "/api/accounts/missing/check", payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(state.calls).toHaveLength(count);
  } finally {
    await app.close();
    store.close();
  }
});

it("uses the usage providers' login environments for status", async () => {
  const overrides = [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  for (const key of overrides) vi.stubEnv(key, "inherited-override");
  vi.stubEnv("CODEX_HOME", "/fake-codex-home");
  state.mode = "signed";
  await readAccountStatus({ id: "claude", vendor: "claude" }, 10);
  for (const key of overrides) expect(state.envs[0]?.[key]).toBeUndefined();
  expect(state.envs[0]?.PATH).toBe(process.env.PATH);
  await readAccountStatus({ id: "codex", vendor: "codex" }, 10);
  expect(state.envs[1]).toEqual(process.env);
});

it("shares concurrent status reads, caches for 60 seconds, and Check refreshes one account", async () => {
  const { buildApp } = await import("../src/api.ts");
  const { ChangeBus } = await import("../src/bus.ts");
  const { Store } = await import("../src/store.ts");
  const { loadConfig } = await import("../src/config.ts");
  const configPath = join(dir, "cache-config.yaml");
  writeFileSync(
    configPath,
    `operator: { id: operator, timezone: UTC }
accounts:
  - { id: claude, vendor: claude, alert_at: 80, stop_at: 100 }
  - { id: codex, vendor: codex, alert_at: 80, stop_at: 100 }
repos: []
loops: []
poll: { usage_minutes: 30, github_seconds: 60 }
`,
  );
  const store = new Store(join(dir, "cache.sqlite"));
  let now = 100;
  state.mode = "signed";
  const app = buildApp({
    config: loadConfig(configPath),
    store,
    bus: new ChangeBus(),
    now: () => now,
  });
  try {
    const responses = await Promise.all([
      app.inject("/api/accounts/status"),
      app.inject("/api/accounts/status"),
    ]);
    expect(responses[0].json()).toEqual(responses[1].json());
    expect(state.calls).toEqual([
      ["claude", "auth", "status", "--json"],
      ["codex", "app-server"],
    ]);
    now += 59_999;
    await app.inject("/api/accounts/status");
    expect(state.calls).toHaveLength(2);
    state.mode = "out";
    const checked = await app.inject({
      method: "POST",
      url: "/api/accounts/claude/check",
      payload: {},
    });
    expect(checked.json()).toMatchObject({ status: "not-logged-in", checkedAt: now });
    expect(state.calls).toHaveLength(3);
    expect(state.calls[2]).toEqual(["claude", "auth", "status", "--json"]);
    const cached = (await app.inject("/api/accounts/status")).json();
    expect(cached[0]).toEqual(checked.json());
    expect(state.calls).toHaveLength(3);
    now += 1;
    await app.inject("/api/accounts/status");
    expect(state.calls).toHaveLength(4);
    expect(state.calls[3]).toEqual(["codex", "app-server"]);
    now += 59_999;
    await app.inject("/api/accounts/status");
    expect(state.calls).toHaveLength(5);
    expect(state.calls[4]).toEqual(["claude", "auth", "status", "--json"]);
  } finally {
    await app.close();
    store.close();
  }
});
