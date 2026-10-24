import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { controlPayload, sign } from "../src/auth.ts";
import { FRAME_MAX, LOG_PAGE_SIZE } from "../src/limits.ts";
import type { ClientMessage } from "../src/protocol.ts";
import { makeHello } from "../src/relay-client.ts";
import { createRoomCore } from "../src/relay-core.ts";
import { createRelaySession, type RelayPeer } from "../src/relay-session.ts";
import { acceptDirectory } from "../src/trust.ts";
import { fixture, person } from "./relay-fixtures.ts";

const transport = vi.hoisted(() => ({
  session: undefined as ReturnType<typeof createRelaySession> | undefined,
  sockets: [] as { terminate(): void; peer: RelayPeer }[],
  sent: [] as ClientMessage[],
  options: [] as { maxPayload: number }[],
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    peer: RelayPeer;
    constructor(_url: string, options: { maxPayload: number }) {
      super();
      transport.options.push(options);
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
import { BODY_MAX, BodyTooLarge, seal } from "../src/envelope.ts";
import { draft } from "./daemon-fixtures.ts";

const daemons: Daemon[] = [];
let home: string;
afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  if (home) await rm(home, { recursive: true, force: true });
  transport.sent = [];
  transport.options = [];
  transport.sockets = [];
  transport.session = undefined;
});
async function setup(answer?: string, backlog = 0) {
  const f = await fixture();
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    maxPerMinute: LOG_PAGE_SIZE + 20,
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
  for (let i = 0; i < backlog; i++) core.post(await f.post(i));
  transport.session = createRelaySession("test-room", core);
  home = await mkdtemp(join(tmpdir(), "comms-memory-"));
  const options = (name: "a" | "b") => ({
    home: join(home, name),
    agent: f[name].agent,
    delegation: f[name].delegation,
    member: f[name].member,
    rooms: [
      { invite: { ownerId: f.a.identity.id, room: "test-room", relay: "ws://memory", token } },
    ],
    answer,
  });
  for (const name of ["a", "b"] as const) daemons.push(await startDaemon(options(name)));
  await expect.poll(() => Object.keys(daemons[0].presence("test-room")).length).toBe(2);
  return { ...f, core, options, aDaemon: daemons[0], bDaemon: daemons[1] };
}
it("delivers through the real session/core with agent signatures and scanned bodies", async () => {
  const f = await setup();
  expect(await f.aDaemon.send("test-room", draft("hello"))).toEqual({ seq: 1 });
  await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
  expect(f.bDaemon.read("test-room")[0]).toMatchObject({
    sender: {
      kind: "agent",
      id: f.a.agent.id,
      member: { id: f.a.member.id, label: "Alice" },
    },
    msg: { body: "hello", auto: false },
  });
  expect(await f.aDaemon.send("test-room", draft(`ghp_${"x".repeat(36)}`))).toHaveProperty("held");
  await expect(f.aDaemon.send("test-room", draft("a".repeat(BODY_MAX + 1)))).rejects.toBeInstanceOf(
    BodyTooLarge,
  );
  expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(1);
});
it("serializes sends, merges concurrent duplicate questions, and holds the eleventh send", async () => {
  const f = await setup();
  const q = { ...draft("Is #506 yours?"), kind: "question" as const };
  expect(
    await Promise.all([f.aDaemon.send("test-room", q), f.aDaemon.send("test-room", q)]),
  ).toEqual([{ seq: 1 }, { merged: "thread" }]);
  for (let i = 0; i < 9; i++)
    expect(await f.aDaemon.send("test-room", draft(String(i)))).toHaveProperty("seq");
  expect(await f.aDaemon.send("test-room", draft("eleven"))).toHaveProperty("held");
  expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(10);
});
it("runs both answer hooks without a ping-pong loop or answering its own question", async () => {
  const f = await setup("cat >/dev/null; echo ok");
  await f.aDaemon.send("test-room", {
    ...draft(`${f.a.agent.label} ${f.b.agent.label}: is this yours?`),
    kind: "question",
  });
  await expect.poll(() => f.aDaemon.read("test-room").length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.aDaemon.read("test-room").map((entry) => entry.msg?.auto)).toEqual([false, true]);
  expect(f.aDaemon.read("test-room")[1].sender.id).toBe(f.b.agent.id);
});
it.each([
  { kind: "cannot-confirm" },
  { kind: "checked", source: "repo at abc123", asOf: "2026-10-24" },
  { kind: "from-notes", asOf: "2026-10-23" },
  undefined,
])("passes JSON answer-hook body and knowledge through: %j", async (knowledge) => {
  const output = JSON.stringify({ body: "I checked the shared notes", knowledge });
  const f = await setup(`cat >/dev/null; printf '%s' '${output}'`);
  await f.aDaemon.send("test-room", { ...draft("A question"), kind: "question" });
  await expect.poll(() => f.aDaemon.read("test-room").length).toBe(2);
  const [question, answer] = f.aDaemon.read("test-room");
  expect(answer.msg).toMatchObject({
    body: "I checked the shared notes",
    knowledge: knowledge ?? { kind: "cannot-confirm" },
    auto: true,
    kind: "answer",
    thread: question.msg?.thread,
    inReplyTo: question.msg?.id,
  });
});
it.each(["ok", "42", "true", "null", "[1,2]"])(
  "keeps plain-text hook answer %s with cannot-confirm knowledge",
  async (body) => {
    const f = await setup(`cat >/dev/null; printf '%s' '${body}'`);
    await f.aDaemon.send("test-room", { ...draft("A question"), kind: "question" });
    await expect.poll(() => f.aDaemon.read("test-room").length).toBe(2);
    expect(f.aDaemon.read("test-room")[1].msg).toMatchObject({
      body,
      knowledge: { kind: "cannot-confirm" },
    });
  },
);
it.each([
  { body: "", knowledge: { kind: "cannot-confirm" } },
  { body: "Do not send", knowledge: { kind: "checked" } },
  { body: "Do not send", auto: false },
  { body: `ghp_${"a".repeat(36)}` },
])("does not send empty, invalid or secret-bearing JSON hook answers: %j", async (output) => {
  const f = await setup(`cat >/dev/null; printf '%s' '${JSON.stringify(output)}'`);
  await f.aDaemon.send("test-room", { ...draft("A question"), kind: "question" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(transport.sent.filter((msg) => msg.t === "post")).toHaveLength(1);
});
it("reconnects from persisted sequence without duplicate delivery", async () => {
  const f = await setup();
  await f.aDaemon.send("test-room", draft("one"));
  await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
  transport.sockets[1].terminate();
  await f.aDaemon.send("test-room", draft("two"));
  await f.aDaemon.send("test-room", draft("three"));
  await expect
    .poll(() => f.bDaemon.read("test-room").map((entry) => entry.seq), { timeout: 4000 })
    .toEqual([1, 2, 3]);
  expect(transport.sent.filter((msg) => msg.t === "since").at(-1)).toEqual({ t: "since", seq: 1 });
});
it("rejects a human identity before creating files or sockets", async () => {
  const f = await fixture();
  await expect(
    startDaemon({
      home: "/never-created",
      agent: f.a.identity,
      delegation: f.a.delegation,
      member: f.a.member,
      rooms: [],
    }),
  ).rejects.toThrow("delegated agent");
  expect(transport.sockets).toHaveLength(0);
});
it("screens answer-hook stdout through the same outgoing secret and size guards", async () => {
  const f = await setup(`cat >/dev/null; printf 'ghp_${"a".repeat(36)}'`);
  await f.aDaemon.send("test-room", {
    ...draft(`${f.b.agent.label}, a question`),
    kind: "question",
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(f.bDaemon.read("test-room")).toHaveLength(1);
  expect(transport.sent.filter((msg) => msg.t === "post")).toHaveLength(1);
});
it("reopens a persisted inbox and requests only the missed messages", async () => {
  const f = await setup();
  await f.aDaemon.send("test-room", draft("one"));
  await expect.poll(() => f.bDaemon.read("test-room").length).toBe(1);
  await f.bDaemon.stop();
  await f.aDaemon.send("test-room", draft("two"));
  const restarted = await startDaemon({
    home: join(home, "b"),
    agent: f.b.agent,
    delegation: f.b.delegation,
    member: f.b.member,
    rooms: [
      {
        invite: {
          ownerId: f.a.identity.id,
          room: "test-room",
          relay: "ws://memory",
          token: "unused",
        },
      },
    ],
  });
  daemons.push(restarted);
  await expect.poll(() => restarted.read("test-room").map((entry) => entry.seq)).toEqual([1, 2]);
  expect(transport.sent.filter((msg) => msg.t === "since").at(-1)).toEqual({ t: "since", seq: 1 });
});

it("persists room keys only under keys with private permissions", async () => {
  await setup();
  const keys = await readdir(join(home, "a", "keys"));
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys)
    expect((await stat(join(home, "a", "keys", key))).mode & 0o777).toBe(0o600);
});

it("unwraps agent grants after offline rotation and quarantines backlog from a removed sender", async () => {
  const f = await setup();
  transport.sockets[0].terminate();
  await f.bDaemon.send("test-room", draft("before removal while Alice is offline"));
  const rotation = await f.rotate(f.core.members(), f.b.identity.id, 1);
  f.core.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotation.grants,
    f.nextDirectory(f.core, f.b.identity.id),
  );
  await expect.poll(() => f.aDaemon.read("test-room").length, { timeout: 4000 }).toBe(1);
  expect(f.aDaemon.read("test-room")[0]).toMatchObject({ quarantined: true, msg: null });
  expect(await f.aDaemon.send("test-room", draft("new epoch"))).toEqual({ seq: 2 });
  expect(transport.sent.filter((m) => m.t === "post").at(-1)).toMatchObject({
    sealed: { keyEpoch: 1 },
  });
  expect(f.bDaemon.read("test-room")).toHaveLength(1);
});
it("answers an unmentioned question in a one-to-one room", async () => {
  const f = await setup("cat >/dev/null; echo ok");
  await f.aDaemon.send("test-room", { ...draft("Are you there?"), kind: "question" });
  await expect.poll(() => f.aDaemon.read("test-room").length).toBe(2);
});
it("rejects valid signatures from identities absent from the authenticated directory", async () => {
  const f = await setup();
  const outsider = await person("outsider");
  const sealed = await seal(
    {
      ...draft("forged relay delivery"),
      id: "evil",
      auto: false,
      sentAt: new Date().toISOString(),
    },
    outsider.agent,
    f.key,
    0,
    outsider.delegation,
  );
  transport.sockets[1].peer.send({ t: "msg", seq: 1, sealed });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.bDaemon.read("test-room")).toMatchObject([{ quarantined: true, msg: null }]);
});

it("advances past epochs predating approval and resumes readable history after reconnect", async () => {
  const f = await setup();
  await f.aDaemon.send("test-room", draft("old epoch"));
  const rotated = await f.rotate(f.core.members(), f.b.identity.id, 1);
  f.core.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotated.grants,
    f.nextDirectory(f.core, f.b.identity.id),
  );
  const newcomer = await person("newcomer");
  f.core.requestJoin(f.core.issueToken(f.a.identity.id), newcomer.member);
  f.core.approve(
    f.a.identity.id,
    newcomer.identity.id,
    await f.grants(rotated.roomKey, 1, newcomer.member),
    f.nextDirectory(f.core),
  );
  const newcomerOpts = {
    home: join(home, "newcomer"),
    agent: newcomer.agent,
    delegation: newcomer.delegation,
    member: newcomer.member,
    rooms: [
      {
        invite: {
          ownerId: f.a.identity.id,
          room: "test-room",
          relay: "ws://memory",
          token: "unused",
        },
      },
    ],
  };
  const joined = await startDaemon(newcomerOpts);
  daemons.push(joined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joined.read("test-room")).toMatchObject([{ quarantined: true, msg: null }]);
  await joined.stop();
  const restarted = await startDaemon(newcomerOpts);
  daemons.push(restarted);
  await expect.poll(() => restarted.rooms()[0].status).toBe("connected");
  expect(transport.sent.filter((m) => m.t === "since").at(-1)).toEqual({ t: "since", seq: 1 });
  expect(await restarted.send("test-room", draft("readable epoch"))).toEqual({ seq: 2 });
  expect(
    restarted
      .read("test-room")
      .filter((m) => !m.quarantined)
      .map((m) => m.seq),
  ).toEqual([2]);
});

it("refuses oversized automatic answers whole", async () => {
  const f = await setup(`cat >/dev/null; node -e 'process.stdout.write("x".repeat(32001))'`);
  await f.aDaemon.send("test-room", { ...draft("A question"), kind: "question" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(1);
});

it("checks the complete sealed frame near FRAME_MAX before sending", async () => {
  const f = await setup();
  await expect(f.aDaemon.send("test-room", draft("\0".repeat(BODY_MAX)))).rejects.toThrow(
    "Sealed message exceeds FRAME_MAX",
  );
  expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(0);
  expect(await f.aDaemon.send("test-room", draft("\0".repeat(BODY_MAX - 1000)))).toEqual({
    seq: 1,
  });
  const post = transport.sent.find((m) => m.t === "post");
  expect(Buffer.byteLength(JSON.stringify(post))).toBeLessThanOrEqual(FRAME_MAX);
  expect(Buffer.byteLength(JSON.stringify(post))).toBeGreaterThan(FRAME_MAX - 10000);
});
it("only fails the pending send for a refusal carrying that message id", async () => {
  const f = await setup();
  const session = transport.session;
  if (!session) throw new Error("Missing session");
  const receive = session.receive.bind(session);
  const intercept = vi.spyOn(session, "receive").mockImplementation((peer, raw) => {
    const msg = JSON.parse(raw) as ClientMessage;
    if (msg.t !== "post") return receive(peer, raw);
    peer.send({ t: "refused", reason: "presence-error" });
    peer.send({ t: "refused", reason: "late-refusal", id: "old-message" });
    receive(peer, raw);
  });
  try {
    expect(await f.aDaemon.send("test-room", draft("unrelated refusals"))).toEqual({ seq: 1 });
    const before = f.aDaemon.rooms();
    intercept.mockImplementation((peer, raw) => {
      const msg = JSON.parse(raw) as ClientMessage;
      if (msg.t !== "post") return receive(peer, raw);
      peer.send({ t: "refused", reason: "rate-limited", id: msg.id });
    });
    await expect(f.aDaemon.send("test-room", draft("matching refusal"))).rejects.toThrow(
      "rate-limited",
    );
    expect(f.aDaemon.rooms()).toEqual(before);
  } finally {
    intercept.mockRestore();
  }
});
it("surfaces a retention gap while continuing to receive messages", async () => {
  const f = await setup();
  transport.sockets[0].peer.send({ t: "gap", from: 1, to: 12 });
  await expect.poll(() => f.aDaemon.rooms()[0].gaps).toEqual([{ from: 1, to: 12 }]);
  expect(f.aDaemon.rooms()[0].error).toBeUndefined();
  expect(f.aDaemon.rooms()[0].status).toBe("connected");
  expect(await f.aDaemon.send("test-room", draft("still connected"))).toEqual({ seq: 1 });
});
it("stops a removed room after reconnect and explains why", async () => {
  const f = await setup();
  transport.sockets[1].terminate();
  const rotation = await f.rotate(f.core.members(), f.b.identity.id, 1);
  f.core.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotation.grants,
    f.nextDirectory(f.core, f.b.identity.id),
  );
  transport.sockets[0].terminate();
  await expect.poll(() => f.bDaemon.rooms()[0].status, { timeout: 4000 }).toBe("removed");
  expect(f.bDaemon.rooms()[0].error).toContain("communicator stopped");
  await expect(f.bDaemon.send("test-room", draft("removed"))).rejects.toThrow("Removed from room");
  const connections = transport.sockets.length;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(transport.sockets).toHaveLength(connections);
  expect(await f.aDaemon.send("test-room", draft("remaining member"))).toEqual({ seq: 1 });
});

it("stores every replay page before requesting the next and reserves receive headroom", async () => {
  const f = await setup(undefined, LOG_PAGE_SIZE + 3);
  await expect.poll(() => f.bDaemon.read("test-room", 0, 500).length).toBe(LOG_PAGE_SIZE + 3);
  expect(f.bDaemon.read("test-room", 0, 500).map((m) => m.seq)).toEqual(
    Array.from({ length: LOG_PAGE_SIZE + 3 }, (_, i) => i + 1),
  );
  expect(
    transport.sent
      .filter((m) => m.t === "since")
      .map((m) => m.seq)
      .sort((a, b) => a - b),
  ).toEqual([0, 0, LOG_PAGE_SIZE, LOG_PAGE_SIZE]);
  expect(transport.options.every((options) => options.maxPayload === FRAME_MAX + 1024)).toBe(true);
});
it("fails a pending post on a legacy id-less invalid-message refusal", async () => {
  const f = await setup();
  const session = transport.session;
  if (!session) throw new Error("Missing session");
  const receive = session.receive.bind(session);
  const intercept = vi.spyOn(session, "receive").mockImplementation((peer, raw) => {
    if (JSON.parse(raw).t === "post") peer.send({ t: "refused", reason: "invalid-message" });
    else receive(peer, raw);
  });
  try {
    await expect(f.aDaemon.send("test-room", draft("legacy relay"))).rejects.toThrow(
      "invalid-message",
    );
    expect(f.aDaemon.rooms()[0]).toMatchObject({ status: "connected" });
    expect(f.aDaemon.rooms()[0].error).toBeUndefined();
  } finally {
    intercept.mockRestore();
  }
});
it.each(["unsigned", "forged", "stale"])("reconnects after %s removal claims", async (kind) => {
  const f = await setup();
  if (kind !== "unsigned")
    transport.sockets[1].peer.send({
      t: "directory",
      ...(kind === "stale"
        ? f.directory
        : {
            ...f.nextDirectory(f.core, f.b.identity.id),
            sig: "invalid",
          }),
    });
  transport.sockets[1].peer.send({ t: "refused", reason: "removed" });
  await expect.poll(() => f.bDaemon.rooms()[0].status).toBe("disconnected");
  expect(transport.sockets).toHaveLength(2);
  await expect.poll(() => transport.sockets.length, { timeout: 4000 }).toBe(3);
  await expect.poll(() => f.bDaemon.rooms()[0].status).toBe("connected");
  expect(await f.bDaemon.send("test-room", draft("still a member"))).toEqual({ seq: 1 });
});
it("stops a connected member after verifying the live removal directory", async () => {
  const f = await setup();
  const session = transport.session;
  if (!session) throw new Error("Missing session");
  const owner: RelayPeer = { send() {}, close() {} };
  let challenge = "";
  owner.send = (message) => {
    if (message.t === "challenge") challenge = message.challenge;
  };
  session.connect(owner);
  session.receive(owner, JSON.stringify(await makeHello("test-room", f.a.identity, challenge)));
  const rotation = await f.rotate(f.core.members(), f.b.identity.id, 1);
  const payload = {
    memberId: f.b.identity.id,
    grants: rotation.grants,
    directory: f.nextDirectory(f.core, f.b.identity.id),
  };
  session.receive(
    owner,
    JSON.stringify({
      t: "remove",
      ...payload,
      sig: sign(controlPayload("remove", "test-room", payload), f.a.identity),
    }),
  );
  await expect.poll(() => f.bDaemon.rooms()[0].status).toBe("removed");
  await expect(f.bDaemon.send("test-room", draft("removed"))).rejects.toThrow("Removed from room");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(transport.sockets).toHaveLength(2);
  expect(await f.aDaemon.send("test-room", draft("new epoch"))).toEqual({ seq: 1 });
  session.disconnect(owner);
});

it.each(["fresh", "pending"] as const)(
  "keeps reconnecting for a %s member omitted from a genuine directory",
  async (kind) => {
    const f = await setup();
    const candidate = kind === "fresh" ? f.b : await person("Pending");
    const options = {
      ...f.options("b"),
      home: join(home, kind),
      agent: candidate.agent,
      delegation: candidate.delegation,
      member: candidate.member,
    };
    if (kind === "pending") {
      f.core.requestJoin(f.core.issueToken(f.a.identity.id), candidate.member);
      await acceptDirectory(options.home, options.rooms[0].invite, f.directory);
    }
    const session = transport.session;
    if (!session) throw new Error("Missing session");
    const receive = session.receive.bind(session);
    const intercept = vi.spyOn(session, "receive").mockImplementation((peer, raw) => {
      const msg = JSON.parse(raw) as ClientMessage;
      if (msg.t === "hello" && msg.memberId === candidate.agent.id) {
        peer.send({ t: "directory", ...(kind === "fresh" ? f.directory : f.core.directory()) });
        peer.send({ t: "refused", reason: "removed" });
      } else receive(peer, raw);
    });
    try {
      const daemon = await startDaemon(options);
      daemons.push(daemon);
      await expect.poll(() => daemon.rooms()[0].status).toBe("disconnected");
      expect(daemon.rooms()[0].error).toBe("removed");
      expect(await daemon.send("test-room", draft())).toHaveProperty("held");
      const connections = transport.sockets.length;
      await expect.poll(() => transport.sockets.length, { timeout: 4000 }).toBe(connections + 1);
      await expect.poll(() => daemon.rooms()[0].status).toBe("disconnected");
    } finally {
      intercept.mockRestore();
    }
  },
);

it("does not connect after restarting with persisted proof of removal", async () => {
  const f = await setup();
  transport.sockets[1].peer.send({
    t: "directory",
    ...f.nextDirectory(f.core, f.b.identity.id),
  });
  await expect.poll(() => f.bDaemon.rooms()[0].status).toBe("removed");
  await f.bDaemon.stop();
  const connections = transport.sockets.length;
  const restarted = await startDaemon(f.options("b"));
  daemons.push(restarted);
  expect(restarted.rooms()[0].status).toBe("removed");
  await expect(restarted.send("test-room", draft())).rejects.toThrow("Removed from room");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(transport.sockets).toHaveLength(connections);
});

it("pauses on a restored relay without rewinding the inbox, including after restart", async () => {
  const f = await setup();
  await f.aDaemon.send("test-room", draft("original one"));
  await f.aDaemon.send("test-room", draft("original two"));
  const history = f.aDaemon.read("test-room");
  transport.sockets[0].terminate();
  const restored = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    grants: await f.grants(f.key, 0, f.a.member),
  });
  transport.session = createRelaySession("test-room", restored);
  await expect.poll(() => f.aDaemon.rooms()[0].status, { timeout: 4000 }).toBe("relay-reset");
  expect(f.aDaemon.rooms()[0].error).toContain("relay sequence 0 is behind local cursor 2");
  expect(f.aDaemon.rooms()[0].error).toContain("migrate to a new room");
  expect(f.aDaemon.rooms()[0].gaps).toEqual([]);
  await expect(f.aDaemon.send("test-room", draft())).rejects.toThrow("Relay history reset");
  expect(f.aDaemon.read("test-room")).toEqual(history);
  expect(transport.sent.filter((m) => m.t === "since").at(-1)).toEqual({ t: "since", seq: 2 });
  const connections = transport.sockets.length;
  await f.aDaemon.stop();
  // Catching up numerically must not clear the pause: these are different messages.
  restored.post(await f.post(101));
  restored.post(await f.post(102));
  const restarted = await startDaemon(f.options("a"));
  daemons.push(restarted);
  expect(restarted.rooms()[0].status).toBe("relay-reset");
  expect(restarted.read("test-room")).toEqual(history);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(transport.sockets).toHaveLength(connections);
});

it("fails pending sends on reset and ignores queued reused sequences with a visible pause", async () => {
  const f = await setup("cat >/dev/null; echo should-not-answer");
  await f.aDaemon.send("test-room", draft("original"));
  const history = f.aDaemon.read("test-room");
  const reused = await seal(
    {
      ...draft("new question"),
      id: "new",
      sentAt: new Date().toISOString(),
      auto: false,
      kind: "question",
    },
    f.b.agent,
    f.key,
    0,
    f.b.delegation,
  );
  const session = transport.session;
  if (!session) throw new Error("Missing session");
  const receive = session.receive.bind(session);
  const intercept = vi.spyOn(session, "receive").mockImplementation((peer, raw) => {
    if (JSON.parse(raw).t !== "post") return receive(peer, raw);
    peer.send({ t: "reset", relaySeq: 0 });
    peer.send({ t: "msg", seq: 1, sealed: reused });
    peer.send({ t: "msg", seq: 2, sealed: reused });
    peer.send({ t: "grants", grants: [] });
  });
  try {
    await expect(f.aDaemon.send("test-room", draft("in flight"))).rejects.toThrow(
      "Relay history reset",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.aDaemon.rooms()[0].status).toBe("relay-reset");
    expect(f.aDaemon.read("test-room")).toEqual(history);
    expect(transport.sent.filter((m) => m.t === "post")).toHaveLength(2);
  } finally {
    intercept.mockRestore();
  }
});

it("merges overlapping gaps and retains at most the 20 highest ranges", async () => {
  const f = await setup();
  const peer = transport.sockets[0].peer;
  peer.send({ t: "gap", from: 5, to: 10 });
  peer.send({ t: "gap", from: 1, to: 6 });
  peer.send({ t: "gap", from: 10, to: 12 });
  peer.send({ t: "gap", from: 2, to: 3 });
  peer.send({ t: "gap", from: 15, to: 14 });
  await expect.poll(() => f.aDaemon.rooms()[0].gaps).toEqual([{ from: 1, to: 12 }]);
  for (let i = 0; i < 25; i++) peer.send({ t: "gap", from: 20 + i * 3, to: 21 + i * 3 });
  const expected = Array.from({ length: 20 }, (_, i) => ({ from: 35 + i * 3, to: 36 + i * 3 }));
  await expect.poll(() => f.aDaemon.rooms()[0].gaps).toEqual(expected);
  peer.send({ t: "gap", from: 1, to: 100 });
  await expect.poll(() => f.aDaemon.rooms()[0].gaps).toEqual([{ from: 1, to: 100 }]);
});
