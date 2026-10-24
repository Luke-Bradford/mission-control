import { canonicalJson } from "./canonical.ts";
import { type Sealed, verifySealedSync } from "./envelope.ts";
import type { KeyGrant, Member } from "./membership.ts";
import { ready } from "./sodium.ts";

const sodium = await ready();
const variant = sodium.base64_variants.URLSAFE_NO_PADDING;
type Presence = Record<string, { status: string; seenAt: number }>;
type Entry = { seq: number; sealed: Sealed };
export type RoomState = {
  room: string;
  keyEpoch: number;
  seq: number;
  owner: Member;
  members: Member[];
  pending: Member[];
  tokens: Record<string, "unused" | "used">;
  grants: KeyGrant[];
  log: Entry[];
  presence: Presence;
};
export interface RoomStorage {
  load(): RoomState | undefined;
  save(s: RoomState): void;
}
export type PostResult =
  | { seq: number }
  | {
      refused: "unknown-sender" | "bad-signature" | "rate-limited" | "stale-epoch";
    };
export interface RoomCore {
  issueToken(by: string): string;
  requestJoin(token: string, member: Member): "pending" | "used" | "unknown";
  approve(by: string, memberId: string, grants: KeyGrant[]): void;
  remove(by: string, memberId: string, grants: KeyGrant[]): void;
  post(s: Sealed): PostResult;
  since(memberId: string, seq: number): Entry[];
  grantsFor(memberId: string): KeyGrant[];
  members(): Member[];
  pending(): Member[];
  setPresence(id: string, status: "online" | "busy" | "away"): void;
  presence(): Presence;
}

export function validateMember(member: Member): void {
  const key = (encoded: string) => {
    const bytes = sodium.from_base64(encoded, variant);
    if (bytes.length !== 32 || sodium.to_base64(bytes, variant) !== encoded)
      throw new Error("Invalid member key");
    return bytes;
  };
  if (member.kind !== "human" || member.id !== member.signPublicKey)
    throw new Error("Invalid member");
  const publicKey = key(member.signPublicKey);
  key(member.boxPublicKey);
  const ids = new Set([member.id]);
  const names = new Set<string>();
  for (const agent of member.agents) {
    key(agent.signPublicKey);
    const { sig, ...payload } = agent.delegation;
    const name = JSON.stringify([agent.subscription, agent.name]);
    if (
      agent.id !== agent.signPublicKey ||
      ids.has(agent.id) ||
      names.has(name) ||
      payload.agentId !== agent.id ||
      payload.memberId !== member.id ||
      payload.agentName !== agent.name ||
      payload.subscription !== agent.subscription ||
      !sodium.crypto_sign_verify_detached(
        sodium.from_base64(sig, variant),
        canonicalJson(payload),
        publicKey,
      )
    ) {
      throw new Error("Invalid agent delegation");
    }
    ids.add(agent.id);
    names.add(name);
  }
}

export function createRoomCore(opts: {
  room: string;
  owner: Member;
  now: () => number;
  maxPerMinute?: number;
  storage?: RoomStorage;
}): RoomCore {
  validateMember(opts.owner);
  const loaded = opts.storage?.load();
  const state: RoomState = structuredClone(
    loaded ?? {
      room: opts.room,
      keyEpoch: 0,
      seq: 0,
      owner: opts.owner,
      members: [opts.owner],
      pending: [],
      tokens: {},
      grants: [],
      log: [],
      presence: {},
    },
  );
  if (state.room !== opts.room || state.owner.id !== opts.owner.id)
    throw new Error("Room storage mismatch");
  const rates = new Map<string, number[]>();
  const save = () => opts.storage?.save(structuredClone(state));
  const ownerOnly = (by: string) => {
    if (by !== state.owner.id) throw new Error("Owner only");
  };
  const memberOf = (id: string) =>
    state.members.find((m) => m.id === id || m.agents.some((a) => a.id === id));
  const checkNewMember = (member: Member) => {
    validateMember(member);
    const existing = [...state.members, ...state.pending];
    const ids = [member.id, ...member.agents.map((a) => a.id)];
    if (
      existing.some(
        (m) =>
          ids.includes(m.id) ||
          m.agents.some(
            (a) =>
              ids.includes(a.id) ||
              member.agents.some((b) => a.name === b.name && a.subscription === b.subscription),
          ),
      )
    ) {
      throw new Error("Member or agent already registered");
    }
  };
  const checkGrants = (grants: KeyGrant[], members: Member[], epoch: number) => {
    if (
      grants.length !== members.length ||
      new Set(grants.map((g) => g.memberId)).size !== members.length ||
      grants.some(
        (g) => g.keyEpoch !== epoch || !members.some((m) => m.id === g.memberId) || !g.wrapped,
      )
    )
      throw new Error("Invalid key grants");
  };
  if (!loaded) save();
  return {
    issueToken(by) {
      ownerOnly(by);
      const token = sodium.to_base64(sodium.randombytes_buf(32), variant);
      state.tokens[token] = "unused";
      save();
      return token;
    },
    requestJoin(token, member) {
      if (!Object.hasOwn(state.tokens, token)) return "unknown";
      if (state.tokens[token] === "used") return "used";
      checkNewMember(member);
      state.tokens[token] = "used";
      state.pending.push(structuredClone(member));
      save();
      return "pending";
    },
    approve(by, memberId, grants) {
      ownerOnly(by);
      const member = state.pending.find((m) => m.id === memberId);
      if (!member) throw new Error("Unknown pending member");
      checkGrants(grants, [member], state.keyEpoch);
      state.pending = state.pending.filter((m) => m.id !== memberId);
      state.members.push(member);
      state.grants.push(...structuredClone(grants));
      save();
    },
    remove(by, memberId, grants) {
      ownerOnly(by);
      if (memberId === state.owner.id || !state.members.some((m) => m.id === memberId))
        throw new Error("Cannot remove member");
      const remaining = state.members.filter((m) => m.id !== memberId);
      checkGrants(grants, remaining, state.keyEpoch + 1);
      state.members = remaining;
      state.keyEpoch++;
      state.grants = [
        ...state.grants.filter((g) => g.memberId !== memberId),
        ...structuredClone(grants),
      ];
      for (const id of Object.keys(state.presence)) if (!memberOf(id)) delete state.presence[id];
      save();
    },
    post(sealed) {
      const member = memberOf(sealed.sender.id);
      if (!member) return { refused: "unknown-sender" };
      const agent = member.agents.find((a) => a.id === sealed.sender.id);
      if (
        sealed.room !== state.room ||
        (agent
          ? sealed.sender.kind !== "agent" ||
            canonicalJson(sealed.sender.delegation) !== canonicalJson(agent.delegation)
          : sealed.sender.kind !== "human" || sealed.sender.delegation !== undefined) ||
        !verifySealedSync(
          sealed,
          (id) =>
            id === sealed.sender.id
              ? sodium.from_base64(agent?.signPublicKey ?? member.signPublicKey, variant)
              : undefined,
          sodium,
        )
      )
        return { refused: "bad-signature" };
      if (sealed.keyEpoch !== state.keyEpoch) return { refused: "stale-epoch" };
      const now = opts.now();
      const recent = (rates.get(sealed.sender.id) ?? []).filter((at) => at > now - 60_000);
      if (recent.length >= (opts.maxPerMinute ?? 30)) return { refused: "rate-limited" };
      recent.push(now);
      rates.set(sealed.sender.id, recent);
      const seq = ++state.seq;
      state.log.push({ seq, sealed: structuredClone(sealed) });
      if (state.log.length > 5000) state.log.splice(0, state.log.length - 5000);
      save();
      return { seq };
    },
    since(memberId, seq) {
      return memberOf(memberId) ? structuredClone(state.log.filter((m) => m.seq > seq)) : [];
    },
    grantsFor(memberId) {
      const member = memberOf(memberId);
      return member ? structuredClone(state.grants.filter((g) => g.memberId === member.id)) : [];
    },
    members: () => structuredClone(state.members),
    pending: () => structuredClone(state.pending),
    setPresence(id, status) {
      if (!memberOf(id)) throw new Error("Unknown member");
      state.presence[id] = { status, seenAt: opts.now() };
      save();
    },
    presence() {
      const presence = structuredClone(state.presence);
      for (const entry of Object.values(presence))
        if (opts.now() - entry.seenAt > 90_000) entry.status = "gone";
      return presence;
    },
  };
}
