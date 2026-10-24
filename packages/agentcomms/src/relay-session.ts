import type { Member } from "./membership.ts";
import {
  clientMessageSchema,
  createRoomSchema,
  type Hello,
  helloSchema,
  type RelayMessage,
} from "./protocol.ts";
import { createRoomCore, type RoomCore, type RoomStorage } from "./relay-core.ts";
import { ready } from "./sodium.ts";

const sodium = await ready();
const variant = sodium.base64_variants.URLSAFE_NO_PADDING;
export const FRAME_MAX = 256_000;

export function verifyHello(hello: Hello, room: string, members: Member[], now: number): boolean {
  if (hello.room !== room || Math.abs(now - hello.at) > 120_000) return false;
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
      `${hello.room}|${hello.memberId}|${hello.at}`,
      sodium.from_base64(key, variant),
    );
  } catch {
    return false;
  }
}

export type RelayPeer = { send(message: RelayMessage): void; close(): void };
export function createRelaySession(room: string, core: RoomCore, now = Date.now) {
  const peers = new Map<RelayPeer, { id?: string; seq?: number }>();
  const known = (id: string) =>
    core.members().some((m) => m.id === id || m.agents.some((a) => a.id === id));
  const disconnect = (peer: RelayPeer) => {
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
  const refuse = (peer: RelayPeer, reason: string, close = false) => {
    send(peer, { t: "refused", reason });
    if (close) disconnect(peer);
  };
  const broadcast = (message: RelayMessage) => {
    for (const [peer, auth] of peers) if (auth.id && known(auth.id)) send(peer, message);
  };
  return {
    connect(peer: RelayPeer) {
      peers.set(peer, {});
    },
    disconnect(peer: RelayPeer) {
      peers.delete(peer);
    },
    receive(peer: RelayPeer, raw: string) {
      const auth = peers.get(peer);
      if (!auth) return;
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      try {
        if (new TextEncoder().encode(raw).length > FRAME_MAX) throw new Error("Frame too large");
        parsed = clientMessageSchema.safeParse(JSON.parse(raw));
      } catch {
        refuse(peer, "invalid-message");
        return;
      }
      if (!parsed.success) {
        refuse(peer, "invalid-message");
        return;
      }
      const msg = parsed.data;
      try {
        if (msg.t === "hello") {
          if (auth.id || !verifyHello(msg, room, core.members(), now())) {
            refuse(peer, "bad-hello", true);
            return;
          }
          auth.id = msg.memberId;
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
            refuse(peer, "wrong-sender");
            return;
          }
          const result = core.post(msg.sealed);
          if ("refused" in result) {
            refuse(peer, result.refused);
            return;
          }
          // since establishes a cursor before live delivery, preventing replay/live races.
          for (const [recipient, state] of peers) {
            if (state.id && known(state.id) && state.seq !== undefined && result.seq > state.seq) {
              send(recipient, { t: "msg", seq: result.seq, sealed: msg.sealed });
              state.seq = result.seq;
            }
          }
          return;
        }
        if (msg.t === "since") {
          auth.seq = Math.max(auth.seq ?? 0, msg.seq);
          for (const entry of core.since(auth.id, auth.seq)) {
            send(peer, { t: "msg", ...entry });
            auth.seq = entry.seq;
          }
          return;
        }
        if (msg.t === "presence") {
          core.setPresence(auth.id, msg.status);
          broadcast({ t: "presence", map: core.presence() });
          return;
        }
        core[msg.t](auth.id, msg.memberId, msg.grants);
        for (const [recipient, state] of peers) {
          if (!state.id) continue;
          if (!known(state.id)) {
            refuse(recipient, "removed", true);
            continue;
          }
          send(recipient, { t: "grants", grants: core.grantsFor(state.id) });
        }
        broadcast({ t: "presence", map: core.presence() });
      } catch (error) {
        refuse(peer, error instanceof Error ? error.message : "invalid-message");
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
}): { status: number; body: unknown; core?: RoomCore } {
  const now = opts.now ?? Date.now;
  if (!opts.tokens && opts.method === "PUT") {
    if (opts.core) return { status: 409, body: { error: "Room already exists" } };
    const parsed = createRoomSchema.safeParse(opts.body);
    if (!parsed.success) return { status: 400, body: { error: "Invalid room" } };
    const { owner, hello } = parsed.data;
    if (hello.memberId !== owner.id || !verifyHello(hello, opts.room, [owner], now()))
      return { status: 403, body: { error: "bad-hello" } };
    try {
      const core = createRoomCore({ room: opts.room, owner, now, storage: opts.storage });
      return { status: 201, body: { room: opts.room }, core };
    } catch {
      return { status: 400, body: { error: "Invalid owner" } };
    }
  }
  if (opts.tokens && opts.method === "POST") {
    if (!opts.core) return { status: 404, body: { error: "Unknown room" } };
    const parsed = helloSchema.safeParse(opts.body);
    if (!parsed.success || !verifyHello(parsed.data, opts.room, opts.core.members(), now()))
      return { status: 403, body: { error: "bad-hello" } };
    try {
      return { status: 200, body: { token: opts.core.issueToken(parsed.data.memberId) } };
    } catch {
      return { status: 403, body: { error: "Owner only" } };
    }
  }
  return { status: 405, body: { error: "Method not allowed" } };
}
