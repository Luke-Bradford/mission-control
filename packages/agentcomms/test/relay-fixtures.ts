import { type Message, seal } from "../src/envelope.ts";
import { delegate, type Identity, newIdentity } from "../src/keys.ts";
import { type Member, newRoomKey } from "../src/membership.ts";

export async function person(label: string) {
  const identity = await newIdentity("human", label);
  const agent = await newIdentity("agent", `${label}-agent`);
  const delegation = await delegate(identity, agent, label, agent.label);
  const member: Member = {
    id: identity.id,
    kind: "human",
    label,
    signPublicKey: identity.id,
    boxPublicKey: Buffer.from(identity.box.publicKey).toString("base64url"),
    agents: [
      { id: agent.id, name: agent.label, subscription: label, signPublicKey: agent.id, delegation },
    ],
  };
  return { identity, agent, member, delegation };
}

export async function fixture() {
  const a = await person("Alice");
  const b = await person("Bob");
  const key = await newRoomKey();
  const post = (
    id: number,
    sender: Identity = a.identity,
    epoch = 0,
    sentAt = "2026-10-24T12:00:00Z",
  ) => {
    const msg: Message = {
      id: String(id),
      room: "test-room",
      thread: "t",
      kind: "fyi",
      body: `Message ${id}`,
      auto: false,
      sentAt,
    };
    return seal(msg, sender, key, epoch, sender.kind === "agent" ? a.delegation : undefined);
  };
  return { a, b, key, post };
}
