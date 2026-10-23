import { scanText } from "@mc/core";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { type Delegation, type Identity, verifyDelegation } from "./keys.ts";
import { ready, type Sodium } from "./sodium.ts";

export const BODY_MAX = 32_000;

export type Kind = "question" | "answer" | "fyi" | "request" | "decision";
export type Knowledge =
  | { kind: "checked"; source: string; asOf: string }
  | { kind: "from-notes"; asOf: string }
  | { kind: "cannot-confirm" };
export type Message = {
  id: string;
  room: string;
  thread: string;
  inReplyTo?: string;
  kind: Kind;
  body: string;
  refs?: string[];
  knowledge?: Knowledge;
  urgency?: "low" | "normal" | "high";
  replyBy?: string;
  needsHuman?: boolean;
  auto: boolean;
  reason?: string;
  requestedBy?: { kind: "human" | "agent"; name: string };
  sentAt: string;
};
export type Sender = { id: string; kind: "human" | "agent"; delegation?: Delegation };
export type Sealed = {
  room: string;
  sender: Sender;
  keyEpoch: number;
  nonce: string;
  ciphertext: string;
  sig: string;
};

export class BodyTooLarge extends Error {
  override name = "BodyTooLarge";
  constructor() {
    super("Message body exceeds 32000 UTF-8 bytes");
  }
}
export class BadSignature extends Error {
  override name = "BadSignature";
  constructor() {
    super("Unknown signing key or malformed signature");
  }
}
export class WrongSender extends Error {
  override name = "WrongSender";
  constructor() {
    super("Sender metadata or delegation is invalid");
  }
}
export class BadCiphertext extends Error {
  override name = "BadCiphertext";
  constructor() {
    super("Envelope authentication or ciphertext is invalid");
  }
}
export class HeldMessage extends Error {
  override name = "HeldMessage";
  readonly held = true;
  constructor() {
    super("Message held because its body contains a possible secret");
  }
}

const delegationSchema = z.strictObject({
  agentId: z.string(),
  memberId: z.string(),
  subscription: z.string(),
  agentName: z.string(),
  sig: z.string(),
});
const senderSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["human", "agent"]),
  delegation: delegationSchema.optional(),
});
const messageSchema = z.strictObject({
  id: z.string(),
  room: z.string(),
  thread: z.string(),
  inReplyTo: z.string().optional(),
  kind: z.enum(["question", "answer", "fyi", "request", "decision"]),
  body: z.string(),
  refs: z.array(z.string()).optional(),
  knowledge: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("checked"), source: z.string(), asOf: z.string() }),
      z.strictObject({ kind: z.literal("from-notes"), asOf: z.string() }),
      z.strictObject({ kind: z.literal("cannot-confirm") }),
    ])
    .optional(),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  replyBy: z.string().optional(),
  needsHuman: z.boolean().optional(),
  auto: z.boolean(),
  reason: z.string().optional(),
  requestedBy: z.strictObject({ kind: z.enum(["human", "agent"]), name: z.string() }).optional(),
  sentAt: z.string(),
});

type PublicKeyOf = (id: string) => Uint8Array | undefined;

function encode(sodium: Sodium, bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function decode(sodium: Sodium, value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new BadCiphertext();
  const bytes = sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
  if (encode(sodium, bytes) !== value) throw new BadCiphertext();
  return bytes;
}

function signaturePayload(s: Sealed): string {
  return `${s.room}|${s.sender.id}|${s.keyEpoch}|${s.nonce}|${s.ciphertext}`;
}

function aad(s: Pick<Sealed, "room" | "sender" | "keyEpoch">): string {
  return canonicalJson({ room: s.room, senderId: s.sender.id, keyEpoch: s.keyEpoch });
}

function snapshotSealed(s: Sealed): Sealed {
  if (!s?.sender) return s;
  return {
    ...s,
    sender: {
      ...s.sender,
      ...(s.sender.delegation ? { delegation: { ...s.sender.delegation } } : {}),
    },
  };
}

async function checkSender(sender: Sender, publicKeyOf: PublicKeyOf): Promise<void> {
  if (!senderSchema.safeParse(sender).success) throw new WrongSender();
  if (sender.kind === "human") {
    if (sender.delegation !== undefined) throw new WrongSender();
    return;
  }
  const d = sender.delegation;
  if (!d || d.agentId !== sender.id || d.memberId === sender.id) throw new WrongSender();
  const memberKey = publicKeyOf(d.memberId);
  if (!memberKey || !(await verifyDelegation(d, memberKey))) throw new WrongSender();
}

async function checkSignature(s: Sealed, publicKeyOf: PublicKeyOf): Promise<Sodium> {
  if (
    !s ||
    typeof s.room !== "string" ||
    !s.sender ||
    typeof s.sender.id !== "string" ||
    !Number.isSafeInteger(s.keyEpoch) ||
    s.keyEpoch < 0 ||
    typeof s.nonce !== "string" ||
    typeof s.ciphertext !== "string"
  )
    throw new BadCiphertext();
  const sodium = await ready();
  let sig: Uint8Array;
  try {
    sig = decode(sodium, s.sig);
    if (sig.length !== sodium.crypto_sign_BYTES) throw new BadSignature();
  } catch {
    throw new BadSignature();
  }
  const key = publicKeyOf(s.sender.id);
  if (
    !key ||
    key.length !== sodium.crypto_sign_PUBLICKEYBYTES ||
    encode(sodium, key) !== s.sender.id
  )
    throw new BadSignature();
  // A well-formed signature that fails authentication is a corrupt envelope.
  if (!sodium.crypto_sign_verify_detached(sig, signaturePayload(s), key)) throw new BadCiphertext();
  try {
    if (
      decode(sodium, s.nonce).length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES ||
      decode(sodium, s.ciphertext).length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
    )
      throw new BadCiphertext();
  } catch {
    throw new BadCiphertext();
  }
  return sodium;
}

export async function seal(
  msg: Message,
  from: Identity,
  roomKey: Uint8Array,
  keyEpoch: number,
  delegation?: Delegation,
): Promise<Sealed> {
  const parsed = messageSchema.safeParse(msg);
  if (!parsed.success) throw new BadCiphertext();
  const message = parsed.data;
  if (Buffer.byteLength(message.body, "utf8") > BODY_MAX) throw new BodyTooLarge();
  if (scanText("message body", message.body, []).length > 0) throw new HeldMessage();
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) throw new BadCiphertext();
  const parsedSender = senderSchema.safeParse({ id: from.id, kind: from.kind, delegation });
  if (!parsedSender.success) throw new WrongSender();
  const sender = parsedSender.data;
  // Retain only snapshots across awaits so encryption uses the body that was scanned.
  const publicKey = Uint8Array.from(from.sign.publicKey);
  const privateKey = Uint8Array.from(from.sign.privateKey);
  const encryptionKey = Uint8Array.from(roomKey);
  const sodium = await ready();
  if (encode(sodium, publicKey) !== sender.id) throw new WrongSender();
  await checkSender(sender, (id) => {
    try {
      return decode(sodium, id);
    } catch {
      return undefined;
    }
  });
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const header = { room: message.room, sender, keyEpoch };
  // Authenticate sender metadata inside the ciphertext without changing the signature format.
  // Trusted key-to-role enforcement still requires a membership-aware key lookup.
  let ciphertext: Uint8Array;
  try {
    ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      canonicalJson({ message, sender }),
      aad(header),
      null,
      nonce,
      encryptionKey,
    );
  } catch {
    throw new BadCiphertext();
  }
  const sealed = {
    ...header,
    nonce: encode(sodium, nonce),
    ciphertext: encode(sodium, ciphertext),
    sig: "",
  };
  sealed.sig = encode(sodium, sodium.crypto_sign_detached(signaturePayload(sealed), privateKey));
  return sealed;
}

export async function open(
  s: Sealed,
  roomKey: Uint8Array,
  publicKeyOf: PublicKeyOf,
): Promise<Message> {
  const sealed = snapshotSealed(s);
  let decryptionKey: Uint8Array;
  try {
    decryptionKey = Uint8Array.from(roomKey);
  } catch {
    throw new BadCiphertext();
  }
  const sodium = await checkSignature(sealed, publicKeyOf);
  await checkSender(sealed.sender, publicKeyOf);
  let payload: unknown;
  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      decode(sodium, sealed.ciphertext),
      aad(sealed),
      decode(sodium, sealed.nonce),
      decryptionKey,
    );
    payload = JSON.parse(sodium.to_string(plaintext));
  } catch {
    throw new BadCiphertext();
  }
  if (!payload || typeof payload !== "object" || !("message" in payload) || !("sender" in payload))
    throw new BadCiphertext();
  if (canonicalJson(payload.sender) !== canonicalJson(sealed.sender)) throw new WrongSender();
  const result = messageSchema.safeParse(payload.message);
  if (
    !result.success ||
    result.data.room !== sealed.room ||
    Buffer.byteLength(result.data.body, "utf8") > BODY_MAX
  )
    throw new BadCiphertext();
  return result.data;
}

export async function verifySealed(s: Sealed, publicKeyOf: PublicKeyOf): Promise<boolean> {
  try {
    const sealed = snapshotSealed(s);
    await checkSignature(sealed, publicKeyOf);
    return senderSchema.safeParse(sealed.sender).success;
  } catch {
    return false;
  }
}
