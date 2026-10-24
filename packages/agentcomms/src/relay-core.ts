import { type Directory, verifyDirectory, verifyGrant, verifyMember } from "./auth.ts";
import { canonicalJson } from "./canonical.ts";
import { type Sealed, verifySealedSync } from "./envelope.ts";
import {
  AUTH_CLOCK_SKEW_MS,
  LOG_LIMIT,
  POST_WINDOW_MS,
  PRESENCE_INTERVAL_MS,
  TOKEN_TTL_MS,
} from "./limits.ts";
import type { KeyGrant, Member } from "./membership.ts";
import { ready } from "./sodium.ts";

const sodium = await ready();
const variant = sodium.base64_variants.URLSAFE_NO_PADDING;
type Presence = Record<string, { status: string; seenAt: number }>;
export type Entry = { seq: number; sealed: Sealed };
export type RoomState = {
  room: string;
  keyEpoch: number;
  seq: number;
  owner: Member;
  members: Member[];
  // Retain public identities after removal so offline clients can verify older ciphertext.
  directory?: Member[];
  signedDirectory?: Directory;
  usedRequests?: { nonce: string; at: number }[];
  postRates?: Record<string, number[]>;
  pending: Member[];
  tokens: Record<string, { status: "unused" | "used"; expiresAt: number }>;
  grants: KeyGrant[];
  log: Entry[];
  presence: Presence;
};
export interface RoomStorage {
  load(): RoomState | undefined;
  save(s: RoomState, entry?: Entry): void;
  readLog?(seq: number, limit: number): Entry[];
}
export type PostResult =
  | { seq: number }
  | {
      refused: "unknown-sender" | "bad-signature" | "rate-limited" | "stale-epoch";
    };
export interface RoomCore {
  issueToken(by: string): string;
  requestJoin(token: string, member: Member): "pending" | "used" | "unknown";
  approve(by: string, memberId: string, grants: KeyGrant[], directory: Directory): void;
  remove(by: string, memberId: string, grants: KeyGrant[], directory: Directory): void;
  post(s: Sealed): PostResult;
  since(memberId: string, seq: number, limit?: number): Entry[];
  oldestSeq(): number;
  seq(): number;
  grantsFor(recipientId: string): KeyGrant[];
  members(): Member[];
  identities(): Member[];
  directory(): Directory;
  useRequest(nonce: string, at: number): boolean;
  pending(): Member[];
  setPresence(id: string, status: "online" | "busy" | "away"): boolean;
  restorePresence(id: string, presence: Presence[string]): void;
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
  if (!verifyMember(member)) throw new Error("Invalid member signature");
  const publicKey = key(member.signPublicKey);
  key(member.boxPublicKey);
  const ids = new Set([member.id]);
  const names = new Set<string>();
  for (const agent of member.agents) {
    key(agent.signPublicKey);
    key(agent.boxPublicKey);
    const { sig, ...payload } = agent.delegation;
    const name = JSON.stringify([agent.subscription, agent.name]);
    if (
      agent.id !== agent.signPublicKey ||
      ids.has(agent.id) ||
      names.has(name) ||
      payload.boxPublicKey !== agent.boxPublicKey ||
      payload.agentId !== agent.id ||
      payload.memberId !== member.id ||
      payload.agentName !== agent.name ||
      payload.subscription !== agent.subscription ||
      !sodium.crypto_sign_verify_detached(
        sodium.from_base64(sig, variant),
        `agentcomms/delegation/v1|${canonicalJson(payload)}`,
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
  grants?: KeyGrant[];
  directory?: Directory;
}): RoomCore {
  validateMember(opts.owner);
  const loaded = opts.storage?.load();
  const state: RoomState = structuredClone(
    loaded ?? {
      room: opts.room,
      keyEpoch: 0,
      signedDirectory: opts.directory,
      seq: 0,
      owner: opts.owner,
      members: [opts.owner],
      pending: [],
      tokens: {},
      grants: opts.grants ?? [],
      log: [],
      presence: {},
    },
  );
  if (state.room !== opts.room || state.owner.id !== opts.owner.id)
    throw new Error("Room storage mismatch");
  if (!state.signedDirectory || !verifyDirectory(state.signedDirectory, opts.room, opts.owner.id))
    throw new Error("Invalid signed directory");
  state.directory ??= structuredClone(state.members);
  state.presence = {};
  // Older Node snapshots contain bare nonces. Give them a bounded migration window too.
  state.usedRequests = (state.usedRequests ?? []).map((request) =>
    typeof request === "string" ? { nonce: request, at: opts.now() } : request,
  );
  state.postRates = Object.fromEntries(
    Object.entries(state.postRates ?? {}).map(([id, times]) => [
      id,
      times.filter((at) => at > opts.now() - POST_WINDOW_MS),
    ]),
  );
  const save = (entry?: Entry) =>
    opts.storage?.save(structuredClone({ ...state, presence: {} }), entry);
  const pruneTokens = () => {
    let changed = false;
    for (const [token, value] of Object.entries(state.tokens)) {
      // Legacy tokens have no expiry and must be reissued.
      if (!value.expiresAt || value.expiresAt <= opts.now()) {
        delete state.tokens[token];
        changed = true;
      }
    }
    return changed;
  };
  if (pruneTokens()) save();
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
    const recipients = members.flatMap((m) => [m.id, ...m.agents.map((a) => a.id)]);
    if (
      grants.length !== recipients.length ||
      new Set(grants.map((g) => g.memberId)).size !== recipients.length ||
      grants.some(
        (g) =>
          g.keyEpoch !== epoch ||
          !recipients.includes(g.memberId) ||
          !g.wrapped ||
          !verifyGrant(opts.room, g, state.owner.id),
      )
    )
      throw new Error("Invalid key grants");
  };
  if (!loaded) {
    if (opts.grants) checkGrants(opts.grants, [opts.owner], 0);
    save();
  }
  const checkDirectory = (directory: Directory, members: Member[], epoch: number) => {
    if (
      !verifyDirectory(directory, state.room, state.owner.id) ||
      directory.keyEpoch !== epoch ||
      directory.version !== (state.signedDirectory?.version ?? 0) + 1 ||
      canonicalJson(directory.members) !== canonicalJson(members)
    )
      throw new Error("Invalid directory update");
  };
  return {
    useRequest(nonce, at) {
      state.usedRequests = (state.usedRequests ?? []).filter(
        (request) => request.at >= opts.now() - 2 * AUTH_CLOCK_SKEW_MS,
      );
      if (state.usedRequests.some((request) => request.nonce === nonce)) return false;
      state.usedRequests.push({ nonce, at });
      save();
      return true;
    },
    issueToken(by) {
      ownerOnly(by);
      const token = sodium.to_base64(sodium.randombytes_buf(32), variant);
      pruneTokens();
      state.tokens[token] = { status: "unused", expiresAt: opts.now() + TOKEN_TTL_MS };
      save();
      return token;
    },
    requestJoin(token, member) {
      if (pruneTokens()) save();
      if (!Object.hasOwn(state.tokens, token)) return "unknown";
      if (state.tokens[token].status === "used") return "used";
      checkNewMember(member);
      state.tokens[token].status = "used";
      state.pending.push(structuredClone(member));
      save();
      return "pending";
    },
    approve(by, memberId, grants, directory) {
      ownerOnly(by);
      const member = state.pending.find((m) => m.id === memberId);
      if (!member) throw new Error("Unknown pending member");
      checkGrants(grants, [member], state.keyEpoch);
      checkDirectory(directory, [...state.members, member], state.keyEpoch);
      state.signedDirectory = structuredClone(directory);
      state.pending = state.pending.filter((m) => m.id !== memberId);
      state.members.push(member);
      state.directory?.push(structuredClone(member));
      state.grants.push(...structuredClone(grants));
      save();
    },
    remove(by, memberId, grants, directory) {
      ownerOnly(by);
      if (memberId === state.owner.id || !state.members.some((m) => m.id === memberId))
        throw new Error("Cannot remove member");
      const remaining = state.members.filter((m) => m.id !== memberId);
      checkGrants(grants, remaining, state.keyEpoch + 1);
      checkDirectory(directory, remaining, state.keyEpoch + 1);
      state.signedDirectory = structuredClone(directory);
      state.members = remaining;
      state.keyEpoch++;
      state.grants = [
        ...state.grants.filter((g) => memberOf(g.memberId)),
        ...structuredClone(grants),
      ];
      for (const id of Object.keys(state.presence)) if (!memberOf(id)) delete state.presence[id];
      for (const id of Object.keys(state.postRates ?? {}))
        if (!memberOf(id)) delete state.postRates?.[id];
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
      state.postRates ??= {};
      const rates = state.postRates;
      const previousRate = rates[sealed.sender.id];
      const recent = (previousRate ?? []).filter((at) => at > now - POST_WINDOW_MS);
      if (recent.length >= (opts.maxPerMinute ?? 30)) return { refused: "rate-limited" };
      recent.push(now);
      rates[sealed.sender.id] = recent;
      const seq = ++state.seq;
      const entry = { seq, sealed: structuredClone(sealed) };
      let trimmed: Entry[] = [];
      if (!opts.storage?.readLog) {
        state.log.push(entry);
        if (state.log.length > LOG_LIMIT)
          trimmed = state.log.splice(0, state.log.length - LOG_LIMIT);
      }
      try {
        save(entry);
      } catch (error) {
        state.seq--;
        if (previousRate) rates[sealed.sender.id] = previousRate;
        else delete rates[sealed.sender.id];
        if (!opts.storage?.readLog) {
          state.log.pop();
          state.log.unshift(...trimmed);
        }
        throw error;
      }
      return { seq };
    },
    since(memberId, seq, limit = LOG_LIMIT) {
      if (!memberOf(memberId)) return [];
      return opts.storage?.readLog
        ? opts.storage.readLog(seq, limit)
        : structuredClone(state.log.filter((m) => m.seq > seq).slice(0, limit));
    },
    seq: () => state.seq,
    oldestSeq: () => Math.max(1, state.seq - LOG_LIMIT + 1),
    grantsFor(recipientId) {
      return memberOf(recipientId)
        ? structuredClone(state.grants.filter((g) => g.memberId === recipientId))
        : [];
    },
    members: () => structuredClone(state.members),
    identities: () => structuredClone(state.directory ?? state.members),
    directory: () => structuredClone(state.signedDirectory as Directory),
    pending: () => structuredClone(state.pending),
    setPresence(id, status) {
      if (!memberOf(id)) throw new Error("Unknown member");
      const now = opts.now();
      if (state.presence[id] && now - state.presence[id].seenAt < 0.8 * PRESENCE_INTERVAL_MS)
        return false;
      state.presence[id] = { status, seenAt: now };
      return true;
    },
    restorePresence(id, presence) {
      if (memberOf(id) && (!state.presence[id] || presence.seenAt > state.presence[id].seenAt))
        state.presence[id] = structuredClone(presence);
    },
    presence() {
      const presence = structuredClone(state.presence);
      for (const entry of Object.values(presence))
        if (opts.now() - entry.seenAt > 90_000) entry.status = "gone";
      return presence;
    },
  };
}
