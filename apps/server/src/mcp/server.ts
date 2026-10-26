import {
  type CrewMode,
  MC_MCP_SERVER,
  MCP_PATH,
  MCP_PROTOCOL_VERSIONS,
  TOOL_USE_ID_META,
} from "@mc/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RunIdentity, RunTokens } from "./tokens.ts";

/** `/mcp` bodies carry tool arguments (a commit message, a PR body), so the route lifts the cap. */
export const MCP_BODY_LIMIT = 256 * 1024;

const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;

export interface McToolContext {
  seatId: string;
  runId: string;
  /** The model's tool_use id for this call, when the CLI sent one. */
  toolUseId?: string;
}

export interface McTool {
  name: string;
  description: string;
  inputSchema: object;
  /** The seat modes that are offered (and may call) this tool. */
  modes: readonly CrewMode[];
  /** The modes where the tool shows only to a seat whose role is granted it. */
  grantable?: readonly CrewMode[];
  call(ctx: McToolContext, args: unknown): Promise<{ text: string; isError?: boolean }>;
}

/**
 * The `/mcp` tool calls in flight. A restart lets them finish (`idle`) before the hub exits: a seat
 * keeps working through the restart, and a call cut off would be answered with a connection error
 * for a call that had already run.
 */
export class McpCalls {
  private readonly calls = new Set<Promise<unknown>>();

  /** Counts `p` as in flight until it settles; returns it as it is. */
  track<T>(p: Promise<T>): Promise<T> {
    const done = p.then(
      () => {},
      () => {},
    );
    this.calls.add(done);
    void done.then(() => this.calls.delete(done));
    return p;
  }

  private stopped = false;

  /** The drain has started: a new `tools/call` is refused. */
  get draining(): boolean {
    return this.stopped;
  }

  /** Refuses new calls from now on, and resolves once those in flight have finished. */
  drain(): Promise<void> {
    this.stopped = true;
    return this.idle();
  }

  /** Resolves once no call is in flight (calls that start meanwhile are waited for too). */
  async idle(): Promise<void> {
    while (this.calls.size > 0) await Promise.all([...this.calls]);
  }
}

/** What a seat is told when it calls a tool while the hub drains for a restart. */
export const MCP_RESTARTING_TEXT =
  "Mission Control is restarting: wait about 10 seconds, then call the same tool again with the same arguments.";

export interface McpDeps {
  tokens: RunTokens;
  /** The calls in flight, for a restart to wait on; default: not counted. */
  calls?: McpCalls;
  mcpTools: () => McTool[];
  seatMode: (seatId: string) => CrewMode;
  /** The extra tools a seat's role holds; default: none. */
  seatGrants?: (seatId: string) => readonly string[];
  /** The extra tools this authenticated run holds; default: none. */
  runGrants?: (who: RunIdentity) => readonly string[];
}

const Message = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const CallParams = z.looseObject({
  name: z.string(),
  arguments: z.unknown().optional(),
  _meta: z.looseObject({ [TOOL_USE_ID_META]: z.unknown().optional() }).optional(),
});

const InitParams = z.looseObject({ protocolVersion: z.string().optional() });

/** The 401 text for a token that names no live run (the MCP log keeps 401 bodies: nothing more). */
export const UNKNOWN_RUN = "unknown run";

/** The bearer token of a request, or null. */
export function bearer(req: FastifyRequest): string | null {
  const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
  return m?.[1] ?? null;
}

/**
 * `POST /mcp`: a stateless JSON-RPC 2.0 endpoint (MCP streamable HTTP, JSON replies only). The
 * bearer token names the seat and run; nothing else about a request is trusted.
 */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const { tokens } = deps;
  // one call at a time per run: each call waits for the run's previous one
  const tails = new Map<string, Promise<unknown>>();
  const serialise = <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(runId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    tails.set(runId, tail);
    void tail.then(() => {
      if (tails.get(runId) === tail) tails.delete(runId);
    });
    return next;
  };

  const visible = (who: RunIdentity) => {
    const mode = deps.seatMode(who.seatId);
    const seatGrants = deps.seatGrants?.(who.seatId) ?? [];
    const runGrants = deps.runGrants?.(who) ?? [];
    return deps
      .mcpTools()
      .filter(
        (t) =>
          t.modes.includes(mode) ||
          (t.grantable?.includes(mode) === true && seatGrants.includes(t.name)) ||
          (t.name === "report_plan" && mode === "writer" && runGrants.includes(t.name)),
      );
  };

  const rpcError = (id: string | number | undefined, code: number, message: string) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });

  async function callTool(
    who: RunIdentity,
    id: string | number | undefined,
    params: unknown,
  ): Promise<object> {
    const p = CallParams.safeParse(params);
    if (!p.success) return rpcError(id, JSONRPC_INVALID_PARAMS, "invalid params");
    const tool = visible(who).find((t) => t.name === p.data.name);
    if (tool === undefined) return rpcError(id, JSONRPC_INVALID_PARAMS, "unknown tool");
    const meta = p.data._meta?.[TOOL_USE_ID_META];
    const ctx: McToolContext = {
      seatId: who.seatId,
      runId: who.runId,
      ...(typeof meta === "string" ? { toolUseId: meta } : {}),
    };
    let result: { text: string; isError?: boolean };
    try {
      result = await serialise(who.runId, async () => {
        // the run may have ended while this call waited its turn
        if (!tokens.live(who.tokenHash)) return { text: "unknown run", isError: true };
        return tool.call(ctx, p.data.arguments ?? {});
      });
    } catch (e) {
      app.log.warn(
        { tool: tool.name, err: e instanceof Error ? e.name : "unknown" },
        "mc tool threw",
      );
      result = { text: "the tool failed", isError: true };
    }
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      },
    };
  }

  async function handle(who: RunIdentity, msg: z.infer<typeof Message>): Promise<object> {
    const { id } = msg;
    switch (msg.method) {
      case "initialize": {
        const asked = InitParams.safeParse(msg.params);
        const version = MCP_PROTOCOL_VERSIONS.find(
          (v) => asked.success && v === asked.data.protocolVersion,
        );
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion: version ?? MCP_PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: MC_MCP_SERVER, version: "1" },
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            tools: visible(who).map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        if (deps.calls?.draining) {
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: { content: [{ type: "text", text: MCP_RESTARTING_TEXT }], isError: true },
          };
        }
        const call = callTool(who, id, msg.params);
        return deps.calls === undefined ? call : deps.calls.track(call);
      }
      default:
        // includes `server/discover`, which makes the CLI fall back to `initialize`
        return rpcError(id, JSONRPC_METHOD_NOT_FOUND, "method not found");
    }
  }

  const unauthorised = (reply: FastifyReply) => reply.code(401).send({ error: UNKNOWN_RUN });

  app.post(
    MCP_PATH,
    {
      bodyLimit: MCP_BODY_LIMIT,
      // before the body is parsed: an unknown caller is refused without being read
      onRequest: async (req, reply) => {
        if (tokens.resolve(bearer(req)) === null) return unauthorised(reply);
      },
    },
    async (req, reply) => {
      const who = tokens.resolve(bearer(req));
      if (who === null) return unauthorised(reply); // revoked while the body was in flight
      const msg = Message.safeParse(req.body);
      if (!msg.success) return reply.code(400).send({ error: "not a JSON-RPC 2.0 request" });
      // a message without an id is a notification: accepted, no body
      if (msg.data.id === undefined) return reply.code(202).send();
      return reply.type("application/json").send(await handle(who, msg.data));
    },
  );

  // no server-initiated stream: the CLI probes with GET and falls back on 405
  app.get(MCP_PATH, async (_req, reply) =>
    reply.code(405).header("allow", "POST").send({ error: "method not allowed" }),
  );
}
