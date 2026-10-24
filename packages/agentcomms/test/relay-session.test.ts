import { beforeEach, expect, it, vi } from "vitest";
import { controlPayload, sign, signDirectory } from "../src/auth.ts";
import type { RelayMessage } from "../src/protocol.ts";
import { makeHello } from "../src/relay-client.ts";
import { createRoomCore, type RoomCore } from "../src/relay-core.ts";
import { createRelaySession, type RelayPeer, roomHttp } from "../src/relay-session.ts";
import { fixture } from "./relay-fixtures.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let core: RoomCore;
let session: ReturnType<typeof createRelaySession>;
let now: number;
beforeEach(async () => {
  f = await fixture();
  now = 1_000_000;
  core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
  });
  const token = core.issueToken(f.a.identity.id);
  core.requestJoin(token, f.b.member);
  core.approve(
    f.a.identity.id,
    f.b.identity.id,
    await f.grants(f.key, 0, f.b.member),
    f.nextDirectory(core),
  );
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
  const challenge = c.messages.find((m) => m.t === "challenge");
  if (challenge?.t !== "challenge") throw new Error("Missing challenge");
  const hello = await makeHello("test-room", identity, at === now ? challenge.challenge : "stale");
  c.send(hello);
  return hello;
}
function change(
  t: "approve" | "remove",
  memberId: string,
  grants: Awaited<ReturnType<typeof f.grants>>,
  owner = f.a.identity,
) {
  const payload = {
    memberId,
    grants,
    directory: f.nextDirectory(core, t === "remove" ? memberId : undefined),
  };
  return { t, ...payload, sig: sign(controlPayload(t, "test-room", payload), owner) };
}
it("sends the public directory only after authentication and addresses grants to the hello identity", async () => {
  const anonymous = client();
  expect(anonymous.messages).toEqual([expect.objectContaining({ t: "challenge" })]);
  for (const identity of [f.b.identity, f.b.agent]) {
    const peer = client();
    await auth(peer, identity);
    expect(peer.messages.find((m) => m.t === "directory")).toMatchObject({
      members: [f.a.member, f.b.member],
      keyEpoch: 0,
      activeMemberIds: [f.a.identity.id, f.b.identity.id],
    });
    expect(peer.messages.find((m) => m.t === "grants")).toEqual({
      t: "grants",
      grants: core.grantsFor(identity.id),
    });
    expect(core.grantsFor(identity.id)[0].memberId).toBe(identity.id);
    expect(peer.messages.some((m) => m.t === "pending")).toBe(false);
  }
  const owner = client();
  await auth(owner);
  expect(owner.messages).toContainEqual({ t: "pending", members: [] });
});
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
  expect(d.messages.at(-1)).toEqual({ t: "refused", reason: "unauthenticated" });
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
  a.send(change("remove", f.b.identity.id, [], f.a.agent));
  a.send({ t: "post", sealed: await f.post(2, f.a.agent) });
  expect(a.messages.filter((m) => m.t === "refused")).toEqual([
    { t: "refused", reason: "wrong-sender" },
    { t: "refused", reason: "Invalid owner control signature" },
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
  const { grants } = await f.rotate(core.members(), f.b.identity.id, 1);
  a.send(change("remove", f.b.identity.id, grants));
  expect(b.closed()).toBe(true);
  expect(a.messages.filter((m) => m.t === "grants").at(-1)).toEqual({
    t: "grants",
    grants: grants.filter((g) => g.memberId === f.a.identity.id),
  });
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
  const creation = {
    owner: f.a.member,
    directory: signDirectory("test-room", 0, 0, [f.a.member], f.a.identity),
  };
  const tokenPayload = { memberId: f.a.identity.id, nonce: "nonce", at: now };
  const tokenRequest = {
    ...tokenPayload,
    sig: sign(controlPayload("token", "test-room", tokenPayload), f.a.identity),
  };
  const storage = { load: () => undefined, save: () => {} };
  const created = roomHttp({
    room: "test-room",
    tokens: false,
    method: "PUT",
    body: { ...creation, sig: sign(controlPayload("create", "test-room", creation), f.a.identity) },
    createSecret: "secret",
    authorization: "Bearer secret",
    storage,
    now: () => now,
  });
  expect(created.status).toBe(201);
  const issued = roomHttp({
    room: "test-room",
    tokens: true,
    method: "POST",
    body: tokenRequest,
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

it("W1: challenges cannot be replayed on another socket or used twice", async () => {
  const first = client();
  const hello = await auth(first);
  const other = client();
  other.send(hello);
  expect(other.closed()).toBe(true);
  first.send(hello);
  expect(first.closed()).toBe(true);
});
it("W1: owner control signatures bind every grant and the directory", async () => {
  const owner = client();
  await auth(owner);
  const rotation = await f.rotate(core.members(), f.b.member.id, 1);
  const removal = change("remove", f.b.member.id, rotation.grants);
  removal.grants[0].wrapped = "tampered";
  owner.send(removal);
  expect(owner.messages.at(-1)).toMatchObject({
    t: "refused",
    reason: "Invalid owner control signature",
  });
  expect(core.members()).toHaveLength(2);
});
it("W1/W3: provisioning requires an operator secret; signed token requests are single-use", () => {
  const storage = { load: () => undefined, save() {} };
  const payload = { owner: f.a.member, directory: f.directory };
  const create = {
    room: "test-room",
    tokens: false,
    method: "PUT",
    storage,
    body: { ...payload, sig: sign(controlPayload("create", "test-room", payload), f.a.identity) },
  };
  expect(roomHttp(create).status).toBe(403);
  expect(
    roomHttp({ ...create, createSecret: "secret", authorization: "Bearer wrong" }).status,
  ).toBe(403);
  expect(
    roomHttp({ ...create, createSecret: "secret", authorization: "Bearer secret" }).status,
  ).toBe(201);
  const token = { memberId: f.a.member.id, nonce: "unique", at: now };
  const request = {
    room: "test-room",
    tokens: true,
    method: "POST",
    storage,
    core,
    now: () => now,
    body: { ...token, sig: sign(controlPayload("token", "test-room", token), f.a.identity) },
  };
  expect(roomHttp(request).status).toBe(200);
  expect(roomHttp(request).status).toBe(403);
});
it("W3: closes sockets without hello at ten seconds", () => {
  vi.useFakeTimers();
  try {
    const c = client();
    vi.advanceTimersByTime(9999);
    expect(c.closed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(c.closed()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
