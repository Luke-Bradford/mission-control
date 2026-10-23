import { z } from "zod";
import type { Delegation, Identity } from "./keys.ts";
import { ready } from "./sodium.ts";

export type Invite = {
  relay: string;
  room: string;
  // The issuer supplies 32 random bytes encoded as unpadded base64url.
  token: string;
};

export type Member = {
  id: string;
  kind: "human";
  label: string;
  boxPublicKey: string;
  signPublicKey: string;
  agents: {
    id: string;
    name: string;
    subscription: string;
    signPublicKey: string;
    delegation: Delegation;
  }[];
};

export type KeyGrant = { memberId: string; keyEpoch: number; wrapped: string };

export class BadInvite extends Error {
  override name = "BadInvite";
  constructor() {
    super("Invite format or token is invalid");
  }
}

const inviteSchema = z.strictObject({
  relay: z.string().min(1),
  room: z.string().min(1),
  token: z.string(),
});

function decodeBase64url(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url encoding");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Invalid base64url encoding");
  return bytes;
}

function parseInvite(value: unknown): Invite {
  const parsed = inviteSchema.safeParse(value);
  if (!parsed.success || decodeBase64url(parsed.data.token).length !== 32) throw new BadInvite();
  return parsed.data;
}

export function encodeInvite(i: Invite): string {
  try {
    const invite = parseInvite({ relay: i.relay, room: i.room, token: i.token });
    return `ac1.${Buffer.from(JSON.stringify(invite)).toString("base64url")}`;
  } catch {
    throw new BadInvite();
  }
}

export function decodeInvite(code: string): Invite {
  try {
    if (typeof code !== "string" || !code.startsWith("ac1.")) throw new BadInvite();
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64url(code.slice(4)));
    return parseInvite(JSON.parse(json));
  } catch {
    throw new BadInvite();
  }
}

function checkEpoch(keyEpoch: number): void {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) throw new Error("Invalid key epoch");
}

export async function newRoomKey(): Promise<Uint8Array> {
  const sodium = await ready();
  return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

export async function wrapRoomKey(
  roomKey: Uint8Array,
  keyEpoch: number,
  member: Member,
): Promise<KeyGrant> {
  checkEpoch(keyEpoch);
  if (!(roomKey instanceof Uint8Array)) throw new Error("Invalid room key");
  const key = Uint8Array.from(roomKey);
  const { id: memberId, boxPublicKey } = member;
  const sodium = await ready();
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error("Invalid room key");
  }
  const publicKey = decodeBase64url(boxPublicKey);
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error("Invalid member box key");
  }
  const wrapped = sodium.crypto_box_seal(key, publicKey);
  return { memberId, keyEpoch, wrapped: Buffer.from(wrapped).toString("base64url") };
}

export async function unwrapRoomKey(g: KeyGrant, me: Identity): Promise<Uint8Array> {
  const { memberId, keyEpoch, wrapped } = g;
  checkEpoch(keyEpoch);
  if (memberId !== me.id) throw new Error("Key grant belongs to another member");
  const publicKey = Uint8Array.from(me.box.publicKey);
  const privateKey = Uint8Array.from(me.box.privateKey);
  const sodium = await ready();
  const key = sodium.crypto_box_seal_open(decodeBase64url(wrapped), publicKey, privateKey);
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
    throw new Error("Invalid room key");
  }
  return key;
}

export async function rotate(
  members: Member[],
  removedId: string,
  nextEpoch: number,
): Promise<{ roomKey: Uint8Array; grants: KeyGrant[] }> {
  checkEpoch(nextEpoch);
  const remaining = members
    .filter((member) => member.id !== removedId)
    .map((member) => ({ ...member }));
  const roomKey = await newRoomKey();
  const grants = await Promise.all(
    remaining.map((member) => wrapRoomKey(roomKey, nextEpoch, member)),
  );
  return { roomKey, grants };
}
