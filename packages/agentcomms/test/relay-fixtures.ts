import { signDirectory, signGrant, signMember } from "../src/auth.ts";
import { type Message, seal } from "../src/envelope.ts";
import { delegate, type Identity, newIdentity } from "../src/keys.ts";
import { type Member, newRoomKey, rotate, wrapMemberKeys } from "../src/membership.ts";
import type { RoomCore } from "../src/relay-core.ts";

export async function person(label: string) {
  const identity = await newIdentity("human", label);
  const agent = await newIdentity("agent", `${label}-agent`);
  const delegation = await delegate(identity, agent, label, agent.label);
  const member: Member = signMember(
    {
      sig: "",
      id: identity.id,
      kind: "human",
      label,
      signPublicKey: identity.id,
      boxPublicKey: Buffer.from(identity.box.publicKey).toString("base64url"),
      agents: [
        {
          id: agent.id,
          name: agent.label,
          subscription: label,
          signPublicKey: agent.id,
          boxPublicKey: Buffer.from(agent.box.publicKey).toString("base64url"),
          delegation,
        },
      ],
    },
    identity,
  );
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
  const grants = async (key: Uint8Array, epoch: number, member: Member) =>
    (await wrapMemberKeys(key, epoch, member)).map((g) => signGrant("test-room", g, a.identity));
  const rotation = async (members: Member[], removed: string, epoch: number) => {
    const result = await rotate(members, removed, epoch);
    return { ...result, grants: result.grants.map((g) => signGrant("test-room", g, a.identity)) };
  };
  const directory = signDirectory("test-room", 0, 0, [a.member], a.identity);
  const nextDirectory = (core: RoomCore, removed?: string) =>
    signDirectory(
      "test-room",
      core.directory().keyEpoch + (removed ? 1 : 0),
      core.directory().version + 1,
      removed
        ? core.members().filter((m) => m.id !== removed)
        : [...core.members(), ...core.pending()],
      a.identity,
    );
  return { a, b, key, post, grants, rotate: rotation, directory, nextDirectory };
}
