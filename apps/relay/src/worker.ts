/// <reference types="@cloudflare/workers-types" />
import type { RoomCore } from "../../../packages/agentcomms/src/relay-core.ts";
import type {
  createRelaySession,
  PeerState,
  RelayPeer,
} from "../../../packages/agentcomms/src/relay-session.ts";
import { createDOStorage } from "./storage.ts";

type Env = { ROOMS: DurableObjectNamespace; AGENTCOMMS_CREATE_SECRET?: string };

export class RoomDO {
  private createSecret?: string;
  private storage?: ReturnType<typeof createDOStorage>;
  private core?: RoomCore;
  private session?: ReturnType<typeof createRelaySession>;
  private room?: string;
  private ctx: DurableObjectState;
  private initPromise?: Promise<void>;
  private peers = new Map<WebSocket, RelayPeer>();

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.createSecret = _env.AGENTCOMMS_CREATE_SECRET;
  }

  private init(): Promise<void> {
    this.initPromise ??= (async () => {
      // Sodium initialization needs an event context for its secure random source.
      const { createRelaySession } = await import(
        "../../../packages/agentcomms/src/relay-session.ts"
      );
      const { createRoomCore } = await import("../../../packages/agentcomms/src/relay-core.ts");
      this.storage = createDOStorage(this.ctx.storage);
      const saved = this.storage.load();
      if (saved) {
        this.room = saved.room;
        this.core = createRoomCore({
          room: saved.room,
          owner: saved.owner,
          now: Date.now,
          storage: this.storage,
        });
        this.session = createRelaySession(saved.room, this.core, Date.now, true);
        for (const socket of this.ctx.getWebSockets()) {
          const state = socket.deserializeAttachment() as PeerState | null;
          if (state) this.session.restore(this.peer(socket), state);
          else socket.close(1008, "Missing session");
        }
      }
    })().catch((error) => {
      this.initPromise = undefined;
      console.error("Relay room initialization or migration failed", error);
      throw error;
    });
    return this.initPromise;
  }

  private peer(socket: WebSocket): RelayPeer {
    let peer = this.peers.get(socket);
    if (!peer) {
      peer = {
        send: (message) => socket.send(JSON.stringify(message)),
        close: () => {
          this.peers.delete(socket);
          socket.close(1008, "Refused");
        },
        save: (state) => socket.serializeAttachment(state),
      };
      this.peers.set(socket, peer);
    }
    return peer;
  }

  private async scheduleExpiry(): Promise<void> {
    let deadline = Number.POSITIVE_INFINITY;
    for (const socket of this.peers.keys()) {
      const state = socket.deserializeAttachment() as PeerState;
      if (!state.id) deadline = Math.min(deadline, state.deadline);
    }
    if (Number.isFinite(deadline)) await this.ctx.storage.setAlarm(deadline);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    await this.init();
    this.session?.expire();
    await this.scheduleExpiry();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.init();
    const peer = this.peers.get(socket);
    const wasAuthenticated = (socket.deserializeAttachment() as PeerState | null)?.id;
    if (peer) this.session?.receive(peer, typeof message === "string" ? message : "");
    if (!wasAuthenticated && (socket.deserializeAttachment() as PeerState | null)?.id)
      await this.scheduleExpiry();
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string): Promise<void> {
    await this.init();
    const peer = this.peers.get(socket);
    if (peer) this.session?.disconnect(peer);
    this.peers.delete(socket);
    await this.scheduleExpiry();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket, 1011, "Socket error");
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    if (!this.storage) throw new Error("Room storage unavailable");
    const { createRelaySession, FRAME_MAX, roomHttp, roomRoute } = await import(
      "../../../packages/agentcomms/src/relay-session.ts"
    );
    const route = roomRoute(new URL(request.url).pathname);
    if (!route) return new Response("Not found", { status: 404 });
    if (this.room && this.room !== route.room) return new Response("Wrong room", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (route.tokens || !this.session) return new Response("Unknown room", { status: 404 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      this.session.connect(this.peer(server));
      await this.scheduleExpiry();
      return new Response(null, { status: 101, webSocket: client });
    }
    try {
      const reader = request.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > FRAME_MAX) {
            await reader.cancel();
            return new Response("Body too large", { status: 413 });
          }
          chunks.push(result.value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const body = JSON.parse(new TextDecoder().decode(bytes) || "null");
      const result = roomHttp({
        ...route,
        createSecret: this.createSecret,
        authorization: request.headers.get("authorization") ?? undefined,
        method: request.method,
        body,
        core: this.core,
        storage: this.storage,
      });
      if (result.core) {
        this.room = route.room;
        this.core = result.core;
        this.session = createRelaySession(route.room, result.core, Date.now, true);
      }
      return Response.json(result.body, { status: result.status });
    } catch {
      return Response.json({ error: "Invalid request or storage failure" }, { status: 400 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/rooms\/([^/]+)(?:\/tokens)?$/.exec(new URL(request.url).pathname);
    if (!match) return new Response("Not found", { status: 404 });
    let room: string;
    try {
      room = decodeURIComponent(match[1]);
    } catch {
      return new Response("Invalid room", { status: 400 });
    }
    if (!room || room.includes("|") || room.length > 200)
      return new Response("Invalid room", { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
