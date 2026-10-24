import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createRoomCore, type RoomCore, type RoomState, type RoomStorage } from "./relay-core.ts";
import {
  createRelaySession,
  FRAME_MAX,
  type RelayPeer,
  roomHttp,
  roomRoute,
} from "./relay-session.ts";

export async function startNodeRelay(opts: {
  port: number;
  dataDir: string;
  createSecret?: string;
}): Promise<{ url: string; close(): Promise<void> }> {
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const rooms = new Map<
    string,
    { core: RoomCore; session: ReturnType<typeof createRelaySession> }
  >();
  const storageFor = (room: string): RoomStorage => {
    const path = join(opts.dataDir, `${createHash("sha256").update(room).digest("hex")}.json`);
    return {
      load() {
        try {
          return JSON.parse(readFileSync(path, "utf8")) as RoomState;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      save(state) {
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
        renameSync(temporary, path);
      },
    };
  };
  const load = (room: string) => {
    let found = rooms.get(room);
    if (!found) {
      const storage = storageFor(room);
      const saved = storage.load();
      if (saved) {
        const core = createRoomCore({ room, owner: saved.owner, now: Date.now, storage });
        found = { core, session: createRelaySession(room, core) };
        rooms.set(room, found);
      }
    }
    return found;
  };
  const server = createServer(async (req, res) => {
    const route = roomRoute(new URL(req.url ?? "/", "http://relay").pathname);
    res.setHeader("content-type", "application/json");
    if (!route) {
      res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > FRAME_MAX) {
          res.writeHead(413).end(JSON.stringify({ error: "Body too large" }));
          return;
        }
        chunks.push(chunk);
      }
      const result = roomHttp({
        ...route,
        createSecret: opts.createSecret ?? process.env.AGENTCOMMS_CREATE_SECRET,
        authorization: req.headers.authorization,
        method: req.method ?? "GET",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
        core: load(route.room)?.core,
        storage: storageFor(route.room),
      });
      if (result.core)
        rooms.set(route.room, {
          core: result.core,
          session: createRelaySession(route.room, result.core),
        });
      res.writeHead(result.status).end(JSON.stringify(result.body));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid request or storage failure" }));
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: FRAME_MAX });
  server.on("upgrade", (req, socket, head) => {
    const route = roomRoute(new URL(req.url ?? "/", "http://relay").pathname);
    try {
      const room = route && !route.tokens ? load(route.room) : undefined;
      if (!room) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const peer: RelayPeer = {
          send(message) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
          },
          close() {
            ws.close(1008, "Refused");
          },
        };
        room.session.connect(peer);
        ws.on("message", (data, binary) =>
          room.session.receive(peer, binary ? "" : data.toString()),
        );
        ws.on("close", () => room.session.disconnect(peer));
        ws.on("error", () => {
          room.session.disconnect(peer);
          ws.terminate();
        });
      });
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not bind a port");
  let closing: Promise<void> | undefined;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
