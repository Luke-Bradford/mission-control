import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startApi } from "../src/api.ts";
import { daemonFixture } from "./daemon-fixtures.ts";

let home: string;
let f: Awaited<ReturnType<typeof daemonFixture>> | undefined;
let api: Awaited<ReturnType<typeof startApi>> | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "comms-mcp-"));
});
afterEach(async () => {
  child?.kill();
  child = undefined;
  await api?.stop();
  api = undefined;
  await f?.stop();
  f = undefined;
  await rm(home, { recursive: true, force: true });
});
async function connect() {
  f = await daemonFixture(home);
  api = await startApi({ home: join(home, "a"), daemon: f.aDaemon, port: 0 });
  child = spawn(resolve("packages/agentcomms/bin/agentcomms"), ["mcp"], {
    env: { ...process.env, AGENTCOMMS_HOME: join(home, "a") },
  });
  const replies: {
    id: number;
    result: { tools?: { name: string }[]; content?: { text: string }[] };
  }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => replies.push(JSON.parse(line)));
  let id = 0;
  return async (method: string, params?: unknown) => {
    const requestId = ++id;
    child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    await expect
      .poll(() => replies.find((r) => r.id === requestId), { timeout: 5000 })
      .toBeDefined();
    return replies.find((r) => r.id === requestId)?.result;
  };
}
it("lists exactly the five tools over stdio and initializes MCP", async () => {
  const rpc = await connect();
  expect(await rpc("initialize", { protocolVersion: "2024-11-05" })).toMatchObject({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
  });
  const result = await rpc("tools/list");
  expect(result?.tools?.map((tool) => tool.name)).toEqual([
    "comms_rooms",
    "comms_read",
    "comms_send",
    "comms_presence",
    "comms_threads",
  ]);
});
it("round-trips send/read and reports Held and Merged as actionable text", async () => {
  const rpc = await connect();
  const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
  expect(
    (await call("comms_send", { room: "test-room", kind: "question", body: "Is #506 yours?" }))
      ?.content?.[0].text,
  ).toContain('"seq":1');
  expect((await call("comms_read", { room: "test-room", since: 0 }))?.content?.[0].text).toContain(
    "Is #506 yours?",
  );
  expect(
    (await call("comms_send", { room: "test-room", kind: "question", body: "is   #506 YOURS?" }))
      ?.content?.[0].text,
  ).toMatch(/^Merged:/);
  expect(
    (await call("comms_send", { room: "test-room", kind: "fyi", body: `ghp_${"a".repeat(36)}` }))
      ?.content?.[0].text,
  ).toMatch(/^Held:/);
});
it("binds loopback, protects every route, and writes a 0600 token", async () => {
  await connect();
  expect(api?.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect((await stat(join(home, "a", "api-token"))).mode & 0o777).toBe(0o600);
  for (const path of [
    "/rooms",
    "/rooms/test-room/messages",
    "/rooms/test-room/presence",
    "/rooms/test-room/threads",
  ]) {
    expect((await fetch(`${api?.url}${path}`)).status).toBe(401);
  }
  expect(
    (await fetch(`${api?.url}/rooms/test-room/messages`, { method: "POST", body: "{}" })).status,
  ).toBe(401);
  const token = (await readFile(join(home, "a", "api-token"), "utf8")).trim();
  const headers = { authorization: `Bearer ${token}` };
  expect((await fetch(`${api?.url}/rooms`, { headers })).status).toBe(200);
  expect((await fetch(`${api?.url}/rooms/test-room/messages?since=bad`, { headers })).status).toBe(
    400,
  );
});
