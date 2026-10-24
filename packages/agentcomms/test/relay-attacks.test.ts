import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { signDirectory, signGrant } from "../src/auth.ts";
import { newRoomKey, wrapMemberKeys, wrapRoomKey } from "../src/membership.ts";
import type { ClientMessage } from "../src/protocol.ts";
import { createRoomCore } from "../src/relay-core.ts";
import { createRelaySession, type RelayPeer } from "../src/relay-session.ts";
import { fixture, person } from "./relay-fixtures.ts";

const transport = vi.hoisted(() => ({
  session: undefined as ReturnType<typeof createRelaySession> | undefined,
  sockets: [] as { terminate(): void; peer: RelayPeer }[],
  sent: [] as ClientMessage[],
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    peer: RelayPeer;
    constructor() {
      super();
      this.peer = {
        send: (message) =>
          queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(message)), false)),
        close: () => this.terminate(),
      };
      transport.sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        transport.session?.connect(this.peer);
        this.emit("open");
      });
    }
    send(raw: string) {
      transport.sent.push(JSON.parse(raw));
      transport.session?.receive(this.peer, raw);
    }
    terminate() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      transport.session?.disconnect(this.peer);
      this.emit("close");
    }
  }
  return { WebSocket: Socket };
});

import { type Daemon, startDaemon } from "../src/daemon.ts";
import { seal } from "../src/envelope.ts";
import { draft } from "./daemon-fixtures.ts";

const daemons: Daemon[] = [];
let home: string;
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  if (home) await rm(home, { recursive: true, force: true });
  transport.sent = [];
  transport.sockets = [];
  transport.session = undefined;
});
async function setup(answer?: string) {
  const f = await fixture();
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    grants: await f.grants(f.key, 0, f.a.member),
  });
  const token = core.issueToken(f.a.identity.id);
  core.requestJoin(token, f.b.member);
  core.approve(
    f.a.identity.id,
    f.b.identity.id,
    await f.grants(f.key, 0, f.b.member),
    f.nextDirectory(core),
  );
  transport.session = createRelaySession("test-room", core);
  home = await mkdtemp(join(tmpdir(), "comms-memory-"));
  for (const [name, person] of [
    ["a", f.a],
    ["b", f.b],
  ] as const) {
    daemons.push(
      await startDaemon({
        home: join(home, name),
        agent: person.agent,
        delegation: person.delegation,
        member: person.member,
        rooms: [
          { invite: { ownerId: f.a.identity.id, room: "test-room", relay: "ws://memory", token } },
        ],
        answer,
      }),
    );
  }
  await expect.poll(() => Object.keys(daemons[0].presence("test-room")).length).toBe(2);
  return { ...f, core, aDaemon: daemons[0], bDaemon: daemons[1] };
}

it("B1: a fake relay cannot replace a grant with its own known room key", async () => {
  const f = await setup();
  const evil = await fixture();
  const grants = await wrapMemberKeys(evil.key, 0, f.b.member);
  transport.sockets[1].peer.send({
    t: "grants",
    grants: grants.filter((g) => g.memberId === f.b.agent.id),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(transport.sockets).toHaveLength(2);
  expect(await f.bDaemon.send("test-room", draft("still usable"))).toHaveProperty("seq");
});
it("B1: fake relay directory substitutions cannot impersonate an approved member", async () => {
  const f = await setup();
  const attacker = await person("Mallory");
  transport.sockets[1].peer.send({
    t: "directory",
    ...f.core.directory(),
    members: [f.a.member, f.b.member, attacker.member],
    activeMemberIds: [f.a.member.id, f.b.member.id, attacker.member.id],
  });
  const sealed = await seal(
    { ...draft("forged"), id: "forged", auto: false, sentAt: new Date().toISOString() },
    attacker.agent,
    f.key,
    0,
    attacker.delegation,
  );
  transport.sockets[1].peer.send({ t: "msg", seq: 1, sealed });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.bDaemon.read("test-room").filter((row) => row.msg?.id === "forged")).toEqual([]);
});
it("B2: fake relay epoch rollback never changes the sending epoch", async () => {
  const f = await setup();
  transport.sockets[1].peer.send({ t: "directory", ...f.core.directory(), keyEpoch: 7 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await f.bDaemon.send("test-room", draft("unsigned epoch ignored"))).toHaveProperty("seq");
});
it("B3: signed poison ciphertext is quarantined and a following valid message is delivered", async () => {
  const f = await setup();
  const evil = await fixture();
  const msg = { ...draft("poison"), id: "poison", auto: false, sentAt: new Date().toISOString() };
  transport.sockets[1].peer.send({
    t: "msg",
    seq: 1,
    sealed: await seal(msg, f.a.agent, evil.key, 0, f.a.delegation),
  });
  transport.sockets[1].peer.send({
    t: "msg",
    seq: 2,
    sealed: await seal({ ...msg, id: "good" }, f.a.agent, f.key, 0, f.a.delegation),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.bDaemon.read("test-room")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ seq: 1, quarantined: true, reason: expect.any(String) }),
      expect.objectContaining({ seq: 2, msg: expect.objectContaining({ id: "good" }) }),
    ]),
  );
});

it("B2: a newer signed grant holds sending until the signed epoch arrives", async () => {
  const f = await setup();
  const grant = signGrant(
    "test-room",
    await wrapRoomKey(await newRoomKey(), 1, f.b.member.agents[0]),
    f.a.identity,
  );
  transport.sockets[1].peer.send({ t: "grants", grants: [grant] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(await f.bDaemon.send("test-room", draft("no downgrade"))).toHaveProperty("held");
});
it("B1/B2: verified rotations reject removed members, old ciphertext, and signed directory replay across restart", async () => {
  const f = await setup();
  const old = f.core.directory();
  const rotated = await f.rotate(f.core.members(), f.b.member.id, 1);
  const directory = f.nextDirectory(f.core, f.b.member.id);
  f.core.remove(f.a.member.id, f.b.member.id, rotated.grants, directory);
  const socket = transport.sockets[0];
  socket.peer.send({ t: "directory", ...directory });
  socket.peer.send({
    t: "grants",
    grants: rotated.grants.filter((g) => g.memberId === f.a.agent.id),
  });
  socket.peer.send({ t: "directory", ...old });
  const msg = { ...draft("replay"), id: "replay", auto: false, sentAt: new Date().toISOString() };
  socket.peer.send({
    t: "msg",
    seq: 1,
    sealed: await seal(msg, f.b.agent, f.key, 0, f.b.delegation),
  });
  socket.peer.send({
    t: "msg",
    seq: 2,
    sealed: await seal({ ...msg, id: "old-owner" }, f.a.agent, f.key, 0, f.a.delegation),
  });
  await expect.poll(() => f.aDaemon.read("test-room").length).toBe(2);
  expect(f.aDaemon.read("test-room").every((row) => row.quarantined)).toBe(true);
  // Align the fake relay's cursor with the injected frames before reconnecting;
  // otherwise this fixture also simulates a relay reset, which must pause the room.
  f.core.post(await seal({ ...msg, id: "pad1" }, f.a.agent, rotated.roomKey, 1, f.a.delegation));
  f.core.post(await seal({ ...msg, id: "pad2" }, f.a.agent, rotated.roomKey, 1, f.a.delegation));
  await f.aDaemon.stop();
  const restarted = await startDaemon({
    home: join(home, "a"),
    agent: f.a.agent,
    delegation: f.a.delegation,
    member: f.a.member,
    rooms: [
      {
        invite: {
          room: "test-room",
          relay: "ws://memory",
          token: "unused",
          ownerId: f.a.member.id,
        },
      },
    ],
  });
  daemons.push(restarted);
  await expect.poll(() => restarted.rooms()[0].status).toBe("connected");
  transport.sockets.at(-1)?.peer.send({ t: "directory", ...old });
  expect(await restarted.send("test-room", draft("current"))).toHaveProperty("seq");
  expect(transport.sent.filter((m) => m.t === "post").at(-1)).toMatchObject({
    sealed: { keyEpoch: 1 },
  });
});
it.each(["unknown epoch", "bad grant", "invalid directory"])(
  "B3: %s is quarantined without blocking the cursor",
  async (reason) => {
    const f = await setup();
    const msg = { ...draft("poison"), id: reason, auto: false, sentAt: new Date().toISOString() };
    const outsider = await person("outsider");
    let key = f.key;
    let epoch = reason === "unknown epoch" ? 9 : 0;
    let from = f.a;
    if (reason === "invalid directory") from = outsider;
    if (reason === "bad grant") {
      key = await newRoomKey();
      epoch = 1;
      transport.sockets[1].peer.send({
        t: "directory",
        ...signDirectory("test-room", 1, 2, [f.a.member, f.b.member], f.a.identity),
      });
      transport.sockets[1].peer.send({
        t: "grants",
        grants: await wrapMemberKeys(key, 1, f.b.member).then((gs) =>
          gs.filter((g) => g.memberId === f.b.agent.id),
        ),
      });
    }
    transport.sockets[1].peer.send({
      t: "msg",
      seq: 1,
      sealed: await seal(msg, from.agent, key, epoch, from.delegation),
    });
    await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
    expect(f.bDaemon.read("test-room")[0]).toMatchObject({
      quarantined: true,
      msg: null,
      reason: expect.any(String),
    });
    transport.sockets[1].terminate();
    await expect
      .poll(() => transport.sent.filter((m) => m.t === "since").at(-1), { timeout: 3000 })
      .toEqual({ t: "since", seq: 1 });
  },
);
it("W5: a fake relay replay at a different sequence is stored once and advances the cursor", async () => {
  const f = await setup("cat >/dev/null; echo reply");
  const msg = {
    ...draft("hello"),
    kind: "question" as const,
    id: "same",
    auto: false,
    sentAt: new Date().toISOString(),
  };
  const sealed = await seal(msg, f.a.agent, f.key, 0, f.a.delegation);
  transport.sockets[1].peer.send({ t: "msg", seq: 1, sealed });
  transport.sockets[1].peer.send({ t: "msg", seq: 2, sealed });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.bDaemon.read("test-room").filter((row) => row.msg?.id === "same")).toHaveLength(1);
  expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(1);
  transport.sockets[1].terminate();
  await expect
    .poll(() => transport.sent.filter((m) => m.t === "since").at(-1), { timeout: 3000 })
    .toEqual({ t: "since", seq: 2 });
});
it.each(["reason", "refs", "source", "name", "thread", "inReplyTo"])(
  "W6: scans and caps %s on direct daemon sends",
  async (field) => {
    const f = await setup();
    const make = (value: string) => ({
      ...draft("safe body"),
      ...(field === "refs"
        ? { refs: [value] }
        : field === "source"
          ? { knowledge: { kind: "checked" as const, source: value, asOf: "2026-10-24" } }
          : field === "name"
            ? { requestedBy: { kind: "human" as const, name: value } }
            : { [field]: value }),
    });
    expect(await f.bDaemon.send("test-room", make(`ghp_${"a".repeat(36)}`))).toHaveProperty("held");
    await expect(f.bDaemon.send("test-room", make("x".repeat(5000)))).rejects.toThrow();
    expect(transport.sent.some((m) => m.t === "post")).toBe(false);
  },
);
it("N7: direct daemon requests need a reason", async () => {
  const f = await setup();
  await expect(
    f.bDaemon.send("test-room", { ...draft("request"), kind: "request" }),
  ).rejects.toThrow("a request needs a reason");
});
it("W8: an unavailable room never delays startup", async () => {
  const f = await fixture();
  home = await mkdtemp(join(tmpdir(), "comms-offline-"));
  const daemon = await startDaemon({
    home,
    agent: f.a.agent,
    delegation: f.a.delegation,
    member: f.a.member,
    rooms: [
      {
        invite: { ownerId: f.a.member.id, relay: "ws://offline", room: "offline", token: "unused" },
      },
    ],
  });
  daemons.push(daemon);
  expect(daemon.rooms()).toMatchObject([{ room: "offline", status: "connecting" }]);
  expect(await daemon.send("offline", { ...draft("held"), room: "offline" })).toHaveProperty(
    "held",
  );
});

it("B3: successful frames on short connections do not reset reconnect backoff", async () => {
  const f = await setup();
  const { setTimeout: pause } = await import("node:timers/promises");
  vi.useFakeTimers();
  try {
    transport.sockets[1].terminate();
    const count = transport.sockets.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.sockets).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    await pause(30);
    expect(f.bDaemon.rooms()[0].status).toBe("connected");
    transport.sockets.at(-1)?.terminate();
    await vi.advanceTimersByTimeAsync(1999);
    expect(transport.sockets).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(1);
    await pause(30);
    expect(f.bDaemon.rooms()[0].status).toBe("connected");
    transport.sockets.at(-1)?.terminate();
    await vi.advanceTimersByTimeAsync(3999);
    expect(transport.sockets).toHaveLength(count + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.sockets).toHaveLength(count + 3);
  } finally {
    vi.useRealTimers();
  }
});
it("B3: a signed envelope with invalid sender metadata is quarantined", async () => {
  const f = await setup();
  const msg = {
    ...draft("metadata"),
    id: "metadata",
    auto: false,
    sentAt: new Date().toISOString(),
  };
  const sealed = await seal(msg, f.a.agent, f.key, 0, f.a.delegation);
  const malformed = JSON.parse(JSON.stringify(sealed));
  malformed.sender.delegation.boxPublicKey = 7;
  transport.sockets[1].peer.send({ t: "msg", seq: 1, sealed: malformed });
  await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
  expect(f.bDaemon.read("test-room")[0]).toMatchObject({
    quarantined: true,
    reason: "Invalid signed envelope metadata",
  });
});
it("B1: a replacement owner's valid signatures cannot replace the invite pin", async () => {
  const f = await setup();
  const attacker = await person("relay");
  transport.sockets[1].peer.send({
    t: "directory",
    ...signDirectory("test-room", 0, 99, [attacker.member, f.b.member], attacker.identity),
  });
  const key = await newRoomKey();
  const grants = (await wrapMemberKeys(key, 0, f.b.member))
    .filter((g) => g.memberId === f.b.agent.id)
    .map((g) => signGrant("test-room", g, attacker.identity));
  transport.sockets[1].peer.send({ t: "grants", grants });
  const sealed = await seal(
    { ...draft("forged"), id: "evil-owner", auto: false, sentAt: new Date().toISOString() },
    attacker.agent,
    key,
    0,
    attacker.delegation,
  );
  transport.sockets[1].peer.send({ t: "msg", seq: 1, sealed });
  await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
  expect(f.bDaemon.read("test-room")[0]).toMatchObject({ quarantined: true, msg: null });
});
it("W8: a pending room retries while an approved room connects", async () => {
  const f = await setup();
  const daemon = await startDaemon({
    home: join(home, "mixed"),
    agent: f.a.agent,
    delegation: f.a.delegation,
    member: f.a.member,
    rooms: ["test-room", "pending-room"].map((room) => ({
      invite: { room, ownerId: f.a.member.id, relay: "ws://memory", token: "unused" },
    })),
  });
  daemons.push(daemon);
  await expect.poll(() => daemon.rooms().map((r) => r.status)).toEqual(["connected", "pending"]);
  const count = transport.sockets.length;
  await expect.poll(() => transport.sockets.length, { timeout: 3000 }).toBeGreaterThan(count);
  expect(daemon.rooms()[0].status).toBe("connected");
});
