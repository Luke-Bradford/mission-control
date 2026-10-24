import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { type Directory, verifyGrant } from "./auth.ts";
import { canonicalJson } from "./canonical.ts";
import {
  BODY_MAX,
  BodyTooLarge,
  knowledgeSchema,
  type Message,
  messageSchema,
  open,
  scanMessage,
  seal,
  verifyEnvelopeSignature,
  verifySealed,
} from "./envelope.ts";
import { mayAutoReply, outgoingRate, similarOpen } from "./guards.ts";
import { type InboxEntry, openInbox, type Thread } from "./inbox.ts";
import { type Delegation, type Identity, verifyDelegation } from "./keys.ts";
import { type Invite, type Member, unwrapRoomKey } from "./membership.ts";
import { type ClientMessage, relayMessageSchema } from "./protocol.ts";
import { makeHello, relayUrl } from "./relay-client.ts";
import { FRAME_MAX } from "./relay-session.ts";
import { readRoomKeys, saveRoomKeys } from "./room-keys.ts";
import { acceptDirectory, readTrust } from "./trust.ts";

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.on("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export type Draft = Omit<Message, "id" | "sentAt" | "auto">;
export type SendResult = { seq: number } | { held: string } | { merged: string };
type Presence = Record<string, { status: string; seenAt: number }>;
const answerSchema = z.strictObject({
  body: z.string(),
  knowledge: knowledgeSchema.optional(),
});
export interface Daemon {
  send(room: string, draft: Draft): Promise<SendResult>;
  read(room: string, sinceSeq?: number, limit?: number): InboxEntry[];
  presence(room: string): Presence;
  stop(): Promise<void>;
  rooms(): { room: string; relay: string; status?: string; error?: string }[];
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
  const startedAt = Date.now();
  const hooks = new Set<ReturnType<typeof spawn>>();
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
    verified: undefined as Directory | undefined,
    status: "connecting",
    error: undefined as string | undefined,
    hookTimes: [] as number[],
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
    state.verified = await readTrust(opts.home, state.invite);
    state.epoch = state.verified?.keyEpoch ?? 0;
    state.directory = state.verified?.members ?? [];
    state.activeMemberIds = state.verified?.activeMemberIds ?? [];
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
      if (draft.kind === "request" && !draft.reason?.trim())
        throw new Error("a request needs a reason");
      messageSchema.parse({ ...draft, id: "validation", sentAt: new Date().toISOString(), auto });
      if (scanMessage(draft)) return { held: "Message contains a possible secret" };
      if (draft.kind === "question") {
        const thread = similarOpen(room, draft.body, inbox);
        if (thread) return { merged: thread };
      }
      const persisted = await readTrust(opts.home, state.invite);
      if (persisted && (!state.verified || persisted.version > state.verified.version)) {
        state.verified = persisted;
        state.epoch = persisted.keyEpoch;
        state.directory = persisted.members;
        state.activeMemberIds = persisted.activeMemberIds;
        state.keys = await readRoomKeys(opts.home, state.invite.room);
      }
      if (state.epoch < Math.max(0, ...state.keys.keys()))
        return { held: "Waiting for owner-signed state for the newest verified key" };
      const key = state.keys.get(state.epoch);
      if (!state.verified || !key)
        return { held: "Room key unavailable; human approval is required" };
      if (!state.directory.some((member) => member.agents.some((entry) => entry.id === agent.id)))
        return { held: "Agent is not in the owner-signed active set" };
      if (!state.connected) return { held: "Relay disconnected; retry after reconnect" };
      if (!rate.allow()) return { held: "Outgoing rate limit: 10 messages per minute" };
      const msg: Message = { ...draft, id: randomUUID(), sentAt: new Date().toISOString(), auto };
      const sealed = await seal(msg, agent, key, state.epoch, delegation);
      if (sealed.keyEpoch !== state.epoch || sealed.keyEpoch < Math.max(...state.keys.keys()))
        return { held: "Verified epoch changed while sealing; retry" };
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
    if (inbox.threads(state.invite.room).some((t) => t.thread === msg.thread && t.closed)) return;
    const output = await new Promise<string>((resolve) => {
      const child = spawn(opts.answer as string, {
        shell: true,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let failed = false;
      const kill = () => {
        failed = true;
        killProcessGroup(child);
      };
      const timer = setTimeout(kill, 30000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > BODY_MAX * 4) kill();
      });
      child.stderr.resume();
      child.on("error", () => {
        failed = true;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        hooks.delete(child);
        resolve(failed || code !== 0 ? "" : output.trim());
      });
      hooks.add(child);
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(msg));
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
    if (
      reply.body.trim() &&
      !stopped &&
      !inbox.threads(state.invite.room).some((t) => t.thread === msg.thread && t.closed)
    )
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
  const answerQueue: { state: State; msg: Message }[] = [];
  let answering = false;
  const enqueueAnswer = (state: State, msg: Message) => {
    const now = Date.now();
    state.hookTimes = state.hookTimes.filter((at) => at > now - 60000);
    if (state.hookTimes.length >= 10 || answerQueue.length >= 5 || !opts.answer) return;
    state.hookTimes.push(now);
    answerQueue.push({ state, msg });
    if (answering) return;
    answering = true;
    const task = (async () => {
      while (!stopped && answerQueue.length) {
        const next = answerQueue.shift();
        if (next) {
          try {
            await answer(next.state, next.msg);
          } catch {
            /* Held or invalid answer. */
          }
        }
      }
    })().finally(() => {
      answering = false;
      hookTasks.delete(task);
    });
    hookTasks.add(task);
  };
  const connect = (state: State) => {
    if (stopped) return;
    const connectedAt = Date.now();
    state.status = "connecting";
    const socket = new WebSocket(relayUrl(state.invite.relay, state.invite.room), {
      maxPayload: FRAME_MAX,
      handshakeTimeout: 10000,
    });
    state.socket = socket;
    socket.on("message", (raw, binary) => {
      state.incoming = state.incoming
        .then(async () => {
          if (stopped || socket !== state.socket || binary) return;
          const value = JSON.parse(raw.toString());
          const parsed = relayMessageSchema.safeParse(value);
          if (!parsed.success) {
            if (
              value?.t === "msg" &&
              Number.isSafeInteger(value.seq) &&
              value.seq > inbox.lastSeq(state.invite.room) &&
              value.sealed?.room === state.invite.room &&
              (await verifyEnvelopeSignature(value.sealed, (id) => Buffer.from(id, "base64url")))
            ) {
              inbox.quarantine(
                value.seq,
                state.invite.room,
                value.sealed,
                "Invalid signed envelope metadata",
              );
            }
            return;
          }
          const incoming = parsed.data;
          if (incoming.t === "challenge") {
            write(state, await makeHello(state.invite.room, agent, incoming.challenge));
          } else if (incoming.t === "directory") {
            const { t: _, ...directory } = incoming;
            state.verified = await acceptDirectory(
              opts.home,
              state.invite,
              directory,
              state.verified,
            );
            state.directory = state.verified.members;
            state.activeMemberIds = state.verified.activeMemberIds;
            state.epoch = state.verified.keyEpoch;
          } else if (incoming.t === "pending") {
            state.error = "Unexpected pending membership requests";
          } else if (incoming.t === "grants") {
            for (const grant of incoming.grants) {
              try {
                if (
                  grant.memberId !== agent.id ||
                  !verifyGrant(state.invite.room, grant, state.invite.ownerId)
                )
                  throw new Error("Invalid owner-signed grant");
                const key = await unwrapRoomKey(grant, agent);
                const previous = state.keys.get(grant.keyEpoch);
                if (previous && !Buffer.from(previous).equals(key))
                  throw new Error("Conflicting room key grant");
                state.keys.set(grant.keyEpoch, key);
              } catch (error) {
                state.error = error instanceof Error ? error.message : "Invalid grant";
              }
            }
            if (incoming.grants.length)
              await saveRoomKeys(opts.home, state.invite.room, state.keys);
            if (!state.verified) {
              state.status = "pending";
              return;
            }
            state.status = state.keys.has(state.epoch) ? "connected" : "pending";
            if (
              !state.connected &&
              socket === state.socket &&
              socket.readyState === WebSocket.OPEN
            ) {
              state.connected = true;
              write(state, { t: "since", seq: inbox.lastSeq(state.invite.room) });
              write(state, { t: "presence", status: "online" });
              state.heartbeat = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN)
                  write(state, { t: "presence", status: "online" });
              }, 30000);
            }
          } else if (incoming.t === "presence") state.presence = incoming.map;
          else if (incoming.t === "refused") {
            state.status = incoming.reason === "bad-hello" ? "pending" : "refused";
            state.error = incoming.reason;
            failPending(state, new Error(`Relay refused: ${incoming.reason}`));
          } else {
            if (
              incoming.sealed.room !== state.invite.room ||
              incoming.seq <= inbox.lastSeq(state.invite.room)
            )
              return;
            const sender = incoming.sealed.sender;
            try {
              if (!(await verifySealed(incoming.sealed, (id) => Buffer.from(id, "base64url"))))
                throw new Error("Invalid message signature");
              const member = state.directory.find(
                (m) => m.id === sender.id || m.agents.some((a) => a.id === sender.id),
              );
              const sendingAgent = member?.agents.find((a) => a.id === sender.id);
              if (
                !member ||
                !state.activeMemberIds.includes(member.id) ||
                (sendingAgent
                  ? sender.kind !== "agent" ||
                    canonicalJson(sender.delegation) !== canonicalJson(sendingAgent.delegation)
                  : sender.kind !== "human" || sender.delegation !== undefined)
              )
                throw new Error("Sender not in owner-signed active directory");
              if (!state.verified || incoming.sealed.keyEpoch !== state.epoch)
                throw new Error("Message epoch is not the current verified epoch");
              const key = state.keys.get(state.epoch);
              if (!key) throw new Error("Verified room key unavailable (missing or invalid grant)");
              const publicKeyOf = (id: string) =>
                state.directory.some((m) => m.id === id || m.agents.some((a) => a.id === id))
                  ? Buffer.from(id, "base64url")
                  : undefined;
              const msg = await open(incoming.sealed, key, publicKeyOf);
              if (
                incoming.sealed.keyEpoch !== state.epoch ||
                !state.activeMemberIds.includes(member.id)
              )
                throw new Error("Membership rotated while opening message");
              const added = inbox.add(incoming.seq, state.invite.room, msg, {
                ...sender,
                member: { id: member.id, label: member.label },
              });
              if (sender.id === agent.id && state.pending?.id === msg.id) {
                clearTimeout(state.pending.timer);
                state.pending.resolve({ seq: incoming.seq });
                state.pending = undefined;
              }
              const name = delegation.agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const mentioned = new RegExp(
                `(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`,
                "u",
              ).test(msg.body);
              if (
                added &&
                sender.id !== agent.id &&
                mayAutoReply(msg) &&
                Date.parse(msg.sentAt) >= startedAt &&
                !inbox
                  .threads(state.invite.room)
                  .some((t) => t.thread === msg.thread && t.closed) &&
                (msg.kind === "question" || msg.kind === "request") &&
                (mentioned || state.activeMemberIds.length === 2)
              )
                enqueueAnswer(state, msg);
            } catch (error) {
              inbox.quarantine(
                incoming.seq,
                state.invite.room,
                incoming.sealed,
                error instanceof Error ? error.message : "Undeliverable message",
              );
            }
          }
        })
        .catch((error) => {
          state.error = error instanceof Error ? error.message : "Invalid relay frame";
        });
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      state.connected = false;
      if (state.status !== "pending") state.status = "disconnected";
      clearInterval(state.heartbeat);
      failPending(state, new Error("Relay disconnected; delivery unknown, read before retrying"));
      if (!stopped) {
        if (Date.now() - connectedAt >= 60000) state.backoff = 1000;
        state.reconnect = setTimeout(() => connect(state), state.backoff);
        state.backoff = Math.min(state.backoff * 2, 30000);
      }
    });
  };
  for (const state of states) connect(state);
  const daemon: Daemon = {
    send: (room, draft) => send(room, draft, false),
    read: (room, sinceSeq, limit) => {
      stateFor(room);
      return inbox.list(room, sinceSeq, limit);
    },
    presence(room) {
      const map = structuredClone(stateFor(room).presence);
      for (const entry of Object.values(map))
        if (Date.now() - entry.seenAt > 90000) entry.status = "gone";
      return map;
    },
    rooms: () =>
      states.map(({ invite, status, error }) => ({
        room: invite.room,
        relay: invite.relay,
        status,
        ...(error ? { error } : {}),
      })),
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
      for (const hook of hooks) killProcessGroup(hook);
      await Promise.all(states.flatMap((state) => [state.incoming, state.outgoing]));
      await Promise.all(hookTasks);
      inbox.dispose();
    },
  };
  return daemon;
}
