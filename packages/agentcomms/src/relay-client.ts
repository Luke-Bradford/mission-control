import { WebSocket } from "ws";
import { sign } from "./auth.ts";
import type { Identity } from "./keys.ts";
import type { Invite, Member } from "./membership.ts";
import {
  type ClientMessage,
  type Hello,
  type RelayMessage,
  relayMessageSchema,
} from "./protocol.ts";
import { FRAME_MAX } from "./relay-session.ts";

export function relayUrl(relay: string, room: string, http = false): string {
  const url = new URL(relay);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid relay URL");
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  url.protocol = http ? (secure ? "https:" : "http:") : secure ? "wss:" : "ws:";
  url.pathname = `/rooms/${encodeURIComponent(room)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function makeHello(
  room: string,
  identity: Identity,
  challenge: string,
): Promise<Hello> {
  return {
    t: "hello",
    room,
    memberId: identity.id,
    challenge,
    sig: sign(`agentcomms/hello/v1|${room}|${identity.id}|${challenge}`, identity),
  };
}

// Human CLI control sessions never subscribe to message bodies.
export async function relayControl(
  invite: Pick<Invite, "relay" | "room">,
  first: Identity | Extract<ClientMessage, { t: "join" }>,
) {
  const socket = new WebSocket(relayUrl(invite.relay, invite.room), {
    maxPayload: FRAME_MAX,
    handshakeTimeout: 10000,
  });
  const queue: RelayMessage[] = [];
  let failure: Error | undefined;
  let waiting:
    | { resolve: (message: RelayMessage) => void; reject: (error: Error) => void }
    | undefined;
  const fail = (error: Error) => {
    failure = error;
    waiting?.reject(error);
    waiting = undefined;
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Relay connection closed")));
  socket.on("message", (raw, binary) => {
    try {
      if (binary) throw new Error("Invalid relay frame");
      const message = relayMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.t === "refused") throw new Error(`Relay refused: ${message.reason}`);
      if (waiting) {
        const current = waiting;
        waiting = undefined;
        current.resolve(message);
      } else queue.push(message);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Invalid relay frame"));
      socket.terminate();
    }
  });
  const deadline = setTimeout(() => {
    fail(new Error("Relay request timed out"));
    socket.terminate();
  }, 15000);
  const close = () => {
    clearTimeout(deadline);
    socket.close();
  };
  const next = async (): Promise<RelayMessage> => {
    if (failure) throw failure;
    const message = queue.shift();
    if (message) return message;
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };
  let directory: Extract<RelayMessage, { t: "directory" }> | undefined;
  let pending: Member[] = [];
  const snapshot = async () => {
    while (true) {
      const message = await next();
      if (message.t === "directory") directory = message;
      if (message.t === "pending") pending = message.members;
      if (message.t === "grants") return { directory, pending, grants: message.grants };
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Relay connection closed")));
    });
    const challenge = await next();
    if (challenge.t !== "challenge") throw new Error("Missing relay challenge");
    socket.send(
      JSON.stringify(
        "kind" in first ? await makeHello(invite.room, first, challenge.challenge) : first,
      ),
    );
    const initial = await snapshot();
    return {
      ...initial,
      async change(message: Extract<ClientMessage, { t: "approve" | "remove" }>) {
        socket.send(JSON.stringify(message));
        return snapshot();
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
