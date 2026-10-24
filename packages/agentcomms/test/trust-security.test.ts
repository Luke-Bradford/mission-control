import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { signDirectory, signMember } from "../src/auth.ts";
import { validateMember } from "../src/relay-core.ts";
import { readRoomKeys, saveRoomKeys } from "../src/room-keys.ts";
import { acceptDirectory, readMembershipTrust, readTrust } from "../src/trust.ts";
import { fixture } from "./relay-fixtures.ts";

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});
it("B1: a self-signed member cannot substitute an agent box outside its delegation", async () => {
  const f = await fixture();
  const member = structuredClone(f.b.member);
  member.agents[0].boxPublicKey = f.a.member.boxPublicKey;
  expect(() => validateMember(signMember(member, f.b.identity))).toThrow(
    "Invalid agent delegation",
  );
});
it("B2: overlapping persisted snapshots and keys cannot erase a newer verified epoch", async () => {
  const f = await fixture();
  home = await mkdtemp(join(tmpdir(), "comms-trust-"));
  const invite = { room: "test-room", ownerId: f.a.member.id };
  const older = signDirectory("test-room", 1, 1, [f.a.member], f.a.identity);
  const newer = signDirectory("test-room", 2, 2, [f.a.member], f.a.identity);
  await Promise.all([acceptDirectory(home, invite, older), acceptDirectory(home, invite, newer)]);
  expect(await readTrust(home, invite)).toEqual(newer);
  expect(await acceptDirectory(home, invite, older)).toEqual(newer);
  await Promise.all([
    saveRoomKeys(home, invite.room, new Map([[1, f.key]])),
    saveRoomKeys(home, invite.room, new Map([[2, f.key]])),
  ]);
  expect([...(await readRoomKeys(home, invite.room)).keys()].sort()).toEqual([1, 2]);
  await expect(saveRoomKeys(home, invite.room, new Map([[2, new Uint8Array(32)]]))).rejects.toThrow(
    "Conflicting immutable local record",
  );
  expect((await readRoomKeys(home, invite.room)).get(2)).toEqual(Buffer.from(f.key));
});

it("derives removal from any verified active history and the newest stored directory", async () => {
  const f = await fixture();
  home = await mkdtemp(join(tmpdir(), "comms-trust-"));
  const invite = { room: "test-room", ownerId: f.a.member.id };
  const membership = () => readMembershipTrust(home, invite, f.b.member.id);
  expect(await membership()).toEqual({ directory: undefined, removed: false });
  await acceptDirectory(home, invite, f.directory);
  expect((await membership()).removed).toBe(false);
  const active = signDirectory("test-room", 0, 1, [f.a.member, f.b.member], f.a.identity);
  await acceptDirectory(home, invite, active);
  expect((await membership()).removed).toBe(false);
  for (const version of [2, 3])
    await acceptDirectory(
      home,
      invite,
      signDirectory("test-room", 1, version, [f.a.member], f.a.identity),
    );
  expect(await membership()).toMatchObject({ directory: { version: 3 }, removed: true });
  const reapproved = signDirectory("test-room", 1, 4, [f.a.member, f.b.member], f.a.identity);
  await acceptDirectory(home, invite, reapproved);
  expect(await membership()).toEqual({ directory: reapproved, removed: false });
});
