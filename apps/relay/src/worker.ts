import type { RoomCore } from "../../../packages/agentcomms/src/relay-core.ts";
import type {
  createRelaySession,
  RelayPeer,
} from "../../../packages/agentcomms/src/relay-session.ts";
import { createDOStorage } from "./storage.ts";

type Env = { ROOMS: DurableObjectNamespace; AGENTCOMMS_CREATE_SECRET?: string };

export class RoomDO {
  private createSecret?: string;
  private storage: ReturnType<typeof createDOStorage>;
  private core?: RoomCore;
  private session?: ReturnType<typeof createRelaySession>;
  private room?: string;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.createSecret = _env.AGENTCOMMS_CREATE_SECRET;
    this.storage = createDOStorage(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    // Sodium initialization needs a request context for its secure random source.
    const { createRelaySession, FRAME_MAX, roomHttp, roomRoute } = await import(
      "../../../packages/agentcomms/src/relay-session.ts"
    );
    const { createRoomCore } = await import("../../../packages/agentcomms/src/relay-core.ts");
    const route = roomRoute(new URL(request.url).pathname);
    if (!route) return new Response("Not found", { status: 404 });
    if (!this.core) {
      const saved = this.storage.load();
      if (saved) {
        this.room = saved.room;
        this.core = createRoomCore({
          room: saved.room,
          owner: saved.owner,
          now: Date.now,
          storage: this.storage,
        });
        this.session = createRelaySession(saved.room, this.core);
      }
    }
    if (this.room && this.room !== route.room) return new Response("Wrong room", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (route.tokens || !this.session) return new Response("Unknown room", { status: 404 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      const session = this.session;
      const peer: RelayPeer = {
        send: (message) => server.send(JSON.stringify(message)),
        close: () => server.close(1008, "Refused"),
      };
      session.connect(peer);
      server.addEventListener("message", (event) => {
        session.receive(peer, typeof event.data === "string" ? event.data : "");
      });
      server.addEventListener("close", () => {
        session.disconnect(peer);
        server.close();
      });
      server.addEventListener("error", () => {
        session.disconnect(peer);
        server.close(1011, "Socket error");
      });
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
        this.session = createRelaySession(route.room, result.core);
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
