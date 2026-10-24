import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const base64 = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const delegationSchema = z.strictObject({
  boxPublicKey: id,
  agentId: id,
  memberId: id,
  subscription: z.string(),
  agentName: z.string(),
  sig: base64,
});
export const memberSchema = z.strictObject({
  id,
  sig: base64,
  kind: z.literal("human"),
  label: z.string(),
  boxPublicKey: id,
  signPublicKey: id,
  agents: z.array(
    z.strictObject({
      id,
      name: z.string(),
      subscription: z.string(),
      signPublicKey: id,
      boxPublicKey: id,
      delegation: delegationSchema,
    }),
  ),
});
export const keyGrantSchema = z.strictObject({
  memberId: id,
  keyEpoch: epoch,
  wrapped: base64,
  sig: base64.optional(),
});
export const sealedSchema = z.strictObject({
  room: z.string().min(1),
  sender: z.strictObject({
    id,
    kind: z.enum(["human", "agent"]),
    delegation: delegationSchema.optional(),
  }),
  keyEpoch: epoch,
  nonce: base64,
  ciphertext: base64,
  sig: base64,
});
export const helloSchema = z.strictObject({
  t: z.literal("hello"),
  room: z.string().min(1),
  memberId: id,
  sig: base64,
  challenge: base64,
});
const messageId = z.string().min(1).max(200);
const grants = z.array(keyGrantSchema);
export const directorySchema = z.strictObject({
  room: z.string().min(1),
  members: z.array(memberSchema),
  activeMemberIds: z.array(id),
  keyEpoch: epoch,
  version: epoch,
  sig: base64,
});
export const controlSchema = z.strictObject({
  memberId: id,
  grants,
  directory: directorySchema,
  sig: base64,
});
export const tokenSchema = z.strictObject({ memberId: id, nonce: base64, at: epoch, sig: base64 });
export const clientMessageSchema = z.discriminatedUnion("t", [
  helloSchema,
  z.strictObject({ t: z.literal("post"), id: messageId.optional(), sealed: sealedSchema }),
  z.strictObject({ t: z.literal("since"), seq: epoch }),
  z.strictObject({ t: z.literal("presence"), status: z.enum(["online", "busy", "away"]) }),
  z.strictObject({ t: z.literal("join"), token: base64, member: memberSchema }),
  controlSchema.extend({ t: z.literal("approve") }),
  controlSchema.extend({ t: z.literal("remove") }),
]);
export const relayMessageSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("challenge"), challenge: base64 }),
  directorySchema.extend({ t: z.literal("directory") }),
  z.strictObject({ t: z.literal("pending"), members: z.array(memberSchema) }),
  z.strictObject({ t: z.literal("msg"), seq: epoch, sealed: sealedSchema }),
  z.strictObject({ t: z.literal("grants"), grants }),
  z.strictObject({ t: z.literal("gap"), from: epoch, to: epoch }),
  z.strictObject({ t: z.literal("reset"), relaySeq: epoch }),
  z.strictObject({ t: z.literal("more"), seq: epoch }),
  z.strictObject({ t: z.literal("refused"), reason: z.string(), id: messageId.optional() }),
  z.strictObject({
    t: z.literal("presence"),
    map: z.record(z.string(), z.strictObject({ status: z.string(), seenAt: epoch })),
  }),
]);
export const createRoomSchema = z.strictObject({
  owner: memberSchema,
  sig: base64,
  directory: directorySchema,
  grants: grants.optional(),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type Hello = z.infer<typeof helloSchema>;
