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
  commsCutMarker,
  scanSecrets,
} from "@mc/core";
import { statNoted } from "./file-deps.ts";
import { commsPosition, type Store } from "./store.ts";
import { readStream } from "./stream.ts";

export const COMMS_INBOX_PROMPT_MAX = 8_000;
export const COMMS_INBOX_PROMPT_ROWS = 40;

export interface CommsServiceDeps {
  store: Store;
  crew: () => readonly string[];
  knownSecrets: () => Promise<readonly string[]>;
  now?: () => number;
  /** Labelled direct or tagged delivery wakes a worker; reactions never use it. */
  notify?: (to: string, text: string, from: string) => void | Promise<void>;
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
  let crew = deps.crew();
  let members = new Set([...crew, COMMS_CAPCOM]);
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
  crew = deps.crew();
  members = new Set([...crew, COMMS_CAPCOM]);
  if (input.to !== COMMS_CREW && !members.has(input.to))
    throw new Error("Unknown Comms destination.");
  if (!members.has(from)) throw new Error("Unknown Comms sender.");
  const mentions = new Set<string>();
  for (const found of input.text.matchAll(/(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+)\b/g)) {
    if (members.has(found[2])) mentions.add(found[2]);
  }
  if (replyFrom !== undefined) mentions.add(replyFrom);
  const notify = new Set<string>();
  if (crew.includes(input.to)) notify.add(input.to);
  for (const to of mentions) if (crew.includes(to)) notify.add(to);
  const storeMessage = () =>
    deps.store.addComms(
      {
        at: now,
        from,
        to: input.to,
        ticket: input.ref ?? null,
        text: input.text,
        label: input.label,
        ref: input.ref,
        replyTo: input.replyTo,
        targetRunId: input.targetRunId,
        mentions: [...mentions],
      },
      deps.seatSender
        ? { since: now - COMMS_RATE_LIMIT_WINDOW_MS, limit: COMMS_RATE_LIMIT_COUNT }
        : undefined,
    );
  // A seat's rate limit is enforced atomically before it can wake anyone.
  let stored = deps.seatSender ? storeMessage() : null;
  if (deps.seatSender && stored === null)
    throw new Error("Comms rate limit reached: 30 messages per 10 minutes.");
  if (!deps.seatSender) stored = storeMessage();
  if (stored === null) throw new Error("Comms rate limit reached: 30 messages per 10 minutes.");
  const sent = message(stored);
  // FYI messages wait for the recipient's next turn. Only labelled work wakes an idle seat.
  if (sent.label !== null) for (const to of notify) await deps.notify?.(to, sent.text, sent.from);
  return sent;
}

/** The bounded Comms context supplied when a seat starts a turn. */
export function commsInboxContext(
  store: Store,
  seatId: string,
  runId: string,
): { text: string; messageIds: readonly string[] } {
  const pins = new Set(store.commsPins().map((row) => row.id));
  const rows = store
    .commsInboxRun(seatId, runId)
    .filter((row) => canReadComms(store, seatId, row, pins))
    .sort((a, b) => a.at - b.at || Number(a.id.slice(6)) - Number(b.id.slice(6)));
  let omitted = Math.max(0, rows.length - COMMS_INBOX_PROMPT_ROWS);
  const lines = rows.slice(-COMMS_INBOX_PROMPT_ROWS).map((row) => ({
    id: row.id,
    at: row.at,
    from: row.from,
    to: row.to,
    text: row.text,
    label: row.label,
    ref: row.ref,
    replyTo: row.replyTo,
    mentions: row.mentions,
    pinned: pins.has(row.id),
    unread: !store.commsInboxRead(seatId, row.id),
  }));
  const heading =
    "Comms inbox (messages addressed to you, tags, replies to your messages and pins):";
  const render = () =>
    [
      heading,
      omitted === 0 ? "" : `${omitted} older: use comms_inbox`,
      ...lines.map((line) => JSON.stringify(line)),
    ].join("\n");
  while (lines.length > 0 && render().length > COMMS_INBOX_PROMPT_MAX) {
    if (lines.length === 1) {
      const line = lines[0];
      if (line === undefined) break;
      const chars = Array.from(line.text);
      const empty = line.text;
      line.text = "";
      const room = Math.max(0, COMMS_INBOX_PROMPT_MAX - render().length);
      let kept = Math.max(0, room - 64);
      do {
        const marker = commsCutMarker(kept, chars.length);
        line.text = `${chars.slice(0, kept).join("")}${marker}`;
        kept--;
      } while (render().length > COMMS_INBOX_PROMPT_MAX && kept >= 0);
      if (line.text === empty) break;
      break;
    }
    lines.shift();
    omitted++;
  }
  return { text: render(), messageIds: lines.map((line) => line.id) };
}

/** The bounded Comms text supplied when a seat starts a turn. */
export function commsInboxPrompt(store: Store, seatId: string, runId: string): string {
  return commsInboxContext(store, seatId, runId).text;
}

export function canReadComms(
  store: Store,
  actor: string,
  message: NonNullable<ReturnType<Store["commsMessage"]>>,
  /** The pinned message ids, when the caller checks many messages and read them once. */
  pins?: ReadonlySet<string>,
): boolean {
  return (
    message.to === COMMS_CREW ||
    message.from === actor ||
    message.to === actor ||
    message.mentions.includes(actor) ||
    (pins?.has(message.id) ?? store.commsPins().some((pin) => pin.id === message.id)) ||
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
    const { size, mtimeMs } = statNoted(path);
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

/**
 * The unread lines an agent's thread raises in Needs you, by item kind: `tag`, its own `@CAPCOM`
 * tags (FLIGHT's only when they ask a question), and `message`, its own direct-line questions
 * (never FLIGHT's: its summaries are not needs). Only lines the agent wrote count, never another
 * agent's line to it. A seat's `ask_flight` question is mirrored to Comms at the instant it is
 * asked; that line is its `ask:` item alone. Shared by the attention builder and FLIGHT's brief.
 */
export function attentionChatter(
  store: Store,
  agentId: string,
  crew: boolean,
  /** The agent is FLIGHT. */
  own: boolean,
): { tag: CommsThreadMessage[]; message: CommsThreadMessage[] } {
  let asked: Set<number> | undefined;
  const mirrored = (m: CommsThreadMessage) => {
    if (!m.id.startsWith("comms:") || m.at === null) return false;
    asked ??= store.questionTimes(agentId);
    return asked.has(m.at);
  };
  const lines = threadMessages(store, agentId, crew, "attention").filter(
    (m) => !m.seen && m.from === agentId && !mirrored(m),
  );
  return {
    tag: lines.filter((m) => m.tagged && (!own || flightQuestion(m.text))),
    message: own ? [] : lines.filter((m) => m.direct && flightQuestion(m.text)),
  };
}

/** Direct messages that need a decision, excluding punctuation in links and code. */
export function flightQuestion(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
  return /\?|\b(please confirm|let me know|should I|which (one|option)|need (your|a) (decision|approval)|waiting (on|for) you)\b/i.test(
    prose,
  );
}
