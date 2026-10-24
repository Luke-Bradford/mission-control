import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mcpRequest } from "../src/mcp.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "comms-mcp-unit-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 7, method, params });
it.each([undefined, "", " \n\t"])(
  "refuses a request with reason %j before contacting the API",
  async (reason) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await mcpRequest(
        home,
        request("tools/call", {
          name: "comms_send",
          arguments: { room: "r", kind: "request", body: "Take #506", reason },
        }),
      ),
    ).toMatchObject({
      result: { isError: true, content: [{ text: "a request needs a reason" }] },
    });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("forwards a request with its reason and requestedBy intact", async () => {
  await writeFile(join(home, "api-url"), "http://127.0.0.1:7481");
  await writeFile(join(home, "api-token"), "test-token");
  const fetcher = vi.fn().mockResolvedValue(Response.json({ seq: 1 }));
  vi.stubGlobal("fetch", fetcher);
  const args = {
    room: "r",
    kind: "request",
    body: "Take #506",
    reason: "It is in your lane and blocks my work",
    requestedBy: { kind: "agent", name: "work-comms" },
  };
  expect(
    await mcpRequest(home, request("tools/call", { name: "comms_send", arguments: args })),
  ).toMatchObject({ result: { content: [{ text: '{"seq":1}' }] } });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(args);
});
it("initializes and lists the five tools without opening identity or API files", async () => {
  expect(
    await mcpRequest(home, request("initialize", { protocolVersion: "2024-11-05" })),
  ).toMatchObject({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } } });
  expect(await mcpRequest(home, request("tools/list"))).toMatchObject({
    result: {
      tools: [
        { name: "comms_rooms" },
        { name: "comms_read" },
        { name: "comms_send" },
        { name: "comms_presence" },
        { name: "comms_threads" },
      ],
    },
  });
  expect(
    await mcpRequest(home, { jsonrpc: "2.0", method: "notifications/initialized" }),
  ).toBeUndefined();
});
it("validates JSON-RPC and tool arguments before contacting the API", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await mcpRequest(home, {})).toMatchObject({ error: { code: -32600 } });
  expect(await mcpRequest(home, request("unknown"))).toMatchObject({ error: { code: -32601 } });
  expect(
    await mcpRequest(
      home,
      request("tools/call", { name: "comms_read", arguments: { room: "r", since: -1 } }),
    ),
  ).toMatchObject({ error: { code: -32602 } });
  expect(
    await mcpRequest(
      home,
      request("tools/call", {
        name: "comms_send",
        arguments: { room: "r", kind: "fyi", body: "text", auto: true },
      }),
    ),
  ).toMatchObject({ error: { code: -32602 } });
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses only the bearer token to call loopback and returns actionable held/merged text", async () => {
  await writeFile(join(home, "api-url"), "http://127.0.0.1:7481");
  await writeFile(join(home, "api-token"), "test-token");
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ held: "possible secret" }))
    .mockResolvedValueOnce(Response.json({ merged: "thread-1" }))
    .mockResolvedValueOnce(Response.json([{ seq: 3 }]));
  vi.stubGlobal("fetch", fetcher);
  const call = (name: string, args: unknown) =>
    mcpRequest(home, request("tools/call", { name, arguments: args }));
  expect(await call("comms_send", { room: "r", kind: "fyi", body: "hello" })).toMatchObject({
    result: { content: [{ text: "Held: possible secret" }] },
  });
  expect(await call("comms_send", { room: "r", kind: "question", body: "hello" })).toMatchObject({
    result: { content: [{ text: "Merged: use existing thread thread-1" }] },
  });
  expect(await call("comms_read", { room: "r", since: 2 })).toMatchObject({
    result: { content: [{ text: '[{"seq":3}]' }] },
  });
  expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:7481/rooms/r/messages?since=2");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    headers: { authorization: "Bearer test-token" },
    redirect: "error",
  });
});
it("refuses a non-loopback URL without disclosing the bearer token", async () => {
  await writeFile(join(home, "api-url"), "https://example.invalid");
  await writeFile(join(home, "api-token"), "test-token");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await mcpRequest(home, request("tools/call", { name: "comms_rooms" }))).toMatchObject({
    result: { isError: true },
  });
  expect(fetcher).not.toHaveBeenCalled();
});
