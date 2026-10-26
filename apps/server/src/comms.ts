import { statSync } from "node:fs";
import {
  COMMS_CANT_REASON_MAX,
  COMMS_CAPCOM,
  COMMS_CREW,
  COMMS_MC,
  COMMS_RATE_LIMIT_COUNT,
  COMMS_RATE_LIMIT_WINDOW_MS,
  type CommsMessage,
  type CommsReaction,
  type CommsReactionKind,
  type CommsSendInput,
  type CommsThreadMessage,
  scanSecrets,
} from "@mc/core";
import { commsPosition, type Store } from "./store.ts";
import { readStream } from "./stream.ts";

export interface CommsServiceDeps {
  store: Store;
  crew: readonly string[];
  knownSecrets: () => Promise<readonly string[]>;
  now?: () => number;
  /** Only direct seat delivery wakes a worker; reactions never use it. */
  notify?: (to: string, text: string, from: string) => void;
  seatSender?: boolean;
}

const message = (row: ReturnType<Store["commsMessage"]>): CommsMessage => {
  if (row === null) throw new Error("Comms message was not stored.");
  return { ...row, operator: row.from === COMMS_CAPCOM, reactions: [] };
};

export async function validateCommsText(
  knownSecrets: () => Promise<readonly string[]>,
  text: string,
): Promise<void> {
  const findings = scanSecrets(`\0commit ${"0".repeat(40)}\n${text}`, await knownSecrets());
  if (findings.length)
    throw new Error(
      `Refused: message contains ${[...new Set(findings.map((f) => f.kind))].join(", ")}.`,
    );
}

/** Store a normal Comms message after validating the small, local address space. */
export async function sendComms(
  deps: CommsServiceDeps,
  from: string,
  input: CommsSendInput,
): Promise<CommsMessage> {
  const now = deps.now?.() ?? Date.now();
  const members = new Set([...deps.crew, COMMS_CAPCOM]);
  if (input.to !== COMMS_CREW && !members.has(input.to))
    throw new Error("Unknown Comms destination.");
  if (!members.has(from)) throw new Error("Unknown Comms sender.");
  await validateCommsText(deps.knownSecrets, input.text);
  let replyFrom: string | undefined;
  if (input.replyTo !== undefined) {
    const original = deps.store.commsMessage(input.replyTo);
    if (original === null) throw new Error("Unknown reply message.");
    if (from !== COMMS_CAPCOM && !canReadComms(deps.store, from, original))
      throw new Error("You cannot reply to that Comms message.");
    replyFrom = original.from;
  }
  const mentions = new Set<string>();
  for (const found of input.text.matchAll(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+)\b/g)) {
    if (members.has(found[2])) mentions.add(found[2]);
  }
  if (replyFrom !== undefined) mentions.add(replyFrom);
  const stored = deps.store.addComms(
    {
      at: now,
      from,
      to: input.to,
      ticket: input.ref ?? null,
      text: input.text,
      label: input.label,
      ref: input.ref,
      replyTo: input.replyTo,
      mentions: [...mentions],
    },
    deps.seatSender
      ? { since: now - COMMS_RATE_LIMIT_WINDOW_MS, limit: COMMS_RATE_LIMIT_COUNT }
      : undefined,
  );
  if (stored === null) throw new Error("Comms rate limit reached: 30 messages per 10 minutes.");
  const notify = new Set<string>();
  if (deps.crew.includes(input.to)) notify.add(input.to);
  for (const mention of mentions) if (deps.crew.includes(mention)) notify.add(mention);
  for (const to of notify) deps.notify?.(to, input.text, from);
  return message(stored);
}

export function canReadComms(
  store: Store,
  actor: string,
  message: NonNullable<ReturnType<Store["commsMessage"]>>,
): boolean {
  return (
    message.to === COMMS_CREW ||
    message.from === actor ||
    message.to === actor ||
    message.mentions.includes(actor) ||
    store.commsPins().some((pin) => pin.id === message.id) ||
    (message.replyTo !== null && store.commsMessage(message.replyTo)?.from === actor)
  );
}

export function reactComms(
  store: Store,
  actor: string,
  id: string,
  reaction: CommsReactionKind,
  reason: string | undefined,
  at: number,
): CommsReaction {
  if (
    reaction === "cant" &&
    (reason === undefined || reason.trim() === "" || reason.length > COMMS_CANT_REASON_MAX)
  )
    throw new Error("A nonblank reason of at most 80 characters is required for cant.");
  if (reaction !== "cant" && reason !== undefined)
    throw new Error("Only cant may include a reason.");
  const message = store.commsMessage(id);
  if (message === null) throw new Error("Unknown Comms message.");
  if (actor !== COMMS_CAPCOM && !canReadComms(store, actor, message))
    throw new Error("You cannot react to that Comms message.");
  const added = store.addCommsReaction(id, actor, reaction, reason, at);
  if (added === null) throw new Error("Unknown Comms message.");
  return added;
}

export function pinComms(
  store: Store,
  actor: string,
  id: string,
  pinned: boolean,
  at: number,
): void {
  if (!store.setCommsPinned(id, pinned, actor, at)) throw new Error("Unknown Comms message.");
}

/** A thread scans at most three transcripts, with 200 events per transcript. */
const THREAD_RUNS = 3;

const TRANSCRIPT_EVENTS = 200;
const TRANSCRIPT_CACHE_LIMIT = 128;
const transcripts = new Map<
  string,
  { size: number; mtimeMs: number; stream: ReturnType<typeof readStream> }
>();

function transcript(path: string): ReturnType<typeof readStream> {
  try {
    const { size, mtimeMs } = statSync(path);
    const cached = transcripts.get(path);
    const stream =
      cached?.size === size && cached.mtimeMs === mtimeMs
        ? cached.stream
        : readStream(path, TRANSCRIPT_EVENTS);
    transcripts.delete(path);
    transcripts.set(path, { size, mtimeMs, stream });
    if (transcripts.size > TRANSCRIPT_CACHE_LIMIT)
      transcripts.delete(transcripts.keys().next().value as string);
    return stream;
  } catch (error) {
    transcripts.delete(path);
    throw error;
  }
}

/** Shared ceiling for a displayed snapshot and its read acknowledgement. */
export const COMMS_SNAPSHOT_LIMIT = 10200;

/** Needs you scans only the newest run; the thread retains a small recent history. */
export function threadMessages(
  store: Store,
  id: string,
  crew: boolean,
  scope: "thread" | "attention" = "thread",
): CommsThreadMessage[] {
  const cursors = store.threadReadCursors(id);
  const after = scope === "attention" ? (cursors.get("comms")?.offset ?? 0) : 0;
  const rows = store.threadComms(id, after).sort((a, b) => a.at - b.at);
  const prompt =
    scope === "attention"
      ? store.threadPrompt(id)
      : rows.findLast((m) => m.from === COMMS_CAPCOM && m.to === id);
  const messages: Omit<CommsThreadMessage, "seen">[] = rows.map((m) => ({
    ...m,
    tagged: m.from !== COMMS_CAPCOM && m.from !== COMMS_MC && /@CAPCOM\b/i.test(m.text),
    direct:
      m.to === COMMS_CAPCOM &&
      m.from === id &&
      prompt !== undefined &&
      (m.at > prompt.at ||
        (m.at === prompt.at &&
          Number(m.id.slice("comms:".length)) > Number(prompt.id.slice("comms:".length)))),
  }));
  for (const run of store.runs(id, scope === "attention" ? 1 : THREAD_RUNS).reverse()) {
    if (!run.transcriptPath) continue;
    try {
      for (const event of transcript(run.transcriptPath).events) {
        if (event.kind !== "msg") continue;
        messages.push({
          id: `stream:${run.id}:${event.id}`,
          at: event.at,
          from: id,
          to: COMMS_CAPCOM,
          ticket: run.ticket,
          text: event.text,
          tagged: /@CAPCOM\b/i.test(event.text),
          // Observed loop stdout is not the crew's direct line to CAPCOM.
          // An undated event is only known to follow prompts older than its run.
          direct: crew && prompt !== undefined && (event.at ?? run.startedAt) > prompt.at,
        });
      }
    } catch {
      // A missing transcript contributes no messages.
    }
  }
  // Give undated messages a neighbouring time in their own source, without changing
  // their public timestamp. Source positions break ties within that time.
  const sourceTimes = new Map<string, number>();
  const orderTimes = new Map<string, number>();
  for (const m of messages) {
    const p = commsPosition(m.id);
    if (!p) continue;
    if (m.at !== null) sourceTimes.set(p.source, m.at);
    const at = m.at ?? sourceTimes.get(p.source);
    if (at !== undefined) orderTimes.set(m.id, at);
  }
  sourceTimes.clear();
  for (const m of messages.toReversed()) {
    const p = commsPosition(m.id);
    if (!p) continue;
    if (m.at !== null) sourceTimes.set(p.source, m.at);
    if (!orderTimes.has(m.id)) orderTimes.set(m.id, sourceTimes.get(p.source) ?? 0);
  }
  return messages
    .sort((a, b) => {
      const time = (orderTimes.get(a.id) ?? 0) - (orderTimes.get(b.id) ?? 0);
      if (time !== 0) return time;
      const ap = commsPosition(a.id);
      const bp = commsPosition(b.id);
      return ap && bp && ap.source === bp.source ? ap.offset - bp.offset || ap.block - bp.block : 0;
    })
    .slice(-COMMS_SNAPSHOT_LIMIT)
    .map((m) => {
      const position = commsPosition(m.id);
      if (position === null) return { ...m, seen: false };
      const cursor = cursors.get(position.source);
      const seen =
        cursor !== undefined &&
        (position.offset < cursor.offset ||
          (position.offset === cursor.offset && position.block <= cursor.block));
      return { ...m, seen };
    });
}

/** Direct messages that need a decision, excluding punctuation in links and code. */
export function flightQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
  return /\?|\b(please confirm|let me know|should I|which (one|option)|need (your|a) (decision|approval)|waiting (on|for) you)\b/i.test(
    prose,
  );
}
