import { beforeAll, describe, expect, it } from "vitest";
import { signMember } from "../src/auth.ts";
import { BadCiphertext, type Message, open, seal } from "../src/envelope.ts";
import { type Identity, newIdentity } from "../src/keys.ts";
import {
  BadInvite,
  decodeInvite,
  encodeInvite,
  type Invite,
  type Member,
  newRoomKey,
  rotate,
  unwrapRoomKey,
  wrapMemberKeys,
  wrapRoomKey,
} from "../src/membership.ts";
import { ready } from "../src/sodium.ts";
import { fixture } from "./relay-fixtures.ts";

it("wraps approval and rotation keys to members and each agent independently", async () => {
  const f = await fixture();
  const grants = await wrapMemberKeys(f.key, 0, f.b.member);
  expect(grants.map((g) => g.memberId)).toEqual([f.b.identity.id, f.b.agent.id]);
  for (const identity of [f.b.identity, f.b.agent]) {
    const grant = grants.find((g) => g.memberId === identity.id);
    if (!grant) throw new Error("Missing grant");
    expect(await unwrapRoomKey(grant, identity)).toEqual(f.key);
    await expect(unwrapRoomKey(grant, f.a.agent)).rejects.toThrow();
  }
  const rotated = await rotate([f.a.member, f.b.member], f.b.identity.id, 1);
  expect(rotated.grants.map((g) => g.memberId)).toEqual([f.a.identity.id, f.a.agent.id]);
  expect(await unwrapRoomKey(rotated.grants[1], f.a.agent)).toEqual(rotated.roomKey);
});

let alice: Identity;
let bob: Identity;
let offline: Identity;
let invite: Invite;

function member(identity: Identity): Member {
  return signMember(
    {
      sig: "",
      id: identity.id,
      kind: "human",
      label: identity.label,
      boxPublicKey: Buffer.from(identity.box.publicKey).toString("base64url"),
      signPublicKey: Buffer.from(identity.sign.publicKey).toString("base64url"),
      agents: [],
    },
    identity,
  );
}

function code(value: unknown): string {
  return `ac1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

beforeAll(async () => {
  alice = await newIdentity("human", "Alice");
  bob = await newIdentity("human", "Bob");
  offline = await newIdentity("human", "Offline member");
  const sodium = await ready();
  invite = {
    ownerId: alice.id,
    relay: "wss://relay.example.test",
    room: "room-1",
    token: sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING),
  };
});

describe("invites", () => {
  it("round trips the supplied token using the ac1 base64url format", () => {
    const encoded = encodeInvite(invite);
    expect(encoded).toMatch(/^ac1\.[A-Za-z0-9_-]+$/);
    expect(decodeInvite(encoded)).toEqual(invite);
    expect(Buffer.from(decodeInvite(encoded).token, "base64url")).toHaveLength(32);
  });

  it("encodes exactly relay, room, and token even with extra runtime key material", async () => {
    const extra = { ...invite, roomKey: await newRoomKey(), identity: alice };
    const encoded = encodeInvite(extra);
    const payload = JSON.parse(Buffer.from(encoded.slice(4), "base64url").toString("utf8"));
    expect(Object.keys(payload).sort()).toEqual(["ownerId", "relay", "room", "token"]);
    expect(payload).toEqual(invite);
    expect(decodeInvite(encoded)).toEqual(invite);
  });

  it.each(["x", "", "ac2.e30", "ac1.", "ac1.!bad", "ac1.e30=", "ac1.bm90IGpzb24"])(
    "rejects malformed code %j with BadInvite",
    (value) => {
      expect(() => decodeInvite(value)).toThrow(BadInvite);
    },
  );

  it("rejects invalid payload shapes and unexpected fields", () => {
    for (const value of [
      null,
      [],
      {},
      { ...invite, room: "" },
      { ...invite, relay: 1 },
      { ...invite, relay: "" },
      { relay: invite.relay, room: invite.room },
      { ...invite, roomKey: "unexpected" },
    ]) {
      expect(() => decodeInvite(code(value))).toThrow(BadInvite);
    }
  });

  it("requires canonical unpadded base64url tokens containing 32 bytes", () => {
    for (const token of [
      "",
      "!invalid",
      Buffer.alloc(31).toString("base64url"),
      Buffer.alloc(33).toString("base64url"),
      `${invite.token}=`,
      `${"A".repeat(42)}B`,
      "/".repeat(43),
    ]) {
      expect(() => encodeInvite({ ...invite, token })).toThrow(BadInvite);
      expect(() => decodeInvite(code({ ...invite, token }))).toThrow(BadInvite);
    }
  });
});

describe("room keys", () => {
  it("generates independent keys of the AEAD key size", async () => {
    const sodium = await ready();
    const first = await newRoomKey();
    const second = await newRoomKey();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first).toHaveLength(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    expect(first).not.toEqual(second);
  });

  it("wraps the raw room key as a sealed box for only the recipient", async () => {
    const sodium = await ready();
    const roomKey = await newRoomKey();
    const grant = await wrapRoomKey(roomKey, 0, member(alice));
    expect(Object.keys(grant).sort()).toEqual(["keyEpoch", "memberId", "wrapped"]);
    expect(grant).toMatchObject({ memberId: alice.id, keyEpoch: 0 });
    expect(grant.wrapped).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(grant.wrapped, "base64url")).toHaveLength(
      roomKey.length + sodium.crypto_box_SEALBYTES,
    );
    expect(
      sodium.crypto_box_seal_open(
        Buffer.from(grant.wrapped, "base64url"),
        alice.box.publicKey,
        alice.box.privateKey,
      ),
    ).toEqual(roomKey);
    expect(await unwrapRoomKey(grant, alice)).toEqual(roomKey);
    await expect(unwrapRoomKey(grant, bob)).rejects.toThrow();
    await expect(unwrapRoomKey({ ...grant, memberId: bob.id }, bob)).rejects.toThrow();
    const again = await wrapRoomKey(roomKey, 0, member(alice));
    expect(again.wrapped).not.toBe(grant.wrapped);
    expect(JSON.stringify(grant)).not.toContain(Buffer.from(roomKey).toString("base64url"));
  });

  it("rejects malformed or tampered sealed boxes and non-room-key plaintext", async () => {
    const sodium = await ready();
    const grant = await wrapRoomKey(await newRoomKey(), 1, member(alice));
    const tampered = Buffer.from(grant.wrapped, "base64url");
    tampered[0] ^= 1;
    const shortKey = sodium.crypto_box_seal(new Uint8Array(31), alice.box.publicKey);
    for (const wrapped of [
      "",
      "!bad",
      `${grant.wrapped}=`,
      "AA",
      tampered.toString("base64url"),
      Buffer.from(shortKey).toString("base64url"),
    ]) {
      await expect(unwrapRoomKey({ ...grant, wrapped }, alice)).rejects.toThrow();
    }
  });

  it("rejects invalid key lengths and recipient public keys", async () => {
    for (const length of [0, 31, 33]) {
      await expect(wrapRoomKey(new Uint8Array(length), 1, member(alice))).rejects.toThrow();
    }
    for (const boxPublicKey of ["", "!bad", "AA", `${member(alice).boxPublicKey}=`]) {
      await expect(
        wrapRoomKey(await newRoomKey(), 1, { ...member(alice), boxPublicKey }),
      ).rejects.toThrow();
    }
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid epoch %s in wrapping, unwrapping, and rotation",
    async (keyEpoch) => {
      const roomKey = await newRoomKey();
      const grant = await wrapRoomKey(roomKey, 1, member(alice));
      await expect(wrapRoomKey(roomKey, keyEpoch, member(alice))).rejects.toThrow();
      await expect(unwrapRoomKey({ ...grant, keyEpoch }, alice)).rejects.toThrow();
      await expect(rotate([], bob.id, keyEpoch)).rejects.toThrow();
    },
  );

  it("rotates for all remaining members, including one who recovers the grant later", async () => {
    const oldKey = await newRoomKey();
    const members = [member(alice), member(bob), member(offline)];
    const snapshot = structuredClone(members);
    const { roomKey, grants } = await rotate(members, bob.id, 2);
    expect(roomKey).not.toEqual(oldKey);
    expect(grants.map((grant) => grant.memberId).sort()).toEqual([alice.id, offline.id].sort());
    expect(grants.every((grant) => grant.keyEpoch === 2)).toBe(true);
    expect(members).toEqual(snapshot);
    const message: Message = {
      id: "message-1",
      room: "room-1",
      thread: "thread-1",
      kind: "fyi",
      body: "The review is ready.",
      auto: false,
      sentAt: "2026-10-24T12:00:00Z",
    };
    const lookup = (id: string) => (id === alice.id ? alice.sign.publicKey : undefined);
    const sealed = await seal(message, alice, roomKey, 2);
    await expect(open(sealed, oldKey, lookup)).rejects.toBeInstanceOf(BadCiphertext);
    for (const identity of [alice, offline]) {
      const grant = grants.find((value) => value.memberId === identity.id);
      expect(grant).toBeDefined();
      if (!grant) throw new Error("Missing grant");
      const recovered = await unwrapRoomKey(JSON.parse(JSON.stringify(grant)), identity);
      expect(recovered).toEqual(roomKey);
      expect(await open(sealed, recovered, lookup)).toEqual(message);
      await expect(unwrapRoomKey({ ...grant, memberId: bob.id }, bob)).rejects.toThrow();
    }
    expect((await rotate(members, bob.id, 3)).roomKey).not.toEqual(roomKey);
  });

  it("supports rotation with no remaining members", async () => {
    const result = await rotate([member(bob)], bob.id, 1);
    expect(result.roomKey).toHaveLength(32);
    expect(result.grants).toEqual([]);
  });
});
