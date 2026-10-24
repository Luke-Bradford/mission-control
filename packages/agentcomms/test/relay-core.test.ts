import { beforeEach, expect, it } from "vitest";
import { AUTH_CLOCK_SKEW_MS, PRESENCE_INTERVAL_MS, TOKEN_TTL_MS } from "../src/limits.ts";
import {
  createRoomCore,
  type RoomCore,
  type RoomState,
  type RoomStorage,
} from "../src/relay-core.ts";
import { fixture } from "./relay-fixtures.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let core: RoomCore;
let now: number;
let saved: RoomState | undefined;
let storage: RoomStorage;
beforeEach(async () => {
  f = await fixture();
  now = 1000;
  saved = undefined;
  storage = {
    load: () => saved && structuredClone(saved),
    save: (s) => {
      saved = structuredClone(s);
    },
  };
  core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
    storage,
  });
});
async function approve() {
  const token = core.issueToken(f.a.identity.id);
  expect(Buffer.from(token, "base64url")).toHaveLength(32);
  expect(core.requestJoin(token, f.b.member)).toBe("pending");
  core.approve(
    f.a.identity.id,
    f.b.identity.id,
    await f.grants(f.key, 0, f.b.member),
    f.nextDirectory(core),
  );
  return token;
}
it("requires every recipient grant and persists agent grants across restart and removal", async () => {
  core.requestJoin(core.issueToken(f.a.identity.id), f.b.member);
  const grants = await f.grants(f.key, 0, f.b.member);
  expect(() =>
    core.approve(f.a.identity.id, f.b.identity.id, grants.slice(0, 1), f.nextDirectory(core)),
  ).toThrow("Invalid key grants");
  core.approve(f.a.identity.id, f.b.identity.id, grants, f.nextDirectory(core));
  const rebuilt = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
    storage,
  });
  expect(rebuilt.grantsFor(f.b.agent.id)).toEqual([grants[1]]);
  expect(rebuilt.grantsFor(f.b.identity.id)).toEqual([grants[0]]);
  const rotation = await f.rotate(rebuilt.members(), f.b.identity.id, 1);
  expect(() =>
    rebuilt.remove(
      f.a.identity.id,
      f.b.identity.id,
      rotation.grants.slice(0, 1),
      f.nextDirectory(rebuilt, f.b.identity.id),
    ),
  ).toThrow("Invalid key grants");
  rebuilt.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotation.grants,
    f.nextDirectory(rebuilt, f.b.identity.id),
  );
  expect(rebuilt.grantsFor(f.a.agent.id)).toEqual([rotation.grants[1]]);
  expect(rebuilt.grantsFor(f.b.agent.id)).toEqual([]);
  expect(storage.load()?.grants.some((g) => g.memberId === f.b.agent.id)).toBe(false);
});
it("refuses unapproved senders and makes invite tokens single use", async () => {
  expect(core.post(await f.post(1, f.b.identity))).toEqual({ refused: "unknown-sender" });
  const token = await approve();
  expect(core.requestJoin(token, f.b.member)).toBe("used");
  expect(core.requestJoin("unknown", f.b.member)).toBe("unknown");
  expect(core.post(await f.post(1, f.b.identity))).toEqual({ seq: 1 });
  expect(core.pending()).toEqual([]);
  expect(core.grantsFor(f.b.identity.id)).toHaveLength(1);
});
it("allows only the owner to issue, approve and remove", () => {
  expect(() => core.issueToken(f.b.identity.id)).toThrow();
  expect(() => core.approve(f.b.identity.id, f.b.identity.id, [], f.nextDirectory(core))).toThrow();
  expect(() =>
    core.remove(f.b.identity.id, f.a.identity.id, [], f.nextDirectory(core, f.b.identity.id)),
  ).toThrow();
  expect(core.since(f.b.identity.id, 0)).toEqual([]);
});
it("refuses tampered signatures, rooms, roles and delegations", async () => {
  const s = await f.post(1);
  expect(core.post({ ...s, ciphertext: `${s.ciphertext.slice(0, -1)}AA` })).toEqual({
    refused: "bad-signature",
  });
  expect(core.post({ ...s, room: "elsewhere" })).toEqual({ refused: "bad-signature" });
  const agent = await f.post(2, f.a.agent);
  expect(core.post(agent)).toEqual({ seq: 1 });
  expect(core.post({ ...agent, sender: { id: f.a.agent.id, kind: "human" } })).toEqual({
    refused: "bad-signature",
  });
  expect(
    core.post({
      ...agent,
      sender: { ...agent.sender, delegation: { ...f.a.delegation, agentName: "fake" } },
    }),
  ).toEqual({ refused: "bad-signature" });
});
it("limits each sender to 30 posts per minute and releases the window", async () => {
  for (let i = 1; i <= 30; i++) expect(core.post(await f.post(i))).toEqual({ seq: i });
  expect(core.post(await f.post(31))).toEqual({ refused: "rate-limited" });
  now += 60_000;
  expect(core.post(await f.post(31))).toEqual({ seq: 31 });
});
it("rotates epochs and revokes history, grants and presence on removal", async () => {
  await approve();
  core.setPresence(f.b.agent.id, "online");
  const rotation = await f.rotate(core.members(), f.b.identity.id, 1);
  core.remove(
    f.a.identity.id,
    f.b.identity.id,
    rotation.grants,
    f.nextDirectory(core, f.b.identity.id),
  );
  expect(core.post(await f.post(1))).toEqual({ refused: "stale-epoch" });
  expect(core.post(await f.post(2, f.a.identity, 1))).toEqual({ seq: 1 });
  expect(core.post(await f.post(3, f.b.identity, 1))).toEqual({ refused: "unknown-sender" });
  expect(core.since(f.b.identity.id, 0)).toEqual([]);
  expect(core.grantsFor(f.b.identity.id)).toEqual([]);
  expect(core.presence()[f.b.agent.id]).toBeUndefined();
  expect(core.grantsFor(f.a.identity.id)).toEqual(
    rotation.grants.filter((g) => g.memberId === f.a.identity.id),
  );
});
it("orders by relay sequence despite skewed clocks and resumes after restart", async () => {
  for (let i = 1; i <= 7; i++)
    core.post(await f.post(i, f.a.identity, 0, new Date(10_000 - i * 1000).toISOString()));
  const rebuilt = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
    storage,
  });
  expect(rebuilt.since(f.a.identity.id, 5).map((m) => m.seq)).toEqual([6, 7]);
  expect(rebuilt.post(await f.post(8))).toEqual({ seq: 8 });
  expect(rebuilt.since(f.a.identity.id, 5).map((m) => m.seq)).toEqual([6, 7, 8]);
});
it("persists pending members, tokens and grants but resets presence", async () => {
  const token = core.issueToken(f.a.identity.id);
  core.requestJoin(token, f.b.member);
  core.setPresence(f.a.agent.id, "busy");
  const rebuilt = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
    storage,
  });
  expect(rebuilt.pending()).toEqual([f.b.member]);
  expect(rebuilt.requestJoin(token, f.b.member)).toBe("used");
  expect(rebuilt.presence()).toEqual({});
  rebuilt.setPresence(f.a.agent.id, "busy");
  now += 91_000;
  expect(rebuilt.presence()[f.a.agent.id]?.status).toBe("gone");
});
it("keeps only 5000 messages without resetting sequence numbers", async () => {
  core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: () => now,
    maxPerMinute: 6000,
  });
  const s = await f.post(1);
  for (let i = 0; i < 5002; i++) core.post(s);
  const log = core.since(f.a.identity.id, 0);
  expect(log).toHaveLength(5000);
  expect(log[0]?.seq).toBe(3);
  expect(log.at(-1)?.seq).toBe(5002);
});
it("does not let callers mutate membership or stored envelopes", async () => {
  const s = await f.post(1);
  core.post(s);
  s.ciphertext = "changed";
  core.members()[0].agents.length = 0;
  expect(core.members()[0]?.agents).toHaveLength(1);
  const log = core.since(f.a.identity.id, 0);
  log[0].sealed.ciphertext = "changed";
  expect(core.since(f.a.identity.id, 0)[0]?.sealed.ciphertext).not.toBe("changed");
});

it("expires and prunes unused and consumed invite tokens", async () => {
  const unused = core.issueToken(f.a.identity.id);
  const used = await approve();
  now += TOKEN_TTL_MS;
  expect(core.requestJoin(unused, f.b.member)).toBe("unknown");
  expect(core.requestJoin(used, f.b.member)).toBe("unknown");
  expect(saved?.tokens).toEqual({});
  const fresh = core.issueToken(f.a.identity.id);
  expect(saved?.tokens[fresh].expiresAt).toBe(now + TOKEN_TTL_MS);
});
it("rate limits presence without writing storage", () => {
  const snapshot = structuredClone(saved);
  expect(core.setPresence(f.a.agent.id, "online")).toBe(true);
  expect(core.setPresence(f.a.agent.id, "busy")).toBe(false);
  expect(saved).toEqual(snapshot);
  now += PRESENCE_INTERVAL_MS;
  expect(core.setPresence(f.a.agent.id, "busy")).toBe(true);
});

it("persists request timestamps, rejects replays after reload, and prunes expired nonces", () => {
  expect(core.useRequest("first", now)).toBe(true);
  expect(saved?.usedRequests).toEqual([{ nonce: "first", at: now }]);
  const restored = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    now: () => now,
    storage: {
      load: () => saved,
      save: (state) => {
        saved = state;
      },
    },
  });
  expect(restored.useRequest("first", now)).toBe(false);
  now += 2 * AUTH_CLOCK_SKEW_MS;
  expect(restored.useRequest("boundary", now)).toBe(true);
  expect(saved?.usedRequests).toHaveLength(2);
  now++;
  expect(restored.useRequest("new", now)).toBe(true);
  expect(saved?.usedRequests?.map((r) => r.nonce)).toEqual(["boundary", "new"]);
});
