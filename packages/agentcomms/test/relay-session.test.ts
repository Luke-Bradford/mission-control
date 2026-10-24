import { beforeEach, expect, it } from "vitest";
import { rotate, wrapRoomKey } from "../src/membership.ts";
import type { RelayMessage } from "../src/protocol.ts";
import { createRoomCore, type RoomCore } from "../src/relay-core.ts";
import { createRelaySession, type RelayPeer, roomHttp } from "../src/relay-session.ts";
import { ready } from "../src/sodium.ts";
import { fixture } from "./relay-fixtures.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let core: RoomCore;
let session: ReturnType<typeof createRelaySession>;
let now: number;
beforeEach(async () => {
  f = await fixture();
  now = 1_000_000;
  core = createRoomCore({ room: "test-room", owner: f.a.member, now: () => now });
  const token = core.issueToken(f.a.identity.id);
  core.requestJoin(token, f.b.member);
  core.approve(f.a.identity.id, f.b.identity.id, [await wrapRoomKey(f.key, 0, f.b.member)]);
  session = createRelaySession("test-room", core, () => now);
});
function client() {
  const messages: RelayMessage[] = [];
  let closed = false;
  const peer: RelayPeer = {
    send: (m) => messages.push(m),
    close: () => {
      closed = true;
    },
  };
  session.connect(peer);
  return {
    messages,
    peer,
    send: (m: unknown) => session.receive(peer, JSON.stringify(m)),
    closed: () => closed,
  };
}
async function auth(c: ReturnType<typeof client>, identity = f.a.identity, at = now) {
  const sodium = await ready();
  const hello = {
    t: "hello" as const,
    room: "test-room",
    memberId: identity.id,
    at,
    sig: Buffer.from(
      sodium.crypto_sign_detached(`test-room|${identity.id}|${at}`, identity.sign.privateKey),
    ).toString("base64url"),
  };
  c.send(hello);
  return hello;
}
it("replays gaps in order before live delivery, without duplicate sequences", async () => {
  const a = client();
  await auth(a);
  a.send({ t: "since", seq: 0 });
  a.send({ t: "post", sealed: await f.post(1) });
  const b = client();
  await auth(b, f.b.identity);
  a.send({ t: "post", sealed: await f.post(2) });
  b.send({ t: "since", seq: 0 });
  a.send({ t: "post", sealed: await f.post(3) });
  b.send({ t: "since", seq: 1 });
  expect(b.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([1, 2, 3]);
});
it("rejects invalid signatures, stale hellos and unauthenticated history", async () => {
  const c = client();
  await auth(c, f.a.identity, now - 120_001);
  expect(c.closed()).toBe(true);
  const d = client();
  d.send({ t: "since", seq: 0 });
  expect(d.messages).toEqual([{ t: "refused", reason: "unauthenticated" }]);
  const e = client();
  const hello = await auth(client());
  e.send({ ...hello, sig: Buffer.alloc(64).toString("base64url") });
  expect(e.closed()).toBe(true);
});
it("authenticates agents while preventing human impersonation and owner actions", async () => {
  const a = client();
  await auth(a, f.a.agent);
  a.send({ t: "since", seq: 0 });
  a.send({ t: "post", sealed: await f.post(1) });
  a.send({ t: "remove", memberId: f.b.identity.id, grants: [] });
  a.send({ t: "post", sealed: await f.post(2, f.a.agent) });
  expect(a.messages.filter((m) => m.t === "refused")).toEqual([
    { t: "refused", reason: "wrong-sender" },
    { t: "refused", reason: "Owner only" },
  ]);
  expect(a.messages.filter((m) => m.t === "msg")).toHaveLength(1);
});
it("closes removed peers, distributes grants and refuses stale epochs", async () => {
  const a = client();
  await auth(a);
  a.send({ t: "since", seq: 0 });
  const b = client();
  await auth(b, f.b.identity);
  b.send({ t: "since", seq: 0 });
  const { grants } = await rotate(core.members(), f.b.identity.id, 1);
  a.send({ t: "remove", memberId: f.b.identity.id, grants });
  expect(b.closed()).toBe(true);
  expect(a.messages.filter((m) => m.t === "grants").at(-1)).toEqual({ t: "grants", grants });
  a.send({ t: "post", sealed: await f.post(1) });
  expect(a.messages.at(-1)).toEqual({ t: "refused", reason: "stale-epoch" });
  a.send({ t: "post", sealed: await f.post(2, f.a.identity, 1) });
  expect(b.messages.filter((m) => m.t === "msg")).toEqual([]);
});
it("validates wire shapes and broadcasts presence", async () => {
  const a = client();
  await auth(a);
  for (const bad of [
    { t: "since", seq: -1 },
    { t: "presence", status: "fake" },
    { t: "approve", memberId: "x", grants: [] },
  ])
    a.send(bad);
  session.receive(a.peer, "not json");
  expect(a.messages.filter((m) => m.t === "refused")).toHaveLength(4);
  a.send({ t: "presence", status: "busy" });
  expect(a.messages.at(-1)).toEqual({
    t: "presence",
    map: { [f.a.identity.id]: { status: "busy", seenAt: now } },
  });
});
it("requires signed room provisioning and owner-only token issuance", async () => {
  const hello = await auth(client());
  const storage = { load: () => undefined, save: () => {} };
  const created = roomHttp({
    room: "test-room",
    tokens: false,
    method: "PUT",
    body: { owner: f.a.member, hello },
    storage,
    now: () => now,
  });
  expect(created.status).toBe(201);
  const issued = roomHttp({
    room: "test-room",
    tokens: true,
    method: "POST",
    body: hello,
    core: created.core,
    storage,
    now: () => now,
  });
  expect(issued.status).toBe(200);
  const bob = await auth(client(), f.b.identity);
  expect(
    roomHttp({
      room: "test-room",
      tokens: true,
      method: "POST",
      body: bob,
      core,
      storage,
      now: () => now,
    }).status,
  ).toBe(403);
});

it("keeps delivering when another peer's socket fails during broadcast", async () => {
  const a = client();
  await auth(a);
  a.send({ t: "since", seq: 0 });
  const broken = client();
  await auth(broken, f.b.identity);
  broken.send({ t: "since", seq: 0 });
  const healthy = client();
  await auth(healthy, f.b.identity);
  healthy.send({ t: "since", seq: 0 });
  broken.peer.send = () => {
    throw new Error("Socket closed");
  };
  a.send({ t: "post", sealed: await f.post(1) });
  a.send({ t: "post", sealed: await f.post(2) });
  expect(healthy.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([1, 2]);
});
