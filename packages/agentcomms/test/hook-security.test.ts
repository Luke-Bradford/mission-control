import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { signDirectory } from "../src/auth.ts";
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

const hook = vi.hoisted(() => ({
  children: [] as {
    pid: number;
    stdout: import("node:events").EventEmitter;
    emit(event: string, ...args: unknown[]): boolean;
  }[],
}));
vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    spawn: vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        pid: 90000 + hook.children.length,
        stdout: new EventEmitter(),
        stderr: { resume() {} },
        stdin: { on() {}, end() {} },
        kill() {
          child.emit("close", 1);
        },
      });
      hook.children.push(child);
      return child;
    }),
  };
});

import { type Daemon, startDaemon } from "../src/daemon.ts";
import { seal } from "../src/envelope.ts";
import { draft } from "./daemon-fixtures.ts";

const daemons: Daemon[] = [];
let home: string;
afterEach(async () => {
  for (const child of hook.children) child.emit("close", 1);
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  hook.children = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
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

async function incoming(f: Awaited<ReturnType<typeof setup>>, id: number, overrides = {}) {
  const msg = {
    ...draft("question"),
    kind: "question" as const,
    thread: `thread-${id}`,
    id: String(id),
    auto: false,
    sentAt: new Date().toISOString(),
    ...overrides,
  };
  transport.sockets[1].peer.send({
    t: "msg",
    seq: id,
    sealed: await seal(msg, f.a.agent, f.key, 0, f.a.delegation),
  });
  await expect.poll(() => f.bDaemon.read("test-room", 0, 500).length).toBe(id);
}
it("W4: one hook at a time, five queued, and ten starts per minute per room", async () => {
  const f = await setup("answer-hook");
  for (let id = 1; id <= 12; id++) await incoming(f, id);
  expect(hook.children).toHaveLength(1);
  for (let index = 0; index < 6; index++) {
    hook.children[index].emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hook.children).toHaveLength(6);
  for (let id = 13; id <= 17; id++) {
    await incoming(f, id);
    hook.children.at(-1)?.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hook.children).toHaveLength(10);
});
it("W4: skip backlog, closed threads, and names embedded in words", async () => {
  const f = await setup("answer-hook");
  const third = await person("third");
  transport.sockets[1].peer.send({
    t: "directory",
    ...signDirectory("test-room", 0, 2, [f.a.member, f.b.member, third.member], f.a.identity),
  });
  await incoming(f, 1, { body: f.b.agent.label, sentAt: "2000-01-01T00:00:00Z" });
  await incoming(f, 2, { body: `prefix${f.b.agent.label}suffix` });
  await incoming(f, 3, { kind: "answer", thread: "closed" });
  await incoming(f, 4, { body: f.b.agent.label, thread: "closed" });
  expect(hook.children).toHaveLength(0);
  await incoming(f, 5, { body: `@${f.b.agent.label}, please answer` });
  expect(hook.children).toHaveLength(1);
});
it("W4: timeout kills the detached process group", async () => {
  const f = await setup("answer-hook");
  vi.useFakeTimers();
  const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
    hook.children.find((child) => child.pid === -pid)?.emit("close", 1);
    return true;
  });
  const msg = {
    ...draft("question"),
    kind: "question" as const,
    id: "timeout",
    auto: false,
    sentAt: new Date().toISOString(),
  };
  transport.sockets[1].peer.send({
    t: "msg",
    seq: 1,
    sealed: await seal(msg, f.a.agent, f.key, 0, f.a.delegation),
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(hook.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(kill).toHaveBeenCalledWith(-hook.children[0].pid, "SIGKILL");
});
