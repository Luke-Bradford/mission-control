import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDOStorage } from "../../../apps/relay/src/storage.ts";
import { RoomDO } from "../../../apps/relay/src/worker.ts";
import { verifyDirectory } from "../src/auth.ts";
import {
  HELLO_TIMEOUT_MS,
  LOG_LIMIT,
  LOG_PAGE_SIZE,
  POST_WINDOW_MS,
  PRESENCE_INTERVAL_MS,
} from "../src/limits.ts";
import { unwrapRoomKey } from "../src/membership.ts";
import type { RelayMessage } from "../src/protocol.ts";
import { makeHello } from "../src/relay-client.ts";
import { createRoomCore, type RoomState } from "../src/relay-core.ts";
import type { PeerState } from "../src/relay-session.ts";
import { fixture } from "./relay-fixtures.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});
function backingStore() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const backing = {
    sql: {
      exec: vi.fn((query: string, ...bindings: (string | number)[]) => {
        const statement = db.prepare(query);
        if (statement.columns().length) return statement.iterate(...bindings);
        statement.run(...bindings);
        return [];
      }),
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, backing };
}

it("stores log entries and metadata separately, resumes, and persists removal", async () => {
  const { db, backing } = backingStore();
  const f = await fixture();
  const storage = createDOStorage(backing);
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    storage,
  });
  core.requestJoin(core.issueToken(f.a.identity.id), f.b.member);
  core.approve(
    f.a.identity.id,
    f.b.identity.id,
    await f.grants(f.key, 0, f.b.member),
    f.nextDirectory(core),
  );
  backing.sql.exec.mockClear();
  core.post(await f.post(1));
  const writes = backing.sql.exec.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql));
  expect(writes).toHaveLength(4);
  expect(writes[0].slice(1, 3)).toEqual(["header", "room"]);
  expect(writes[1].slice(1, 3)).toEqual(["postRates", f.a.identity.id]);
  expect(writes[2][0]).toContain("INSERT INTO room_log");
  backing.sql.exec.mockClear();
  core.setPresence(f.a.agent.id, "online");
  expect(backing.sql.exec).not.toHaveBeenCalled();
  for (let i = 2; i <= 3; i++) core.post(await f.post(i));
  expect(storage.load()?.log).toEqual([]);
  expect(storage.load()?.presence).toEqual({});
  expect(db.prepare("SELECT count(*) AS n FROM room_log").get()?.n).toBe(3);
  const restored = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    now: Date.now,
    storage: createDOStorage(backing),
  });
  expect(restored.since(f.a.identity.id, 1).map((m) => m.seq)).toEqual([2, 3]);
  expect(restored.post(await f.post(4))).toEqual({ seq: 4 });
  expect(await unwrapRoomKey(restored.grantsFor(f.b.agent.id)[0], f.b.agent)).toEqual(f.key);
  const rotation = await f.rotate(restored.members(), f.b.identity.id, 1);
  restored.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotation.grants,
    f.nextDirectory(restored, f.b.identity.id),
  );
  const again = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    now: Date.now,
    storage: createDOStorage(backing),
  });
  expect(await unwrapRoomKey(again.grantsFor(f.a.agent.id)[0], f.a.agent)).toEqual(
    rotation.roomKey,
  );
  expect(again.grantsFor(f.b.agent.id)).toEqual([]);
  expect(again.directory().members).toEqual([f.a.member]);
});

it("bounds reads and retention without loading ciphertext into room state", async () => {
  const { db, backing } = backingStore();
  const f = await fixture();
  const storage = createDOStorage(backing);
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    maxPerMinute: LOG_LIMIT + 2,
    storage,
  });
  const sealed = await f.post(1);
  for (let i = 0; i < LOG_LIMIT + 2; i++) core.post(sealed);
  expect(core.oldestSeq()).toBe(3);
  expect(db.prepare("SELECT count(*) AS n FROM room_log").get()?.n).toBe(LOG_LIMIT);
  expect(storage.load()?.log).toEqual([]);
  expect(core.since(f.a.identity.id, 0, LOG_PAGE_SIZE)).toHaveLength(LOG_PAGE_SIZE);
  expect(backing.sql.exec.mock.calls.at(-1)?.slice(1)).toEqual([0, LOG_PAGE_SIZE]);
});

it("migrates chunked snapshots including escaped strings and Unicode without losing log order", async () => {
  const { db, backing } = backingStore();
  const f = await fixture();
  let snapshot: RoomState | undefined;
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    storage: {
      load: () => undefined,
      save: (state) => {
        snapshot = state;
      },
    },
  });
  for (let i = 0; i < 3; i++) core.post(await f.post(i));
  if (!snapshot) throw new Error("Missing snapshot");
  snapshot.pending = [{ ...f.b.member, label: 'quotes " and \\ 🙂 , [ ] { }' }];
  db.exec("CREATE TABLE room_state (part INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const json = JSON.stringify(snapshot);
  for (let i = 0; i < json.length; i += 101)
    db.prepare("INSERT INTO room_state VALUES (?, ?)").run(i, json.slice(i, i + 101));
  const storage = createDOStorage(backing);
  const migrated = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    now: Date.now,
    storage,
  });
  expect(verifyDirectory(migrated.directory(), "test-room", f.a.identity.id)).toBe(true);
  expect(migrated.directory()).toEqual(core.directory());
  expect(migrated.seq()).toBe(3);
  expect(migrated.oldestSeq()).toBe(1);
  expect(migrated.since(f.a.identity.id, 0)).toEqual(snapshot.log);
  expect(storage.load()?.pending).toEqual(snapshot.pending);
  expect(storage.readLog?.(0, LOG_PAGE_SIZE)).toEqual(snapshot.log);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'room_state'").all()).toEqual([]);
  expect(createDOStorage(backing).readLog?.(0, LOG_PAGE_SIZE)).toEqual(snapshot.log);
});

it("rolls sequence and append back together if storage fails", async () => {
  const { db, backing } = backingStore();
  const f = await fixture();
  const storage = createDOStorage(backing);
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    storage,
  });
  db.exec(
    "CREATE TRIGGER fail_post BEFORE INSERT ON room_log BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
  );
  const sealed = await f.post(1);
  expect(() => core.post(sealed)).toThrow("disk failure");
  expect(storage.load()?.seq).toBe(0);
  db.exec("DROP TRIGGER fail_post");
  expect(core.post(sealed)).toEqual({ seq: 1 });
});

class HibernatingSocket {
  messages: RelayMessage[] = [];
  attachment?: PeerState;
  closed = false;
  send(raw: string) {
    this.messages.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
  }
  serializeAttachment(state: PeerState) {
    this.attachment = structuredClone(state);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}
async function workerFixture() {
  const { db, backing } = backingStore();
  const f = await fixture();
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    storage: createDOStorage(backing),
  });
  const sockets: HibernatingSocket[] = [];
  const ctx = {
    storage: { ...backing, setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}) },
    getWebSockets: vi.fn(() => sockets.filter((s) => !s.closed)),
    acceptWebSocket: vi.fn((s: HibernatingSocket) => sockets.push(s)),
  };
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new HibernatingSocket();
      1 = new HibernatingSocket();
    },
  );
  const NativeResponse = globalThis.Response;
  vi.stubGlobal(
    "Response",
    class extends NativeResponse {
      constructor(body: BodyInit | null, init: ResponseInit) {
        super(body, init.status === 101 ? { status: 200 } : init);
      }
    },
  );
  const makeWorker = () =>
    new RoomDO(ctx as unknown as ConstructorParameters<typeof RoomDO>[0], {} as never);
  const send = (worker: RoomDO, socket: HibernatingSocket, value: unknown) =>
    worker.webSocketMessage(
      socket as unknown as Parameters<RoomDO["webSocketMessage"]>[0],
      JSON.stringify(value),
    );
  const connect = async (worker: RoomDO) => {
    await worker.fetch(
      new Request("https://relay/rooms/test-room", { headers: { Upgrade: "websocket" } }),
    );
    return sockets.at(-1) as HibernatingSocket;
  };
  const authenticate = async (worker: RoomDO, socket: HibernatingSocket, identity = f.a.agent) => {
    const challenge = socket.messages[0];
    if (challenge.t !== "challenge") throw new Error("Missing challenge");
    await send(worker, socket, await makeHello("test-room", identity, challenge.challenge));
  };
  return { ...f, core, db, backing, ctx, sockets, makeWorker, send, connect, authenticate };
}

it("hibernates sockets, restores authenticated cursors, and initializes once for concurrent events", async () => {
  const f = await workerFixture();
  let worker = f.makeWorker();
  const a = await f.connect(worker);
  const b = await f.connect(worker);
  expect(f.ctx.acceptWebSocket).toHaveBeenCalledTimes(2);
  await f.authenticate(worker, a);
  await f.authenticate(worker, b);
  await f.send(worker, a, { t: "since", seq: 0 });
  await f.send(worker, b, { t: "since", seq: 0 });
  await f.send(worker, a, { t: "post", id: "first", sealed: await f.post(1, f.a.agent) });
  expect(a.attachment?.seq).toBe(1);
  expect(b.attachment?.seq).toBe(1);
  worker = f.makeWorker();
  f.ctx.getWebSockets.mockClear();
  await Promise.all([
    f.send(worker, a, { t: "since", seq: 0 }),
    f.send(worker, b, { t: "since", seq: 0 }),
  ]);
  expect(f.ctx.getWebSockets).toHaveBeenCalledTimes(1);
  await f.send(worker, a, { t: "post", id: "second", sealed: await f.post(2, f.a.agent) });
  expect(a.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([1, 2]);
  expect(b.messages.filter((m) => m.t === "msg").map((m) => m.seq)).toEqual([1, 2]);
  expect(a.messages.filter((m) => m.t === "challenge")).toHaveLength(1);
  expect(f.ctx.storage.deleteAlarm).toHaveBeenCalled();
});

it("restores an unauthenticated challenge and expires it with an alarm", async () => {
  const f = await workerFixture();
  let worker = f.makeWorker();
  const authenticated = await f.connect(worker);
  worker = f.makeWorker();
  await f.authenticate(worker, authenticated);
  expect(authenticated.attachment?.id).toBe(f.a.agent.id);
  const expired = await f.connect(worker);
  expect(f.ctx.storage.setAlarm).toHaveBeenCalled();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + HELLO_TIMEOUT_MS);
    worker = f.makeWorker();
    await worker.alarm();
    expect(expired.closed).toBe(true);
    expect(expired.messages.at(-1)).toEqual({ t: "refused", reason: "auth-timeout" });
    expect(authenticated.closed).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("restores presence and throttling across hibernation without writing room rows or alarms", async () => {
  const f = await workerFixture();
  vi.useFakeTimers();
  try {
    let worker = f.makeWorker();
    const socket = await f.connect(worker);
    await f.authenticate(worker, socket);
    const other = await f.connect(worker);
    await f.authenticate(worker, other, f.a.identity);
    await f.send(worker, socket, { t: "presence", status: "online" });
    await f.send(worker, other, { t: "presence", status: "busy" });
    const seenAt = Date.now();
    expect(socket.attachment).toMatchObject({ status: "online", seenAt });
    worker = f.makeWorker();
    f.backing.sql.exec.mockClear();
    f.ctx.storage.setAlarm.mockClear();
    f.ctx.storage.deleteAlarm.mockClear();
    vi.setSystemTime(seenAt + 11000);
    await f.send(worker, socket, { t: "presence", status: "away" });
    // A newly authenticated peer sees both restored identities, even though the wake heartbeat was throttled.
    const observer = await f.connect(worker);
    await f.authenticate(worker, observer);
    expect(observer.messages.at(-1)).toEqual({
      t: "presence",
      map: {
        [f.a.agent.id]: { status: "online", seenAt },
        [f.a.identity.id]: { status: "busy", seenAt },
      },
    });
    f.ctx.storage.setAlarm.mockClear();
    f.ctx.storage.deleteAlarm.mockClear();
    vi.setSystemTime(seenAt + PRESENCE_INTERVAL_MS - 100);
    worker = f.makeWorker();
    await f.send(worker, socket, { t: "presence", status: "away" });
    expect(other.messages.at(-1)).toEqual({
      t: "presence",
      map: {
        [f.a.agent.id]: { status: "away", seenAt: Date.now() },
        [f.a.identity.id]: { status: "busy", seenAt },
      },
    });
    expect(f.ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(f.ctx.storage.deleteAlarm).not.toHaveBeenCalled();
    expect(
      f.backing.sql.exec.mock.calls.filter(([sql]) => /INSERT|UPDATE|DELETE/.test(sql)),
    ).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("preserves the post rate limit across hibernation and releases the expired window", async () => {
  const f = await workerFixture();
  let worker = f.makeWorker();
  const socket = await f.connect(worker);
  await f.authenticate(worker, socket);
  const sealed = await f.post(1, f.a.agent);
  for (let i = 0; i < 30; i++) await f.send(worker, socket, { t: "post", id: String(i), sealed });
  worker = f.makeWorker();
  await f.send(worker, socket, { t: "post", id: "limited", sealed });
  expect(socket.messages.at(-1)).toEqual({ t: "refused", reason: "rate-limited", id: "limited" });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.now() + POST_WINDOW_MS);
    worker = f.makeWorker();
    await f.send(worker, socket, { t: "post", id: "allowed", sealed });
    expect(f.db.prepare("SELECT count(*) AS n FROM room_log").get()?.n).toBe(31);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a corrupt legacy snapshot intact and rolls back partially migrated log rows", async () => {
  const { db, backing } = backingStore();
  const f = await fixture();
  const corrupt = JSON.stringify({
    log: [{ seq: 1, sealed: await f.post(1) }],
    room: "test-room",
  }).slice(0, -1);
  db.exec("CREATE TABLE room_state (part INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO room_state VALUES (0, ?)").run(corrupt);
  expect(() => createDOStorage(backing)).toThrow("Invalid legacy room snapshot");
  expect(db.prepare("SELECT value FROM room_state").get()?.value).toBe(corrupt);
  expect(db.prepare("SELECT * FROM room_log").all()).toEqual([]);
});

it("retries failed initialization and logs migration failures", async () => {
  const f = await workerFixture();
  f.db.exec("CREATE TABLE room_state (part INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  f.db.prepare("INSERT INTO room_state VALUES (0, ?)").run('{"room":');
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const worker = f.makeWorker();
    await expect(f.connect(worker)).rejects.toThrow("Invalid legacy room snapshot");
    expect(log).toHaveBeenCalledWith(
      "Relay room initialization or migration failed",
      expect.any(Error),
    );
    f.db.exec("DROP TABLE room_state");
    const socket = await f.connect(worker);
    await f.authenticate(worker, socket);
    expect(socket.attachment?.id).toBe(f.a.agent.id);
    const close = vi.spyOn(socket, "close").mockImplementation(() => {
      throw new Error("Already closed");
    });
    await worker.webSocketClose(socket as unknown as WebSocket, 1006, "Abnormal closure");
    expect(close).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
