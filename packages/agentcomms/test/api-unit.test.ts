import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { Daemon } from "../src/daemon.ts";

const server = vi.hoisted(() => ({
  handler: undefined as ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined,
  host: "",
}));
vi.mock("node:http", () => ({
  createServer: (handler: typeof server.handler) => {
    server.handler = handler;
    return {
      once() {},
      off() {},
      listen(_port: number, host: string, callback: () => void) {
        server.host = host;
        callback();
      },
      address: () => ({ port: 7481 }),
      close(callback?: () => void) {
        callback?.();
      },
      closeAllConnections() {},
    };
  },
}));

import { startApi } from "../src/api.ts";

let home: string;
let api: Awaited<ReturnType<typeof startApi>> | undefined;
afterEach(async () => {
  await api?.stop();
  if (home) await rm(home, { recursive: true, force: true });
});
it("authenticates before parsing bodies, binds loopback, and validates sends and cursors", async () => {
  home = await mkdtemp(join(tmpdir(), "comms-api-unit-"));
  const daemon: Daemon = {
    rooms: () => [{ room: "test-room", relay: "ws://unused" }],
    read: vi.fn(() => []),
    presence: () => ({}),
    threads: () => [],
    stop: async () => {},
    send: vi.fn(async () => ({ seq: 1 })),
  };
  api = await startApi({ home, daemon, port: 0 });
  expect(server.host).toBe("127.0.0.1");
  expect((await stat(join(home, "api-token"))).mode & 0o777).toBe(0o600);
  const token = await readFile(join(home, "api-token"), "utf8");
  async function request(method: string, url: string, body = "", auth?: string) {
    const req = Object.assign(Readable.from([Buffer.from(body)]), {
      method,
      url,
      headers: { authorization: auth },
    });
    let status = 0;
    let value: unknown;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(text: string) {
        value = JSON.parse(text);
      },
    };
    await server.handler?.(req as IncomingMessage, res as unknown as ServerResponse);
    return { status, value };
  }
  expect(await request("POST", "/rooms/test-room/messages", "invalid")).toMatchObject({
    status: 401,
  });
  const auth = `Bearer ${token}`;
  expect(await request("GET", "/rooms", "", auth)).toMatchObject({ status: 200 });
  expect(await request("GET", "/rooms/test-room/messages?since=-1", "", auth)).toMatchObject({
    status: 400,
  });
  expect(await request("GET", "/rooms/test-room/messages?since=3", "", auth)).toMatchObject({
    status: 200,
  });
  expect(daemon.read).toHaveBeenCalledWith("test-room", 3);
  expect(
    await request(
      "POST",
      "/rooms/test-room/messages",
      JSON.stringify({ kind: "fyi", body: "hello", auto: true }),
      auth,
    ),
  ).toMatchObject({ status: 400 });
  expect(
    await request(
      "POST",
      "/rooms/test-room/messages",
      JSON.stringify({ kind: "fyi", body: "hello" }),
      auth,
    ),
  ).toEqual({ status: 200, value: { seq: 1 } });
  expect(daemon.send).toHaveBeenCalledWith("test-room", {
    room: "test-room",
    kind: "fyi",
    body: "hello",
    thread: expect.any(String),
  });
  expect(
    await request(
      "POST",
      "/rooms/test-room/messages",
      JSON.stringify({ room: "other", kind: "fyi", body: "hello" }),
      auth,
    ),
  ).toMatchObject({ status: 400 });
  expect(await request("GET", "/rooms/unknown/messages", "", auth)).toMatchObject({ status: 404 });
});
