import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import type { Daemon } from "./daemon.ts";
import { knowledgeSchema } from "./envelope.ts";
import { writePrivate } from "./local-files.ts";
import { FRAME_MAX } from "./relay-session.ts";

export const sendSchema = z.strictObject({
  room: z.string().min(1).optional(),
  kind: z.enum(["question", "answer", "fyi", "request", "decision"]),
  body: z.string(),
  thread: z.string().min(1).optional(),
  inReplyTo: z.string().optional(),
  refs: z.array(z.string()).optional(),
  knowledge: knowledgeSchema.optional(),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  replyBy: z.string().optional(),
  needsHuman: z.boolean().optional(),
  reason: z.string().optional(),
  requestedBy: z.strictObject({ kind: z.enum(["human", "agent"]), name: z.string() }).optional(),
});

export async function startApi(opts: { home: string; daemon: Daemon; port?: number }) {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/rooms") {
        reply(200, opts.daemon.rooms());
        return;
      }
      const match = /^\/rooms\/([^/]+)\/(messages|presence|threads)$/.exec(url.pathname);
      if (!match) {
        reply(404, { error: "Not found" });
        return;
      }
      const room = decodeURIComponent(match[1]);
      if (!opts.daemon.rooms().some((entry) => entry.room === room)) {
        reply(404, { error: "Unknown room" });
        return;
      }
      if (req.method === "GET") {
        if (match[2] === "presence") reply(200, opts.daemon.presence(room));
        else if (match[2] === "threads") reply(200, opts.daemon.threads(room));
        else {
          const since = Number(url.searchParams.get("since") ?? "0");
          if (!Number.isSafeInteger(since) || since < 0) {
            reply(400, { error: "Invalid since" });
            return;
          }
          const limit = Number(url.searchParams.get("limit") ?? "50");
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
            reply(400, { error: "Invalid limit" });
            return;
          }
          reply(200, opts.daemon.read(room, since, limit));
        }
        return;
      }
      if (req.method !== "POST" || match[2] !== "messages") {
        reply(405, { error: "Method not allowed" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > FRAME_MAX) {
          reply(413, { error: "Body too large" });
          return;
        }
        chunks.push(chunk);
      }
      const parsed = sendSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (parsed.room !== undefined && parsed.room !== room) {
        reply(400, { error: "Room mismatch" });
        return;
      }
      reply(
        200,
        await opts.daemon.send(room, { ...parsed, room, thread: parsed.thread ?? randomUUID() }),
      );
    } catch (error) {
      reply(400, {
        error:
          error instanceof z.ZodError
            ? "Invalid message"
            : error instanceof Error
              ? error.message
              : "Invalid request",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API did not bind a port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await writePrivate(join(opts.home, "api-token"), token);
    await writePrivate(join(opts.home, "api-url"), url);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
