import { beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import {
  BadCiphertext,
  BadSignature,
  BODY_MAX,
  BodyTooLarge,
  HeldMessage,
  type Message,
  open,
  type Sealed,
  seal,
  verifySealed,
  WrongSender,
} from "../src/envelope.ts";
import { type Delegation, delegate, type Identity, newIdentity } from "../src/keys.ts";
import { ready } from "../src/sodium.ts";

let human: Identity;
let agent: Identity;
let other: Identity;
let delegation: Delegation;
let roomKey: Uint8Array;
const lookup = (id: string) =>
  [human, agent, other].find((person) => person.id === id)?.sign.publicKey;
const message: Message = {
  id: "message-1",
  room: "room-1",
  thread: "thread-1",
  inReplyTo: "message-0",
  kind: "answer",
  body: "Checked the implementation.",
  refs: ["src/main.ts:12"],
  knowledge: { kind: "checked", source: "test run", asOf: "2026-10-24T12:00:00Z" },
  urgency: "high",
  replyBy: "2026-10-25T12:00:00Z",
  needsHuman: true,
  auto: false,
  reason: "Review requested",
  requestedBy: { kind: "human", name: "Alice" },
  sentAt: "2026-10-24T12:01:00Z",
};

beforeAll(async () => {
  human = await newIdentity("human", "Alice");
  agent = await newIdentity("agent", "Helper");
  other = await newIdentity("human", "Bob");
  delegation = await delegate(human, agent, "team", "Helper");
  roomKey = (await ready()).randombytes_buf(32);
});

async function resign(s: Sealed, identity = human): Promise<Sealed> {
  const sodium = await ready();
  const payload = `agentcomms/message/v1|${s.room}|${s.sender.id}|${s.keyEpoch}|${s.nonce}|${s.ciphertext}`;
  return {
    ...s,
    sig: sodium.to_base64(
      sodium.crypto_sign_detached(payload, identity.sign.privateKey),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    ),
  };
}

describe("sealed envelopes", () => {
  it.each(["human", "agent"] as const)(
    "round trips all optional message fields for a %s",
    async (kind) => {
      const sender = kind === "human" ? human : agent;
      const s = await seal(message, sender, roomKey, 3, kind === "agent" ? delegation : undefined);
      expect(s.room).toBe(message.room);
      expect(s.sender).toEqual({
        id: sender.id,
        kind,
        ...(kind === "agent" ? { delegation } : {}),
      });
      expect(s.keyEpoch).toBe(3);
      expect(await open(s, roomKey, lookup)).toEqual(message);
      for (const encoded of [s.nonce, s.ciphertext, s.sig])
        expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(s.nonce, "base64url")).toHaveLength(24);
      expect(Buffer.from(s.sig, "base64url")).toHaveLength(64);
      expect(s.ciphertext).not.toContain(message.body);
    },
  );

  it("supports minimal messages and the other knowledge variants", async () => {
    for (const knowledge of [
      undefined,
      { kind: "from-notes", asOf: "today" },
      { kind: "cannot-confirm" },
    ] as const) {
      const minimal: Message = {
        id: "m",
        room: "r",
        thread: "t",
        kind: "fyi",
        body: "",
        auto: true,
        sentAt: "now",
        knowledge,
      };
      expect(await open(await seal(minimal, human, roomKey, 0), roomKey, lookup)).toEqual(minimal);
    }
  });

  it("uses a fresh nonce for repeated messages", async () => {
    const a = await seal(message, human, roomKey, 1);
    const b = await seal(message, human, roomKey, 1);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it.each(["secret", "oversize"])(
    "seals the validated snapshot despite a later %s mutation",
    async (change) => {
      const draft = structuredClone(message);
      const pending = seal(draft, human, roomKey, 1);
      draft.body = change === "secret" ? `ghp_${"x".repeat(36)}` : "a".repeat(BODY_MAX + 1);
      draft.room = "changed-room";
      draft.refs?.push("changed-reference");
      if (draft.knowledge?.kind === "checked") draft.knowledge.source = "changed-source";
      expect(await open(await pending, roomKey, lookup)).toEqual(message);
    },
  );

  it("snapshots sender metadata and delegation before yielding", async () => {
    const sender = structuredClone(agent);
    const supplied = { ...delegation };
    const pending = seal(message, sender, roomKey, 1, supplied);
    sender.id = other.id;
    sender.kind = "human";
    supplied.agentName = "changed-name";
    const s = await pending;
    expect(s.sender).toEqual({ id: agent.id, kind: "agent", delegation });
    expect(await open(s, roomKey, lookup)).toEqual(message);
  });

  it.each(["ascii", "multibyte"])(
    "enforces the UTF-8 byte limit for %s bodies",
    async (encoding) => {
      expect(BODY_MAX).toBe(32_000);
      const body = encoding === "ascii" ? "a".repeat(BODY_MAX) : "é".repeat(BODY_MAX / 2);
      const s = await seal({ ...message, body }, human, roomKey, 1);
      expect((await open(s, roomKey, lookup)).body).toBe(body);
      await expect(
        seal({ ...message, body: `${body}a` }, human, roomKey, 1),
      ).rejects.toBeInstanceOf(BodyTooLarge);
    },
  );

  it("verifies the literal detached signature without a room key", async () => {
    const s = await seal(message, human, roomKey, 1);
    expect(await verifySealed(s, lookup)).toBe(true);
    const sodium = await ready();
    expect(
      sodium.crypto_sign_verify_detached(
        Buffer.from(s.sig, "base64url"),
        `agentcomms/message/v1|${s.room}|${s.sender.id}|${s.keyEpoch}|${s.nonce}|${s.ciphertext}`,
        human.sign.publicKey,
      ),
    ).toBe(true);
  });

  it("rejects oversized bodies before checking for secrets", async () => {
    const body = `ghp_${"x".repeat(36)} ${"a".repeat(BODY_MAX)}`;
    await expect(seal({ ...message, body }, human, roomKey, 1)).rejects.toBeInstanceOf(
      BodyTooLarge,
    );
  });

  it("rejects a signing key that does not match the sender id", async () => {
    const s = await seal(message, human, roomKey, 1);
    await expect(open(s, roomKey, () => other.sign.publicKey)).rejects.toBeInstanceOf(BadSignature);
    expect(await verifySealed(s, () => other.sign.publicKey)).toBe(false);
  });

  it("rejects a flipped ciphertext byte before decryption", async () => {
    const s = await seal(message, human, roomKey, 1);
    const bytes = Buffer.from(s.ciphertext, "base64url");
    bytes[0] ^= 1;
    s.ciphertext = bytes.toString("base64url");
    const sodium = await ready();
    const decrypt = vi.spyOn(sodium, "crypto_aead_xchacha20poly1305_ietf_decrypt");
    try {
      await expect(open(s, roomKey, lookup)).rejects.toBeInstanceOf(BadSignature);
      expect(await verifySealed(s, lookup)).toBe(false);
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
  });

  it("rejects another room key", async () => {
    const s = await seal(message, human, roomKey, 1);
    await expect(open(s, (await ready()).randombytes_buf(32), lookup)).rejects.toBeInstanceOf(
      BadCiphertext,
    );
  });

  it("decrypts the same envelope snapshot whose signature was checked", async () => {
    const s = await seal(message, human, roomKey, 1);
    const replacement = await seal({ ...message, body: "Unsigned replacement" }, human, roomKey, 1);
    replacement.sig = Buffer.alloc(64).toString("base64url");
    const mutateAfterLookup = (id: string) => {
      queueMicrotask(() => Object.assign(s, replacement));
      return lookup(id);
    };
    expect(await open(s, roomKey, mutateAfterLookup)).toEqual(message);
    expect(await verifySealed(s, lookup)).toBe(false);
  });

  it.each(["room", "sender", "keyEpoch", "nonce"])(
    "binds %s in the signature and encryption",
    async (field) => {
      const s = await seal(message, human, roomKey, 1);
      if (field === "room") s.room = "another-room";
      if (field === "sender") s.sender = { id: other.id, kind: "human" };
      if (field === "keyEpoch") s.keyEpoch = 2;
      if (field === "nonce") s.nonce = Buffer.alloc(24, 7).toString("base64url");
      expect(await verifySealed(s, lookup)).toBe(false);
      await expect(open(s, roomKey, lookup)).rejects.toBeInstanceOf(BadSignature);
      const signed = await resign(s, field === "sender" ? other : human);
      expect(await verifySealed(signed, lookup)).toBe(true);
      await expect(open(signed, roomKey, lookup)).rejects.toBeInstanceOf(BadCiphertext);
    },
  );

  it("rejects an agent relabelled as human, even with delegation removed", async () => {
    const s = await seal(message, agent, roomKey, 1, delegation);
    for (const sender of [
      { ...s.sender, kind: "human" as const },
      { id: agent.id, kind: "human" as const },
    ]) {
      await expect(open({ ...s, sender }, roomKey, lookup)).rejects.toBeInstanceOf(WrongSender);
    }
  });

  it("rejects a human relabelled as an agent, even with a valid delegation", async () => {
    const s = await seal(message, human, roomKey, 1);
    const valid = await delegate(other, { ...human, kind: "agent" }, "team", "Impostor");
    for (const supplied of [undefined, valid]) {
      await expect(
        open(
          { ...s, sender: { id: human.id, kind: "agent", delegation: supplied } },
          roomKey,
          lookup,
        ),
      ).rejects.toBeInstanceOf(WrongSender);
    }
  });

  it("rejects missing, tampered, mismatched, and self-issued agent delegations", async () => {
    const s = await seal(message, agent, roomKey, 1, delegation);
    const self = await delegate({ ...agent, kind: "human" }, agent, "team", "Self");
    for (const supplied of [
      undefined,
      { ...delegation, sig: "invalid" },
      { ...delegation, agentId: other.id },
      { ...delegation, agentName: "changed" },
      self,
    ]) {
      await expect(
        open({ ...s, sender: { ...s.sender, delegation: supplied } }, roomKey, lookup),
      ).rejects.toBeInstanceOf(WrongSender);
    }
    await expect(
      open(s, roomKey, (id) => (id === human.id ? undefined : lookup(id))),
    ).rejects.toBeInstanceOf(WrongSender);
    await expect(
      open(s, roomKey, (id) => (id === human.id ? other.sign.publicKey : lookup(id))),
    ).rejects.toBeInstanceOf(WrongSender);
    await expect(seal(message, agent, roomKey, 1)).rejects.toBeInstanceOf(WrongSender);
    await expect(seal(message, human, roomKey, 1, delegation)).rejects.toBeInstanceOf(WrongSender);
  });

  it("rejects unknown signers and malformed signatures as BadSignature", async () => {
    const s = await seal(message, human, roomKey, 1);
    await expect(open(s, roomKey, () => undefined)).rejects.toBeInstanceOf(BadSignature);
    expect(await verifySealed(s, () => undefined)).toBe(false);
    for (const sig of ["", "!invalid", "AA", `${s.sig}=`]) {
      const invalid = { ...s, sig };
      await expect(open(invalid, roomKey, lookup)).rejects.toBeInstanceOf(BadSignature);
      expect(await verifySealed(invalid, lookup)).toBe(false);
    }
  });

  it("rejects a well-formed but invalid signature as BadSignature", async () => {
    const s = await seal(message, human, roomKey, 1);
    s.sig = Buffer.alloc(64).toString("base64url");
    await expect(open(s, roomKey, lookup)).rejects.toBeInstanceOf(BadSignature);
    expect(await verifySealed(s, lookup)).toBe(false);
  });

  it.each(["ciphertext", "nonce", "epoch", "shape"])(
    "rejects malformed %s envelopes",
    async (field) => {
      const s = await seal(message, human, roomKey, 1);
      const invalid =
        field === "shape"
          ? (null as unknown as Sealed)
          : await resign({
              ...s,
              ...(field === "ciphertext"
                ? { ciphertext: "!bad" }
                : field === "nonce"
                  ? { nonce: "AA" }
                  : { keyEpoch: -1 }),
            });
      await expect(open(invalid, roomKey, lookup)).rejects.toBeInstanceOf(BadCiphertext);
      expect(await verifySealed(invalid, lookup)).toBe(false);
    },
  );

  it("rejects authenticated malformed plaintext and a mismatched message room", async () => {
    const sodium = await ready();
    const s = await seal(message, human, roomKey, 1);
    for (const plaintext of [
      "not json",
      canonicalJson({ message: { ...message, body: 123 }, sender: s.sender }),
      canonicalJson({ message: { ...message, room: "wrong" }, sender: s.sender }),
    ]) {
      const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        canonicalJson({ room: s.room, senderId: s.sender.id, keyEpoch: s.keyEpoch }),
        null,
        Buffer.from(s.nonce, "base64url"),
        roomKey,
      );
      const invalid = await resign({
        ...s,
        ciphertext: Buffer.from(ciphertext).toString("base64url"),
      });
      await expect(open(invalid, roomKey, lookup)).rejects.toBeInstanceOf(BadCiphertext);
    }
  });

  it("holds secret-bearing outgoing bodies without encrypting or leaking the body", async () => {
    const secret = `ghp_${"x".repeat(36)}`;
    const sodium = await ready();
    const encrypt = vi.spyOn(sodium, "crypto_aead_xchacha20poly1305_ietf_encrypt");
    try {
      const error = await seal({ ...message, body: `private ${secret}` }, human, roomKey, 1).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(HeldMessage);
      expect(error).toMatchObject({ held: true });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(encrypt).not.toHaveBeenCalled();
    } finally {
      encrypt.mockRestore();
    }
  });
});
