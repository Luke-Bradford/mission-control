import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createDOStorage } from "../../../apps/relay/src/storage.ts";
import { unwrapRoomKey } from "../src/membership.ts";
import { createRoomCore } from "../src/relay-core.ts";
import { fixture } from "./relay-fixtures.ts";

it("persists a chunked Durable Object snapshot and resumes the core from SQLite", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const backing = {
      sql: {
        exec(query: string, ...bindings: (string | number)[]) {
          return db.prepare(query).all(...bindings);
        },
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
    for (let i = 0; i < 3; i++) core.post(await f.post(i));
    const snapshot = storage.load();
    if (!snapshot) throw new Error("Missing snapshot");
    snapshot.owner.label = "";
    const start = JSON.stringify(snapshot).indexOf('"label":""') + '"label":"'.length;
    snapshot.owner.label = "x".repeat(15_999 - start) + "🙂".repeat(50_000);
    storage.save(snapshot);
    expect(db.prepare("SELECT count(*) AS n FROM room_state").get()?.n).toBeGreaterThan(1);
    const restoredStorage = createDOStorage(backing);
    const restored = createRoomCore({
      room: "test-room",
      owner: f.a.member,
      directory: f.directory,
      now: Date.now,
      storage: restoredStorage,
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
      directory: f.directory,
      now: Date.now,
      storage: createDOStorage(backing),
    });
    expect(await unwrapRoomKey(again.grantsFor(f.a.agent.id)[0], f.a.agent)).toEqual(
      rotation.roomKey,
    );
    expect(again.grantsFor(f.b.agent.id)).toEqual([]);
    expect(again.directory().members).toEqual([f.a.member]);
    expect(restoredStorage.load()?.owner.label).toBe(snapshot.owner.label);
  } finally {
    db.close();
  }
});
