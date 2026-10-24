import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { controlPayload, sign, signDirectory } from "../src/auth.ts";
import type { Identity } from "../src/keys.ts";
import { unwrapRoomKey } from "../src/membership.ts";
import { type ClientMessage, type RelayMessage, relayMessageSchema } from "../src/protocol.ts";
import { makeHello } from "../src/relay-client.ts";
import { startNodeRelay } from "../src/relay-node.ts";
import { fixture } from "./relay-fixtures.ts";

let dir: string;
let relay: Awaited<ReturnType<typeof startNodeRelay>>;
let f: Awaited<ReturnType<typeof fixture>>;
let clients: Client[];
class Client {
  socket: WebSocket;
  messages: RelayMessage[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(`${url}/rooms/test-room`);
    this.socket.on("message", (raw) =>
      this.messages.push(relayMessageSchema.parse(JSON.parse(raw.toString()))),
    );
  }
  send(message: ClientMessage) {
    this.socket.send(JSON.stringify(message));
  }
  async wait(t: RelayMessage["t"], count = 1) {
    await expect
      .poll(() => this.messages.filter((m) => m.t === t).length)
      .toBeGreaterThanOrEqual(count);
    return this.messages.filter((m) => m.t === t);
  }
  async disconnect() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}
async function hello(identity = f.a.identity, challenge = "invalid") {
  return makeHello("test-room", identity, challenge);
}
function challenge(c: Client): string {
  const msg = c.messages.find((m) => m.t === "challenge");
  if (msg?.t !== "challenge") throw new Error("Missing challenge");
  return msg.challenge;
}
function change(
  t: "approve" | "remove",
  grants: Awaited<ReturnType<typeof f.grants>>,
  owner = f.a.identity,
) {
  const directory = signDirectory(
    "test-room",
    t === "remove" ? 1 : 0,
    t === "remove" ? 2 : 1,
    t === "remove" ? [f.a.member] : [f.a.member, f.b.member],
    f.a.identity,
  );
  const payload = { memberId: f.b.identity.id, grants, directory };
  return { t, ...payload, sig: sign(controlPayload(t, "test-room", payload), owner) };
}
function tokenRequest() {
  const payload = {
    memberId: f.a.identity.id,
    at: Date.now(),
    nonce: randomBytes(32).toString("base64url"),
  };
  return { ...payload, sig: sign(controlPayload("token", "test-room", payload), f.a.identity) };
}
function creation() {
  const payload = { owner: f.a.member, directory: f.directory };
  return { ...payload, sig: sign(controlPayload("create", "test-room", payload), f.a.identity) };
}
async function connect(identity?: Identity, since = 0) {
  const c = new Client(relay.url);
  clients.push(c);
  await once(c.socket, "open");
  await c.wait("challenge");
  if (identity) {
    c.send(await hello(identity, challenge(c)));
    await c.wait("grants");
    c.send({ t: "since", seq: since });
  }
  return c;
}
async function joinBob() {
  const res = await fetch(`${relay.url.replace("ws:", "http:")}/rooms/test-room/tokens`, {
    method: "POST",
    body: JSON.stringify(tokenRequest()),
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  const b = await connect();
  b.send({ t: "join", token, member: f.b.member });
  await b.wait("grants");
  const a = await connect(f.a.identity);
  a.send(change("approve", await f.grants(f.key, 0, f.b.member)));
  await a.wait("grants", 2);
  b.send(await hello(f.b.identity, challenge(b)));
  await b.wait("grants", 2);
  b.send({ t: "since", seq: 0 });
  return { a, b };
}
beforeEach(async () => {
  clients = [];
  f = await fixture();
  dir = await mkdtemp(join(tmpdir(), "agentcomms-relay-"));
  relay = await startNodeRelay({ createSecret: "test-secret", port: 0, dataDir: dir });
  const response = await fetch(`${relay.url.replace("ws:", "http:")}/rooms/test-room`, {
    method: "PUT",
    headers: { authorization: "Bearer test-secret" },
    body: JSON.stringify(creation()),
  });
  expect(response.status).toBe(201);
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.disconnect()));
  await relay?.close();
  await rm(dir, { recursive: true, force: true });
});
it("broadcasts seq 1 and resumes exactly seq 2 and 3 across disconnect and relay restart", async () => {
  const { a, b } = await joinBob();
  a.send({ t: "post", sealed: await f.post(1) });
  expect((await b.wait("msg"))[0]).toMatchObject({ seq: 1 });
  await b.disconnect();
  for (const id of [2, 3]) a.send({ t: "post", sealed: await f.post(id) });
  await a.wait("msg", 3);
  const resumed = await connect(f.b.identity, 1);
  resumed.send({ t: "since", seq: 1 });
  await resumed.wait("msg", 2);
  resumed.send({ t: "presence", status: "online" });
  await resumed.wait("presence", 2);
  expect(resumed.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([2, 3]);
  await relay.close();
  relay = await startNodeRelay({ createSecret: "test-secret", port: 0, dataDir: dir });
  const restarted = await connect(f.b.identity, 1);
  restarted.send({ t: "since", seq: 1 });
  await restarted.wait("msg", 2);
  const poster = await connect(f.a.identity);
  poster.send({ t: "post", sealed: await f.post(4) });
  await restarted.wait("msg", 3);
  expect(restarted.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([2, 3, 4]);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const stored = await readFile(join(dir, files[0]), "utf8");
  expect(stored).not.toContain("Message 1");
  expect(stored).not.toContain("privateKey");
});
it.each(["signature", "stale", "future", "room"])(
  "refuses and closes an invalid hello (%s)",
  async (kind) => {
    const c = await connect();
    const auth = await hello(
      f.a.identity,
      kind === "stale" || kind === "future" ? "anotherChallenge" : challenge(c),
    );
    if (kind === "signature") auth.sig = Buffer.alloc(64).toString("base64url");
    if (kind === "room") auth.room = "other-room";
    const closed = once(c.socket, "close");
    c.send(auth);
    await closed;
    expect(c.messages.at(-1)).toMatchObject({ t: "refused" });
  },
);
it("requires authentication for history and rejects malformed frames", async () => {
  const c = await connect();
  c.send({ t: "since", seq: 0 });
  expect((await c.wait("refused"))[0]).toMatchObject({ reason: "unauthenticated" });
  const other = await connect(f.a.identity);
  other.socket.send("not json");
  expect((await other.wait("refused"))[0]).toMatchObject({ reason: "invalid-message" });
});
it("allows delegated agent connections but denies owner actions and sender impersonation", async () => {
  const { a } = await joinBob();
  const agent = await connect(f.a.agent);
  agent.send(change("approve", [], f.a.agent));
  expect((await agent.wait("refused"))[0]).toMatchObject({
    reason: "Invalid owner control signature",
  });
  agent.send({ t: "post", sealed: await f.post(1) });
  expect((await agent.wait("refused", 2))[1]).toMatchObject({ reason: "wrong-sender" });
  agent.send({ t: "post", sealed: await f.post(2, f.a.agent) });
  expect((await a.wait("msg"))[0]).toMatchObject({ seq: 1 });
});
it("revokes connected members and sends rotated grants to remaining clients", async () => {
  const { a, b } = await joinBob();
  const rotation = await f.rotate([f.a.member, f.b.member], f.b.identity.id, 1);
  const closed = once(b.socket, "close");
  a.send(change("remove", rotation.grants));
  await closed;
  await a.wait("grants", 3);
  a.send({ t: "post", sealed: await f.post(1, f.a.identity, 1) });
  await a.wait("msg");
  expect(b.messages.filter((m) => m.t === "msg")).toEqual([]);
  expect(a.messages.filter((m) => m.t === "grants").at(-1)).toMatchObject({
    grants: rotation.grants.filter((g) => g.memberId === f.a.identity.id),
  });
});
it("does not overwrite an existing room or accept unsigned provisioning", async () => {
  const url = relay.url.replace("ws:", "http:");
  const existing = await fetch(`${url}/rooms/test-room`, {
    method: "PUT",
    headers: { authorization: "Bearer test-secret" },
    body: JSON.stringify(creation()),
  });
  expect(existing.status).toBe(409);
  const invalid = await hello();
  invalid.sig = "invalid";
  const token = await fetch(`${url}/rooms/test-room/tokens`, {
    method: "POST",
    body: JSON.stringify(invalid),
  });
  expect(token.status).toBe(403);
});

it("restores agent-addressed grants and the authenticated directory over Node sockets", async () => {
  await joinBob();
  await relay.close();
  relay = await startNodeRelay({ createSecret: "test-secret", port: 0, dataDir: dir });
  for (const identity of [f.b.identity, f.b.agent]) {
    const client = await connect(identity);
    const directory = client.messages.find((m) => m.t === "directory");
    expect(directory).toMatchObject({ members: [f.a.member, f.b.member], keyEpoch: 0 });
    const message = client.messages.find((m) => m.t === "grants");
    if (message?.t !== "grants") throw new Error("Missing grants");
    expect(message.grants.map((g) => g.memberId)).toEqual([identity.id]);
    expect(await unwrapRoomKey(message.grants[0], identity)).toEqual(f.key);
  }
});
