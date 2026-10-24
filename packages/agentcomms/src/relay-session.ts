import { controlPayload, verify } from "./auth.ts";
import {
  AUTH_CLOCK_SKEW_MS,
  FRAME_MAX,
  HELLO_TIMEOUT_MS,
  LOG_PAGE_SIZE,
  PRESENCE_INTERVAL_MS,
} from "./limits.ts";
import type { Member } from "./membership.ts";
import {
  clientMessageSchema,
  createRoomSchema,
  type Hello,
  type RelayMessage,
  tokenSchema,
} from "./protocol.ts";
import { createRoomCore, type RoomCore, type RoomStorage } from "./relay-core.ts";
import { ready } from "./sodium.ts";

const sodium = await ready();
const variant = sodium.base64_variants.URLSAFE_NO_PADDING;

export { FRAME_MAX } from "./limits.ts";

export function verifyHello(
  hello: Hello,
  room: string,
  members: Member[],
  challenge: string,
): boolean {
  if (hello.room !== room || hello.challenge !== challenge) return false;
  const member = members.find(
    (m) => m.id === hello.memberId || m.agents.some((a) => a.id === hello.memberId),
  );
  const key =
    member?.id === hello.memberId
      ? member.signPublicKey
      : member?.agents.find((a) => a.id === hello.memberId)?.signPublicKey;
  if (!key) return false;
  try {
    return sodium.crypto_sign_verify_detached(
      sodium.from_base64(hello.sig, variant),
      `agentcomms/hello/v1|${hello.room}|${hello.memberId}|${hello.challenge}`,
      sodium.from_base64(key, variant),
    );
  } catch {
    return false;
  }
}

export type PeerState = {
  id?: string;
  seq?: number;
  challenge: string;
  deadline: number;
  presenceAt?: number;
  status?: string;
  seenAt?: number;
  replaying?: boolean;
};
export type RelayPeer = {
  send(message: RelayMessage): void;
  close(): void;
  save?(state: PeerState): void;
};
export function createRelaySession(
  room: string,
  core: RoomCore,
  now = Date.now,
  hibernating = false,
) {
  const peers = new Map<RelayPeer, PeerState & { timer?: ReturnType<typeof setTimeout> }>();
  const known = (id: string) =>
    core.members().some((m) => m.id === id || m.agents.some((a) => a.id === id));
  const disconnect = (peer: RelayPeer) => {
    clearTimeout(peers.get(peer)?.timer);
    peers.delete(peer);
    try {
      peer.close();
    } catch {
      /* The socket may already be closed. */
    }
  };
  const send = (peer: RelayPeer, message: RelayMessage) => {
    try {
      peer.send(message);
    } catch {
      disconnect(peer);
    }
  };
  const refuse = (peer: RelayPeer, reason: string, close = false, id?: string) => {
    send(peer, { t: "refused", reason, ...(id ? { id } : {}) });
    if (close) disconnect(peer);
  };
  const broadcast = (message: RelayMessage) => {
    for (const [peer, auth] of peers) if (auth.id && known(auth.id)) send(peer, message);
  };
  return {
    connect(peer: RelayPeer) {
      const challenge = sodium.to_base64(sodium.randombytes_buf(32), variant);
      const timer = hibernating
        ? undefined
        : setTimeout(() => refuse(peer, "auth-timeout", true), HELLO_TIMEOUT_MS);
      const state = { challenge, deadline: now() + HELLO_TIMEOUT_MS, timer };
      peers.set(peer, state);
      peer.save?.({ challenge, deadline: state.deadline });
      send(peer, { t: "challenge", challenge });
    },
    restore(peer: RelayPeer, state: PeerState) {
      peers.set(peer, { ...state });
      if (state.id && state.status !== undefined && state.seenAt !== undefined)
        core.restorePresence(state.id, { status: state.status, seenAt: state.seenAt });
    },
    expire() {
      for (const [peer, state] of peers)
        if (!state.id && state.deadline <= now()) refuse(peer, "auth-timeout", true);
    },
    disconnect(peer: RelayPeer) {
      clearTimeout(peers.get(peer)?.timer);
      peers.delete(peer);
    },
    receive(peer: RelayPeer, raw: string) {
      const auth = peers.get(peer);
      if (!auth) return;
      if (!auth.id && auth.deadline <= now()) {
        refuse(peer, "auth-timeout", true);
        return;
      }
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      let postId: string | undefined;
      try {
        if (new TextEncoder().encode(raw).length > FRAME_MAX) throw new Error("Frame too large");
        const value = JSON.parse(raw);
        if (value?.t === "post" && typeof value.id === "string" && value.id.length <= 200)
          postId = value.id;
        parsed = clientMessageSchema.safeParse(value);
      } catch {
        refuse(peer, "invalid-message", false, postId);
        return;
      }
      if (!parsed.success) {
        refuse(peer, "invalid-message", false, postId);
        return;
      }
      const msg = parsed.data;
      try {
        if (msg.t === "hello") {
          if (auth.id || !verifyHello(msg, room, core.identities(), auth.challenge)) {
            refuse(peer, "bad-hello", true);
            return;
          }
          if (!known(msg.memberId)) {
            send(peer, { t: "directory", ...core.directory() });
            refuse(peer, "removed", true);
            return;
          }
          clearTimeout(auth.timer);
          auth.challenge = "";
          auth.id = msg.memberId;
          peer.save?.({ id: auth.id, challenge: "", deadline: auth.deadline });
          send(peer, { t: "directory", ...core.directory() });
          if (auth.id === core.members()[0]?.id)
            send(peer, { t: "pending", members: core.pending() });
          send(peer, { t: "grants", grants: core.grantsFor(auth.id) });
          send(peer, { t: "presence", map: core.presence() });
          return;
        }
        if (msg.t === "join") {
          if (auth.id) {
            refuse(peer, "already-authenticated");
            return;
          }
          const result = core.requestJoin(msg.token, msg.member);
          if (result === "pending") send(peer, { t: "grants", grants: [] });
          else refuse(peer, result);
          return;
        }
        if (!auth.id || !known(auth.id)) {
          refuse(peer, "unauthenticated", true);
          return;
        }
        if (msg.t === "post") {
          if (msg.sealed.sender.id !== auth.id) {
            refuse(peer, "wrong-sender", false, msg.id);
            return;
          }
          if (
            new TextEncoder().encode(
              JSON.stringify({ t: "msg", seq: Number.MAX_SAFE_INTEGER, sealed: msg.sealed }),
            ).length > FRAME_MAX
          ) {
            refuse(peer, "too-large", false, msg.id);
            return;
          }
          const result = core.post(msg.sealed);
          if ("refused" in result) {
            refuse(peer, result.refused, false, msg.id);
            return;
          }
          // since establishes a cursor before live delivery, preventing replay/live races.
          for (const [recipient, state] of peers) {
            if (
              state.id &&
              known(state.id) &&
              state.seq !== undefined &&
              !state.replaying &&
              result.seq > state.seq
            ) {
              send(recipient, { t: "msg", seq: result.seq, sealed: msg.sealed });
              state.seq = result.seq;
              const { timer: _, ...saved } = state;
              recipient.save?.(saved);
            }
          }
          return;
        }
        if (msg.t === "since") {
          auth.seq = Math.max(auth.seq ?? 0, msg.seq);
          if (auth.seq > core.seq()) {
            send(peer, { t: "reset", relaySeq: core.seq() });
            disconnect(peer);
            return;
          }
          const oldest = core.oldestSeq();
          if (auth.seq < oldest - 1) {
            send(peer, { t: "gap", from: auth.seq + 1, to: oldest - 1 });
            auth.seq = oldest - 1;
          }
          const page = core.since(auth.id, auth.seq, LOG_PAGE_SIZE);
          for (const entry of page) {
            if (!peers.has(peer)) break;
            send(peer, { t: "msg", ...entry });
            auth.seq = entry.seq;
          }
          auth.replaying = auth.seq < core.seq();
          if (auth.replaying) send(peer, { t: "more", seq: auth.seq });
          const { timer: _, ...saved } = auth;
          peer.save?.(saved);
          return;
        }
        if (msg.t === "presence") {
          for (const state of peers.values())
            if (
              state.id === auth.id &&
              state.presenceAt !== undefined &&
              now() - state.presenceAt < 0.8 * PRESENCE_INTERVAL_MS
            )
              return;
          if (!core.setPresence(auth.id, msg.status)) return;
          const presence = core.presence()[auth.id];
          auth.presenceAt = presence.seenAt;
          auth.status = presence.status;
          auth.seenAt = presence.seenAt;
          const { timer: _, ...saved } = auth;
          peer.save?.(saved);
          broadcast({ t: "presence", map: core.presence() });
          return;
        }
        const { t, sig, ...payload } = msg;
        if (
          auth.id !== core.members()[0]?.id ||
          !verify(controlPayload(t, room, payload), sig, auth.id)
        )
          throw new Error("Invalid owner control signature");
        core[msg.t](auth.id, msg.memberId, msg.grants, msg.directory);
        for (const [recipient, state] of peers) {
          if (!state.id) continue;
          if (!known(state.id)) {
            send(recipient, { t: "directory", ...core.directory() });
            refuse(recipient, "removed", true);
            continue;
          }
          send(recipient, { t: "directory", ...core.directory() });
          if (state.id === core.members()[0]?.id)
            send(recipient, { t: "pending", members: core.pending() });
          send(recipient, { t: "grants", grants: core.grantsFor(state.id) });
        }
        broadcast({ t: "presence", map: core.presence() });
      } catch (error) {
        refuse(peer, error instanceof Error ? error.message : "invalid-message", false, postId);
      }
    },
  };
}

export function roomRoute(path: string): { room: string; tokens: boolean } | undefined {
  const match = /^\/rooms\/([^/]+)(\/tokens)?$/.exec(path);
  if (!match) return undefined;
  try {
    const room = decodeURIComponent(match[1]);
    if (!room || room.includes("|") || room.length > 200) return undefined;
    return { room, tokens: !!match[2] };
  } catch {
    return undefined;
  }
}

export function roomHttp(opts: {
  room: string;
  tokens: boolean;
  method: string;
  body: unknown;
  storage: RoomStorage;
  core?: RoomCore;
  now?: () => number;
  createSecret?: string;
  authorization?: string;
}): { status: number; body: unknown; core?: RoomCore } {
  const now = opts.now ?? Date.now;
  if (!opts.tokens && opts.method === "PUT") {
    if (!opts.createSecret || opts.authorization !== `Bearer ${opts.createSecret}`)
      return { status: 403, body: { error: "Creation secret required" } };
    if (opts.core) return { status: 409, body: { error: "Room already exists" } };
    const parsed = createRoomSchema.safeParse(opts.body);
    if (!parsed.success) return { status: 400, body: { error: "Invalid room" } };
    const { sig, ...payload } = parsed.data;
    const { owner, grants, directory } = payload;
    if (!verify(controlPayload("create", opts.room, payload), sig, owner.id))
      return { status: 403, body: { error: "bad-hello" } };
    try {
      const core = createRoomCore({
        room: opts.room,
        owner,
        now,
        storage: opts.storage,
        grants,
        directory,
      });
      return { status: 201, body: { room: opts.room }, core };
    } catch {
      return { status: 400, body: { error: "Invalid owner" } };
    }
  }
  if (opts.tokens && opts.method === "POST") {
    if (!opts.core) return { status: 404, body: { error: "Unknown room" } };
    const parsed = tokenSchema.safeParse(opts.body);
    if (!parsed.success) return { status: 403, body: { error: "Invalid token request" } };
    const { sig, ...payload } = parsed.data;
    if (
      payload.memberId !== opts.core.members()[0]?.id ||
      !verify(controlPayload("token", opts.room, payload), sig, payload.memberId)
    )
      return { status: 403, body: { error: "bad-hello" } };
    if (Math.abs(now() - payload.at) > AUTH_CLOCK_SKEW_MS)
      return {
        status: 403,
        body: {
          error: `Authentication expired: clock skew exceeds ${AUTH_CLOCK_SKEW_MS / 1000} seconds; synchronize the client clock`,
        },
      };
    if (!opts.core.useRequest(payload.nonce, payload.at))
      return { status: 403, body: { error: "bad-hello" } };
    try {
      return { status: 200, body: { token: opts.core.issueToken(parsed.data.memberId) } };
    } catch {
      return { status: 403, body: { error: "Owner only" } };
    }
  }
  return { status: 405, body: { error: "Method not allowed" } };
}
