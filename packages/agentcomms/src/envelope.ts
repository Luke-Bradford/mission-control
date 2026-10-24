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
  boxPublicKey: z.string(),
  agentId: z.string(),
  memberId: z.string(),
  subscription: z.string(),
  agentName: z.string(),
  sig: z.string(),
});
const senderSchema = z.strictObject({
  id: z.string().max(200),
  kind: z.enum(["human", "agent"]),
  delegation: delegationSchema.optional(),
});
export const knowledgeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("checked"),
    source: z.string().max(2000),
    asOf: z.string().max(100),
  }),
  z.strictObject({ kind: z.literal("from-notes"), asOf: z.string().max(100) }),
  z.strictObject({ kind: z.literal("cannot-confirm") }),
]);
export const messageSchema = z.strictObject({
  id: z.string().max(200),
  room: z.string().max(200),
  thread: z.string().max(200),
  inReplyTo: z.string().max(200).optional(),
  kind: z.enum(["question", "answer", "fyi", "request", "decision"]),
  body: z.string(),
  refs: z.array(z.string().max(2000)).max(50).optional(),
  knowledge: knowledgeSchema.optional(),
  urgency: z.enum(["low", "normal", "high"]).optional(),
  replyBy: z.string().max(100).optional(),
  needsHuman: z.boolean().optional(),
  auto: z.boolean(),
  reason: z.string().max(2000).optional(),
  requestedBy: z
    .strictObject({ kind: z.enum(["human", "agent"]), name: z.string().max(200) })
    .optional(),
  sentAt: z.string().max(100),
});

export function scanMessage(message: Partial<Message>): boolean {
  const fields: [string, string | undefined][] = [
    ["body", message.body],
    ["reason", message.reason],
    ["thread", message.thread],
    ["inReplyTo", message.inReplyTo],
    ["requestedBy.name", message.requestedBy?.name],
    [
      "knowledge.source",
      message.knowledge?.kind === "checked" ? message.knowledge.source : undefined,
    ],
    [
      "knowledge.asOf",
      message.knowledge && "asOf" in message.knowledge ? message.knowledge.asOf : undefined,
    ],
    ["replyBy", message.replyBy],
    ["room", message.room],
    ["id", message.id],
    ["sentAt", message.sentAt],
    ...(message.refs ?? []).map((ref): [string, string] => ["refs", ref]),
  ];
  return fields.some(([name, text]) => text !== undefined && scanText(name, text, []).length > 0);
}

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
  return `agentcomms/message/v1|${s.room}|${s.sender.id}|${s.keyEpoch}|${s.nonce}|${s.ciphertext}`;
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

function checkSignature(s: Sealed, publicKeyOf: PublicKeyOf, sodium: Sodium, framing = true): void {
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
  if (!sodium.crypto_sign_verify_detached(sig, signaturePayload(s), key)) throw new BadSignature();
  if (!framing) return;
  try {
    if (
      decode(sodium, s.nonce).length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES ||
      decode(sodium, s.ciphertext).length < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
    )
      throw new BadCiphertext();
  } catch {
    throw new BadCiphertext();
  }
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
  if (scanMessage(message)) throw new HeldMessage();
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
  const sodium = await ready();
  checkSignature(sealed, publicKeyOf, sodium);
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

// The synchronous relay uses the same checks after awaiting sodium at module initialization.
export function verifySealedSync(s: Sealed, publicKeyOf: PublicKeyOf, sodium: Sodium): boolean {
  try {
    const sealed = snapshotSealed(s);
    checkSignature(sealed, publicKeyOf, sodium);
    return senderSchema.safeParse(sealed.sender).success;
  } catch {
    return false;
  }
}

export async function verifySealed(s: Sealed, publicKeyOf: PublicKeyOf): Promise<boolean> {
  const sealed = snapshotSealed(s);
  return verifySealedSync(sealed, publicKeyOf, await ready());
}

// Authentication alone lets the inbox quarantine signed, malformed metadata/ciphertext.
export async function verifyEnvelopeSignature(
  s: Sealed,
  publicKeyOf: PublicKeyOf,
): Promise<boolean> {
  try {
    const sealed = snapshotSealed(s);
    checkSignature(sealed, publicKeyOf, await ready(), false);
    return true;
  } catch {
    return false;
  }
}
