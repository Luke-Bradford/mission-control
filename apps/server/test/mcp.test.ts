import "./temp-home.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CrewMode } from "@mc/core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { McpCalls, type McTool, type McToolContext, registerMcp } from "../src/mcp/server.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let app: FastifyInstance;
let tokens: RunTokens;
let token: string;
let calls: { ctx: McToolContext; args: unknown }[];
let events: string[];
let gate: Promise<void>;
let logs: string[];
let modes: Record<string, CrewMode>;

const tools = (): McTool[] => [
  {
    name: "echo",
    description: "reads",
    inputSchema: { type: "object" },
    modes: ["writer", "read-only"],
    call: async (ctx, args) => {
      calls.push({ ctx, args });
      return { text: `echo ${JSON.stringify(args)}` };
    },
  },
  {
    name: "commit",
    description: "writes",
    inputSchema: { type: "object" },
    modes: ["writer"],
    call: async () => {
      events.push("commit ran");
      return { text: "committed" };
    },
  },
  {
    name: "slow",
    description: "waits on the gate",
    inputSchema: { type: "object" },
    modes: ["writer", "read-only"],
    call: async (_ctx, args) => {
      const n = (args as { n: number }).n;
      events.push(`start ${n}`);
      if (n === 1) await gate;
      events.push(`end ${n}`);
      return { text: `slow ${n}` };
    },
  },
  {
    name: "bad",
    description: "fails",
    inputSchema: { type: "object" },
    modes: ["writer", "read-only"],
    call: async () => ({ text: "no good", isError: true }),
  },
  {
    name: "boom",
    description: "throws",
    inputSchema: { type: "object" },
    modes: ["writer", "read-only"],
    call: async () => {
      throw new TypeError(`secret ${token} stderr: hunter2`);
    },
  },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-mcp-"));
  store = new Store(join(dir, "mc.sqlite"));
  const config: CcConfig = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [],
    repos: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  tokens = new RunTokens();
  token = tokens.issue("seat-1", "run-1");
  calls = [];
  events = [];
  gate = Promise.resolve();
  logs = [];
  modes = { "seat-1": "writer", "seat-2": "read-only" };
  app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    logger: { stream: { write: (m: string) => void logs.push(m) } },
    tokens,
    mcpTools: tools,
    seatMode: (id) => modes[id] ?? "read-only",
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const rpc = (body: unknown, tok: string | null = token, extra: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(tok === null ? {} : { authorization: `Bearer ${tok}` }),
      ...extra,
    },
    payload: JSON.stringify(body),
  });

const msg = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

describe("a grantable tool", () => {
  const probe: McTool = {
    name: "probe",
    description: "granted",
    inputSchema: { type: "object" },
    modes: [],
    grantable: ["read-only"],
    call: async () => ({ text: "probed" }),
  };
  const build = async (grants?: string[]) => {
    const a = buildApp({
      config: {
        operator: { id: "operator", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
      tokens,
      mcpTools: () => [probe],
      seatMode: (id) => modes[id] ?? "read-only",
      ...(grants === undefined ? {} : { seatGrants: () => grants }),
    });
    await a.ready();
    return a;
  };
  const call = (a: FastifyInstance, tok: string, method: string, params?: unknown) =>
    a
      .inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
        payload: JSON.stringify(msg(1, method, params)),
      })
      .then((r) => r.json());

  it("shows only when granted", async () => {
    const reader = tokens.issue("seat-2", "run-2");
    // not granted: no seatGrants at all
    const plain = await build();
    try {
      expect((await call(plain, reader, "tools/list")).result.tools).toEqual([]);
      expect((await call(plain, reader, "tools/call", { name: "probe" })).error.message).toBe(
        "unknown tool",
      );
    } finally {
      await plain.close();
    }
    const granted = await build(["probe"]);
    try {
      expect(
        (await call(granted, reader, "tools/list")).result.tools.map(
          (t: { name: string }) => t.name,
        ),
      ).toEqual(["probe"]);
      expect(
        (await call(granted, reader, "tools/call", { name: "probe" })).result.content[0].text,
      ).toBe("probed");
      // the writer seat never sees it, granted or not
      expect((await call(granted, token, "tools/list")).result.tools).toEqual([]);
    } finally {
      await granted.close();
    }
  });
});

describe("RunTokens", () => {
  it("issues 32 random bytes as hex, resolves them, and revokes by run", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens.issue("seat-1", "run-1")).not.toBe(token);
    expect(tokens.resolve(token)).toEqual({
      seatId: "seat-1",
      runId: "run-1",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    });
    expect(tokens.resolve("0".repeat(64))).toBeNull();
    expect(tokens.resolve("")).toBeNull();
    tokens.revoke("run-1");
    expect(tokens.resolve(token)).toBeNull();
  });

  it("adopts an earlier hub's token for a run, and nothing that is not 64 hex characters", () => {
    const t = "a".repeat(64);
    expect(tokens.adopt("seat-1", "run-9", t)).toBe(true);
    expect(tokens.resolve(t)).toEqual({
      seatId: "seat-1",
      runId: "run-9",
      tokenHash: createHash("sha256").update(t).digest("hex"),
    });
    for (const bad of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(64)}\n`]) {
      expect(tokens.adopt("seat-1", "run-8", bad)).toBe(false);
      expect(tokens.resolve(bad)).toBeNull();
    }
    tokens.revoke("run-9");
    expect(tokens.resolve(t)).toBeNull();
  });
});

describe("handshake", () => {
  it("answers server/discover with -32601 so the CLI falls back", async () => {
    const r = await rpc(msg(1, "server/discover", { protocolVersion: "2026-07-28" }));
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.json()).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32601 } });
  });

  it.each(["2025-11-25", "2025-06-18"])("echoes protocol version %s", async (v) => {
    const r = await rpc(msg(2, "initialize", { protocolVersion: v, capabilities: {} }));
    expect(r.json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        protocolVersion: v,
        capabilities: { tools: {} },
        serverInfo: { name: "mc", version: "1" },
      },
    });
  });

  it("answers the newest supported version to an unknown one", async () => {
    const r = await rpc(msg(3, "initialize", { protocolVersion: "2099-01-01" }));
    expect(r.json().result.protocolVersion).toBe("2025-11-25");
    const bare = await rpc(msg(4, "initialize"));
    expect(bare.json().result.protocolVersion).toBe("2025-11-25");
  });

  it("accepts notifications/initialized with 202 and no body", async () => {
    const r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r.statusCode).toBe(202);
    expect(r.body).toBe("");
  });

  it("answers ping and an unknown method", async () => {
    expect((await rpc(msg(5, "ping"))).json()).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    const r = await rpc(msg(6, "resources/list"));
    expect(r.json()).toMatchObject({ id: 6, error: { code: -32601 } });
  });

  it("answers GET /mcp with 405", async () => {
    const r = await app.inject({ method: "GET", url: "/mcp" });
    expect(r.statusCode).toBe(405);
  });
});

describe("tools/list", () => {
  it("lists every tool to a writer seat", async () => {
    const r = await rpc(msg(1, "tools/list"));
    const names = r.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["echo", "commit", "slow", "bad", "boom"]);
    expect(r.json().result.tools[0]).toEqual({
      name: "echo",
      description: "reads",
      inputSchema: { type: "object" },
    });
  });

  it("hides writer tools from a read-only seat, and refuses their calls", async () => {
    const ro = tokens.issue("seat-2", "run-2");
    const r = await rpc(msg(1, "tools/list"), ro);
    const names = r.json().result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("commit");
    expect(names).toContain("echo");
    const c = await rpc(msg(2, "tools/call", { name: "commit", arguments: {} }), ro);
    expect(c.json()).toMatchObject({ id: 2, error: { code: -32602 } });
  });

  it("a scratch seat sees only scratch tools", async () => {
    const fake = (name: string, offered: readonly CrewMode[]): McTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      modes: offered,
      call: async () => ({ text: name }),
    });
    const scratchApp = buildApp({
      config: {
        operator: { id: "operator", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
      tokens,
      mcpTools: () => [
        fake("writes", ["writer"]),
        fake("reads", ["writer", "read-only"]),
        fake("findings", ["scratch"]),
      ],
      seatMode: () => "scratch",
    });
    await scratchApp.ready();
    try {
      const post = (body: unknown) =>
        scratchApp.inject({
          method: "POST",
          url: "/mcp",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          payload: JSON.stringify(body),
        });
      const r = await post(msg(1, "tools/list"));
      expect(r.json().result.tools.map((t: { name: string }) => t.name)).toEqual(["findings"]);
      const c = await post(msg(2, "tools/call", { name: "writes", arguments: {} }));
      expect(c.json()).toMatchObject({ id: 2, error: { code: -32602, message: "unknown tool" } });
    } finally {
      await scratchApp.close();
    }
  });
});

describe("tools/call", () => {
  it("reaches the tool with the seat, run, tool_use id and arguments", async () => {
    const r = await rpc(
      msg(1, "tools/call", {
        name: "echo",
        arguments: { a: 1 },
        _meta: { "claudecode/toolUseId": "toolu_123" },
      }),
    );
    expect(r.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: 'echo {"a":1}' }] },
    });
    expect(calls).toEqual([
      { ctx: { seatId: "seat-1", runId: "run-1", toolUseId: "toolu_123" }, args: { a: 1 } },
    ]);
  });

  it("leaves toolUseId off when the CLI sent none", async () => {
    await rpc(msg(1, "tools/call", { name: "echo" }));
    expect(calls[0]?.ctx).toEqual({ seatId: "seat-1", runId: "run-1" });
    expect(calls[0]?.args).toEqual({});
  });

  it("returns a tool's error as an isError result, and a throw with fixed text", async () => {
    const bad = await rpc(msg(1, "tools/call", { name: "bad", arguments: {} }));
    expect(bad.json().result).toEqual({
      content: [{ type: "text", text: "no good" }],
      isError: true,
    });
    const boom = await rpc(msg(2, "tools/call", { name: "boom", arguments: {} }));
    expect(boom.json().result).toEqual({
      content: [{ type: "text", text: "the tool failed" }],
      isError: true,
    });
    expect(boom.body).not.toContain(token);
  });

  it("refuses malformed params and an unknown tool as JSON-RPC errors", async () => {
    const a = await rpc(msg(1, "tools/call", { arguments: {} }));
    expect(a.json()).toMatchObject({ error: { code: -32602 } });
    const b = await rpc(msg(2, "tools/call", { name: "nope" }));
    expect(b.json()).toMatchObject({ error: { code: -32602 } });
  });

  it("runs two concurrent calls of one run in order", async () => {
    let open!: () => void;
    gate = new Promise((res) => {
      open = res;
    });
    const first = rpc(msg(1, "tools/call", { name: "slow", arguments: { n: 1 } }));
    const second = rpc(msg(2, "tools/call", { name: "slow", arguments: { n: 2 } }));
    await new Promise((res) => setTimeout(res, 50));
    expect(events).toEqual(["start 1"]);
    open();
    await Promise.all([first, second]);
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("skips a call queued behind a run that is revoked meanwhile", async () => {
    let open!: () => void;
    gate = new Promise((res) => {
      open = res;
    });
    const first = rpc(msg(1, "tools/call", { name: "slow", arguments: { n: 1 } }));
    const second = rpc(msg(2, "tools/call", { name: "commit", arguments: {} }));
    await new Promise((res) => setTimeout(res, 50));
    tokens.revoke("run-1");
    open();
    await first;
    const r = await second;
    expect(events).not.toContain("commit ran");
    expect(r.json().result.isError).toBe(true);
    expect(r.body).not.toContain(token);
  });

  it("skips a call whose own token was revoked even when the run resumed with a new one", async () => {
    let open!: () => void;
    gate = new Promise((res) => {
      open = res;
    });
    const first = rpc(msg(1, "tools/call", { name: "slow", arguments: { n: 1 } }));
    const second = rpc(msg(2, "tools/call", { name: "commit", arguments: {} }));
    await new Promise((res) => setTimeout(res, 50));
    tokens.revoke("run-1");
    tokens.issue("seat-1", "run-1"); // the resumed process
    open();
    await first;
    const r = await second;
    expect(events).not.toContain("commit ran");
    expect(r.json().result.isError).toBe(true);
  });

  it("does not make another run wait", async () => {
    let open!: () => void;
    gate = new Promise((res) => {
      open = res;
    });
    const other = tokens.issue("seat-2", "run-2");
    const first = rpc(msg(1, "tools/call", { name: "slow", arguments: { n: 1 } }));
    await new Promise((res) => setTimeout(res, 20));
    const second = await rpc(msg(2, "tools/call", { name: "slow", arguments: { n: 2 } }), other);
    expect(second.json().result.content[0].text).toBe("slow 2");
    open();
    await first;
  });

  it("accepts a 200 KiB call", async () => {
    const big = "x".repeat(200 * 1024);
    const r = await rpc(msg(1, "tools/call", { name: "echo", arguments: { big } }));
    expect(r.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses a body over 256 KiB", async () => {
    const big = "x".repeat(260 * 1024);
    const r = await rpc(msg(1, "tools/call", { name: "echo", arguments: { big } }));
    expect(r.statusCode).toBe(413);
  });
});

describe("auth and bad bodies", () => {
  it("answers 401 unknown run for no token, a wrong one and a revoked one", async () => {
    for (const tok of [null, "f".repeat(64), "garbage"]) {
      const r = await rpc(msg(1, "tools/list"), tok);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "unknown run" });
    }
    tokens.revoke("run-1");
    const r = await rpc(msg(1, "tools/list"));
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "unknown run" });
    expect(r.body).not.toContain(token);
  });

  it.each([
    ["a notification", { jsonrpc: "2.0", method: "notifications/initialized" }],
    ["an unknown method", msg(1, "resources/list")],
  ])("answers 401 to %s without a valid token", async (_n, body) => {
    for (const tok of [null, "f".repeat(64)]) {
      const r = await rpc(body, tok);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "unknown run" });
    }
    tokens.revoke("run-1");
    expect((await rpc(body)).statusCode).toBe(401);
  });

  it("refuses a non-Bearer scheme", async () => {
    const r = await rpc(msg(1, "tools/list"), null, { authorization: `Basic ${token}` });
    expect(r.statusCode).toBe(401);
  });

  it.each([
    ["not json", "{nope"],
    ["an array batch", JSON.stringify([msg(1, "ping")])],
    ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
    ["a wrong version", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" })],
    ["a string", JSON.stringify("ping")],
  ])("answers 400 to %s", async (_n, payload) => {
    const r = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      payload,
    });
    expect(r.statusCode).toBe(400);
  });

  it("leaves the token out of every response and log line", async () => {
    const bodies: string[] = [];
    bodies.push((await rpc(msg(1, "initialize", { protocolVersion: "2025-11-25" }))).body);
    bodies.push((await rpc(msg(2, "tools/list"))).body);
    bodies.push((await rpc(msg(3, "tools/call", { name: "boom" }))).body);
    bodies.push((await rpc(msg(4, "bogus"))).body);
    bodies.push((await rpc(msg(5, "ping"), "wrong")).body);
    for (const b of bodies) expect(b).not.toContain(token);
    const text = logs.join("");
    expect(text).toContain("mc tool threw"); // the throw was logged, and the logs were captured
    expect(text).toContain("TypeError");
    expect(text).not.toContain(token);
    expect(text).not.toContain("hunter2");
  });
});

describe("McpCalls", () => {
  /** Whether `p` has settled, after the microtasks and a turn of the loop have run. */
  const settled = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    return done;
  };
  const later = () => {
    let resolve: () => void = () => {};
    let reject: (e: Error) => void = () => {};
    const p = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { p, resolve, reject };
  };

  it("is idle at once when nothing is in flight", async () => {
    expect(await settled(new McpCalls().idle())).toBe(true);
  });

  it("stays pending while a tracked call is, including one tracked after idle() was called", async () => {
    const calls = new McpCalls();
    const a = later();
    const b = later();
    calls.track(a.p);
    const idle = calls.idle();
    expect(await settled(idle)).toBe(false);
    calls.track(b.p); // a call that starts while the restart waits is waited for too
    a.resolve();
    expect(await settled(idle)).toBe(false);
    b.resolve();
    expect(await settled(idle)).toBe(true);
  });

  it("counts a call that rejects as finished, and returns the promise it was given", async () => {
    const calls = new McpCalls();
    const a = later();
    const tracked = calls.track(a.p);
    expect(tracked).toBe(a.p);
    const idle = calls.idle();
    a.reject(new Error("tool failed"));
    await expect(tracked).rejects.toThrow("tool failed");
    expect(await settled(idle)).toBe(true);
  });

  it("a tools/call is in flight until its tool answers", async () => {
    const mcpCalls = new McpCalls();
    const gateOpen = later();
    const a = buildApp({
      config: {
        operator: { id: "o", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
      tokens,
      mcpCalls,
      mcpTools: () => [
        {
          name: "hold",
          description: "waits",
          inputSchema: { type: "object" },
          modes: ["writer"],
          call: async () => {
            await gateOpen.p;
            return { text: "done" };
          },
        },
      ],
      seatMode: () => "writer",
    });
    await a.ready();
    try {
      const reply = a.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        payload: JSON.stringify(msg(1, "tools/call", { name: "hold", arguments: {} })),
      });
      await new Promise((r) => setTimeout(r, 50)); // the request has reached its tool
      const idle = mcpCalls.idle();
      expect(await settled(idle)).toBe(false);
      gateOpen.resolve();
      const r = await reply;
      expect(JSON.parse(r.body).result.content[0].text).toBe("done");
      expect(await settled(idle)).toBe(true);
    } finally {
      await a.close();
    }
  });
});

describe("route table", () => {
  it("registers exactly POST and GET /mcp", async () => {
    const bare = Fastify();
    const seen: string[] = [];
    bare.addHook("onRoute", (r) => {
      for (const m of [r.method].flat()) if (m !== "HEAD") seen.push(`${m} ${r.url}`);
    });
    registerMcp(bare, { tokens, mcpTools: tools, seatMode: () => "writer" });
    await bare.ready();
    expect(new Set(seen)).toEqual(new Set(["POST /mcp", "GET /mcp"]));
    await bare.close();
  });

  it("is not served when buildApp has no tokens", async () => {
    const a = buildApp({
      config: {
        operator: { id: "o", timezone: "Europe/London" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
    });
    const r = await a.inject({ method: "GET", url: "/mcp" });
    expect(r.statusCode).toBe(404);
    await a.close();
  });
});
