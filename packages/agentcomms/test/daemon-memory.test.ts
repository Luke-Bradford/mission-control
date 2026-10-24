import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { BODY_MAX, BodyTooLarge, seal } from "../src/envelope.ts";
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
