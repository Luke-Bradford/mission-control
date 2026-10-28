import { type AgentStream, startOfLocalDay } from "@mc/core";
import { type FlightDecision, MC_LINE_PREFIX } from "./flightTypes.ts";

export type DockRow =
  | { kind: "you"; id: string; at: number | null; text: string; pending?: true }
  | { kind: "flight"; id: string; at: number | null; text: string }
  | { kind: "hub"; id: string; at: number | null; text: string }
  | { kind: "decision"; id: string; at: number; d: FlightDecision };

const KEPT_WITHOUT_RUN = 20;

export const FLIGHT_KIND_LABEL: Readonly<Record<string, string>> = {
  answer: "Answered",
  pass: "Passed to you",
  start: "Started",
  promote: "Promoted",
  message: "Messaged",
  unpark: "Un-parked",
  note: "Noted",
  brief: "Brief",
};

/** The label for a decision kind; a kind the web does not know yet shows as written. */
export const kindLabel = (kind: string): string => FLIGHT_KIND_LABEL[kind] ?? kind;

/** What Overturn sends FLIGHT, as the operator's own message. */
export const overturnText = (
  d: Pick<FlightDecision, "id" | "about" | "decision">,
  call: string | null,
): string =>
  `I am overturning your decision ${d.id} (${d.about}: ${d.decision}).${call === null ? "" : ` Tell ${call} to hold that point.`} Then ask me what I prefer.`;

/** The decisions "Decided without you" lists: FLIGHT's answers, and the tickets it closed or reordered. */
export const DECIDED_KINDS: readonly FlightDecision["kind"][] = ["answer", "close", "reorder"];

/** FLIGHT's decisions of those kinds since the start of the local day. */
export const decidedToday = (
  decisions: readonly FlightDecision[],
  now: number,
  tz: string,
): FlightDecision[] => {
  const from = startOfLocalDay(now, tz);
  return decisions.filter((d) => DECIDED_KINDS.includes(d.kind) && d.at >= from);
};

/** The dock's rows: only what the operator and FLIGHT said to each other. */
export const chatRows = (rows: readonly DockRow[]): DockRow[] =>
  rows.filter((r) => r.kind === "you" || r.kind === "flight");

/**
 * Messages sent but not yet in FLIGHT's stream, as `you` rows marked pending. One is settled once
 * the stream holds a copy of that text that was not there when it was sent (`seen`: the ids of the
 * copies that were; the stream is a window, so an older copy may roll out, and a count would miss it).
 */
export interface PendingMsg {
  id: string;
  text: string;
  at: number;
  seen: readonly string[];
}

/** The stream's copy of a sent message: the hub cuts long text to end in "…", so a cut copy matches too. */
export const sameMessage = (streamed: string, sent: string): boolean =>
  streamed === sent || (streamed.endsWith("…") && sent.startsWith(streamed.slice(0, -1)));

export function withPending(
  rows: readonly DockRow[],
  pending: readonly PendingMsg[],
): { rows: DockRow[]; open: PendingMsg[] } {
  const open = pending.filter(
    (p) =>
      !rows.some((r) => r.kind === "you" && sameMessage(r.text, p.text) && !p.seen.includes(r.id)),
  );
  return {
    rows: [
      ...rows,
      ...open.map(
        (p): DockRow => ({ kind: "you", id: p.id, at: p.at, text: p.text, pending: true }),
      ),
    ],
    open,
  };
}

/** The dock's rows from FLIGHT's stream and its decisions, in time order. */
export function dockRows(
  stream: AgentStream | undefined,
  decisions: readonly FlightDecision[],
): DockRow[] {
  const rows: DockRow[] = [];
  for (const e of stream?.events ?? []) {
    if (e.kind === "op") {
      rows.push(
        e.text.startsWith(MC_LINE_PREFIX)
          ? {
              kind: "hub",
              id: e.id,
              at: e.at,
              text: e.text.slice(MC_LINE_PREFIX.length).replace(/^ /, ""),
            }
          : { kind: "you", id: e.id, at: e.at, text: e.text },
      );
    } else if (e.kind === "msg") {
      rows.push({ kind: "flight", id: e.id, at: e.at, text: e.text });
    }
  }
  const firstAt = stream?.events[0]?.at ?? null;
  const kept =
    stream === undefined || stream.events.length === 0
      ? [...decisions].sort((a, b) => b.at - a.at).slice(0, KEPT_WITHOUT_RUN)
      : firstAt === null
        ? [...decisions]
        : decisions.filter((d) => d.at >= firstAt);
  const pending = kept
    .map((d): DockRow => ({ kind: "decision", id: `d:${d.id}`, at: d.at, d }))
    .sort((a, b) => (a.at as number) - (b.at as number));
  // Decisions slot in before the first stream row that is later than them; a row with no time
  // keeps its place in the stream.
  const out: DockRow[] = [];
  let next = 0;
  for (const r of rows) {
    while (r.at !== null && next < pending.length && (pending[next]?.at as number) < r.at) {
      out.push(pending[next++] as DockRow);
    }
    out.push(r);
  }
  out.push(...pending.slice(next));
  return out;
}
