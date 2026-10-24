import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scanText } from "@mc/core";
import { WebSocket } from "ws";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import {
  BODY_MAX,
  BodyTooLarge,
  knowledgeSchema,
  type Message,
  open,
  seal,
  verifySealed,
} from "./envelope.ts";
import { mayAutoReply, outgoingRate, similarOpen } from "./guards.ts";
import { type InboxEntry, openInbox, type Thread } from "./inbox.ts";
import { type Delegation, type Identity, verifyDelegation } from "./keys.ts";
import { type Invite, type Member, unwrapRoomKey } from "./membership.ts";
import { type ClientMessage, relayMessageSchema } from "./protocol.ts";
import { makeHello, relayUrl } from "./relay-client.ts";
import { validateMember } from "./relay-core.ts";
import { FRAME_MAX } from "./relay-session.ts";
import { readRoomKeys, saveRoomKeys } from "./room-keys.ts";

export type Draft = Omit<Message, "id" | "sentAt" | "auto">;
export type SendResult = { seq: number } | { held: string } | { merged: string };
type Presence = Record<string, { status: string; seenAt: number }>;
const answerSchema = z.strictObject({
  body: z.string(),
  knowledge: knowledgeSchema.optional(),
});
export interface Daemon {
  send(room: string, draft: Draft): Promise<SendResult>;
  read(room: string, sinceSeq?: number): InboxEntry[];
  presence(room: string): Presence;
  stop(): Promise<void>;
  rooms(): { room: string; relay: string }[];
  threads(room: string): Thread[];
}

export async function startDaemon(opts: {
  home: string;
  agent: Identity;
  delegation: Delegation;
  member: Member;
  rooms: { invite: Invite; roomKey?: Uint8Array }[];
  answer?: string;
}): Promise<Daemon> {
  const agent = structuredClone(opts.agent);
  const delegation = structuredClone(opts.delegation);
  if (
    agent.kind !== "agent" ||
    delegation.agentId !== agent.id ||
    delegation.memberId !== opts.member.id ||
    !opts.member.agents.some((entry) => entry.id === agent.id) ||
    !(await verifyDelegation(delegation, Buffer.from(opts.member.signPublicKey, "base64url")))
  ) {
    throw new Error("Daemon requires a delegated agent identity");
  }
  if (new Set(opts.rooms.map((room) => room.invite.room)).size !== opts.rooms.length)
    throw new Error("Duplicate room");
  await mkdir(opts.home, { recursive: true, mode: 0o700 });
  const rate = outgoingRate(Date.now);
  const hooks = new Set<ReturnType<typeof exec>>();
  const hookTasks = new Set<Promise<void>>();
  let stopped = false;
  type Pending = {
    id: string;
    resolve: (value: SendResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const states = opts.rooms.map(({ invite, roomKey }) => ({
    invite,
    keys: new Map<number, Uint8Array>(roomKey ? [[0, Uint8Array.from(roomKey)]] : []),
    epoch: 0,
    socket: undefined as WebSocket | undefined,
    connected: false,
    directory: [] as Member[],
    activeMemberIds: [] as string[],
    backoff: 1000,
    reconnect: undefined as ReturnType<typeof setTimeout> | undefined,
    heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
    presence: {} as Presence,
    pending: undefined as Pending | undefined,
    incoming: Promise.resolve(),
    outgoing: Promise.resolve() as Promise<unknown>,
  }));
  for (const state of states) {
    const saved = await readRoomKeys(opts.home, state.invite.room);
    for (const [epoch, key] of state.keys) if (!saved.has(epoch)) saved.set(epoch, key);
    state.keys = saved;
    state.epoch = Math.max(0, ...saved.keys());
    if (saved.size) await saveRoomKeys(opts.home, state.invite.room, saved);
  }
  const inbox = openInbox(join(opts.home, "inbox.sqlite"));
  type State = (typeof states)[number];
  const stateFor = (room: string) => {
    const state = states.find((entry) => entry.invite.room === room);
    if (!state) throw new Error("Unknown room");
    return state;
  };
  const write = (state: State, message: ClientMessage) => {
    if (state.socket?.readyState !== WebSocket.OPEN) throw new Error("Relay disconnected");
    state.socket.send(JSON.stringify(message));
  };
  const failPending = (state: State, error: Error) => {
    if (!state.pending) return;
    clearTimeout(state.pending.timer);
    state.pending.reject(error);
    state.pending = undefined;
  };
  const send = (room: string, input: Draft, auto: boolean): Promise<SendResult> => {
    const state = stateFor(room);
    const draft = structuredClone(input);
    const task = state.outgoing.then(async (): Promise<SendResult> => {
      if (stopped) throw new Error("Daemon stopped");
      if (draft.room !== room) throw new Error("Room mismatch");
      if (Buffer.byteLength(draft.body, "utf8") > BODY_MAX) throw new BodyTooLarge();
      if (scanText("message body", draft.body, []).length)
        return { held: "Message body contains a possible secret" };
      if (draft.kind === "question") {
        const thread = similarOpen(room, draft.body, inbox);
        if (thread) return { merged: thread };
      }
      const key = state.keys.get(state.epoch);
      if (!key) return { held: "Room key unavailable; human approval is required" };
      if (!state.connected) return { held: "Relay disconnected; retry after reconnect" };
      if (!rate.allow()) return { held: "Outgoing rate limit: 10 messages per minute" };
      const msg: Message = { ...draft, id: randomUUID(), sentAt: new Date().toISOString(), auto };
      const sealed = await seal(msg, agent, key, state.epoch, delegation);
      return new Promise<SendResult>((resolve, reject) => {
        const timer = setTimeout(
          () => failPending(state, new Error("Delivery unknown; read the inbox before retrying")),
          10000,
        );
        state.pending = { id: msg.id, resolve, reject, timer };
        try {
          write(state, { t: "post", sealed });
        } catch {
          failPending(state, new Error("Relay disconnected; delivery unknown"));
        }
      });
    });
    state.outgoing = task.catch(() => undefined);
    return task;
  };
  const answer = async (state: State, msg: Message) => {
    if (!opts.answer || stopped) return;
    const output = await new Promise<string>((resolve) => {
      const child = exec(
        opts.answer as string,
        { timeout: 30000, maxBuffer: BODY_MAX * 4 },
        (error, stdout) => {
          hooks.delete(child);
          resolve(error ? "" : stdout.trim());
        },
      );
      hooks.add(child);
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(msg));
    });
    if (!output || stopped) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      // Plain text remains supported; structured output must match the hook contract.
      parsed = { body: output };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      parsed = { body: output };
    const reply = answerSchema.parse(parsed);
    if (reply.body.trim() && !stopped)
      await send(
        state.invite.room,
        {
          room: state.invite.room,
          thread: msg.thread,
          inReplyTo: msg.id,
          kind: "answer",
          body: reply.body,
          knowledge: reply.knowledge ?? { kind: "cannot-confirm" },
        },
        true,
      );
  };
  const connect = (state: State) => {
    if (stopped) return;
    const socket = new WebSocket(relayUrl(state.invite.relay, state.invite.room), {
      maxPayload: FRAME_MAX,
      handshakeTimeout: 10000,
    });
    state.socket = socket;
    socket.on("open", () => {
      void makeHello(state.invite.room, agent)
        .then((hello) => {
          if (socket === state.socket && socket.readyState === WebSocket.OPEN) write(state, hello);
        })
        .catch(() => socket.terminate());
    });
    socket.on("message", (raw, binary) => {
      state.incoming = state.incoming
        .then(async () => {
          if (stopped || socket !== state.socket || socket.readyState !== WebSocket.OPEN || binary)
            return;
          const incoming = relayMessageSchema.parse(JSON.parse(raw.toString()));
          if (incoming.t === "directory") {
            for (const member of incoming.members) validateMember(member);
            state.directory = incoming.members;
            state.activeMemberIds = incoming.activeMemberIds;
            state.epoch = incoming.keyEpoch;
          } else if (incoming.t === "pending") {
            throw new Error("An agent must not receive pending membership requests");
          } else if (incoming.t === "grants") {
            for (const grant of incoming.grants) {
              if (grant.memberId !== agent.id)
                throw new Error("Grant addressed to another identity");
              const key = await unwrapRoomKey(grant, agent);
              const previous = state.keys.get(grant.keyEpoch);
              if (previous && !Buffer.from(previous).equals(key))
                throw new Error("Conflicting room key grant");
              state.keys.set(grant.keyEpoch, key);
            }
            if (incoming.grants.length)
              await saveRoomKeys(opts.home, state.invite.room, state.keys);
            if (!state.directory.length) throw new Error("Missing public key directory");
            if (!state.connected) {
              state.connected = true;
              state.backoff = 1000;
              write(state, { t: "since", seq: inbox.lastSeq(state.invite.room) });
              write(state, { t: "presence", status: "online" });
              state.heartbeat = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN)
                  write(state, { t: "presence", status: "online" });
              }, 30000);
            }
          } else if (incoming.t === "presence") state.presence = incoming.map;
          else if (incoming.t === "refused") {
            failPending(state, new Error(`Relay refused: ${incoming.reason}`));
          } else {
            if (
              incoming.sealed.room !== state.invite.room ||
              incoming.seq <= inbox.lastSeq(state.invite.room)
            )
              return;
            const key = state.keys.get(incoming.sealed.keyEpoch);
            const sender = incoming.sealed.sender;
            const member = state.directory.find(
              (m) => m.id === sender.id || m.agents.some((a) => a.id === sender.id),
            );
            const sendingAgent = member?.agents.find((a) => a.id === sender.id);
            if (
              !member ||
              (sendingAgent
                ? sender.kind !== "agent" ||
                  canonicalJson(sender.delegation) !== canonicalJson(sendingAgent.delegation)
                : sender.kind !== "human" || sender.delegation !== undefined)
            )
              throw new Error("Sender not in public key directory");
            const publicKeyOf = (id: string) => {
              for (const member of state.directory) {
                if (member.id === id) return Buffer.from(member.signPublicKey, "base64url");
                const agent = member.agents.find((a) => a.id === id);
                if (agent) return Buffer.from(agent.signPublicKey, "base64url");
              }
              return undefined;
            };
            if (!key) {
              // Approval grants only the current epoch, not earlier room history.
              if (
                state.keys.size &&
                incoming.sealed.keyEpoch < Math.min(...state.keys.keys()) &&
                (await verifySealed(incoming.sealed, publicKeyOf))
              ) {
                inbox.advance(state.invite.room, incoming.seq);
                return;
              }
              throw new Error("Room key unavailable for received epoch");
            }
            const msg = await open(incoming.sealed, key, publicKeyOf);
            inbox.add(incoming.seq, state.invite.room, msg, {
              ...sender,
              member: { id: member.id, label: member.label },
            });
            if (incoming.sealed.sender.id === agent.id && state.pending?.id === msg.id) {
              clearTimeout(state.pending.timer);
              state.pending.resolve({ seq: incoming.seq });
              state.pending = undefined;
            }
            if (
              incoming.sealed.sender.id !== agent.id &&
              mayAutoReply(msg) &&
              (msg.kind === "question" || msg.kind === "request") &&
              (msg.body.includes(delegation.agentName) || state.activeMemberIds.length === 2)
            ) {
              const task = answer(state, msg)
                .catch(() => {})
                .finally(() => hookTasks.delete(task));
              hookTasks.add(task);
            }
          }
        })
        .catch(() => socket.terminate());
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      state.connected = false;
      clearInterval(state.heartbeat);
      failPending(state, new Error("Relay disconnected; delivery unknown, read before retrying"));
      if (!stopped) {
        state.reconnect = setTimeout(() => connect(state), state.backoff);
        state.backoff = Math.min(state.backoff * 2, 30000);
      }
    });
  };
  for (const state of states) connect(state);
  const daemon: Daemon = {
    send: (room, draft) => send(room, draft, false),
    read: (room, sinceSeq) => {
      stateFor(room);
      return inbox.list(room, sinceSeq);
    },
    presence(room) {
      const map = structuredClone(stateFor(room).presence);
      for (const entry of Object.values(map))
        if (Date.now() - entry.seenAt > 90000) entry.status = "gone";
      return map;
    },
    rooms: () => states.map(({ invite }) => ({ room: invite.room, relay: invite.relay })),
    threads: (room) => {
      stateFor(room);
      return inbox.threads(room);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const state of states) {
        clearTimeout(state.reconnect);
        clearInterval(state.heartbeat);
        failPending(state, new Error("Daemon stopped"));
        state.socket?.terminate();
      }
      for (const hook of hooks) hook.kill();
      await Promise.all(states.flatMap((state) => [state.incoming, state.outgoing]));
      await Promise.all(hookTasks);
      inbox.dispose();
    },
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (states.every((state) => state.connected)) resolve();
        else if (Date.now() >= deadline) reject(new Error("Relay authentication timed out"));
        else setTimeout(check, 10);
      };
      check();
    });
    return daemon;
  } catch (error) {
    await daemon.stop();
    throw error;
  }
}
