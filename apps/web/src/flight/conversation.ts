import type { AgentStream } from "@mc/core";
import { type FlightDecision, MC_LINE_PREFIX } from "./flightTypes.ts";

export type DockRow =
  | { kind: "you"; id: string; at: number | null; text: string; pending?: true }
  | { kind: "flight"; id: string; at: number | null; text: string }
  | { kind: "hub"; id: string; at: number | null; text: string }
  | { kind: "decision"; id: string; at: number; d: FlightDecision };

const HUB_LINE_MAX = 160;
const KEPT_WITHOUT_RUN = 20;

export const FLIGHT_KIND_LABEL: Readonly<Record<string, string>> = {
  answer: "Answered",
  pass: "Passed to you",
  start: "Started",
  promote: "Promoted",
  message: "Messaged",
  unpark: "Un-parked",
  note: "Noted",
};

/** The label for a decision kind; a kind the web does not know yet shows as written. */
export const kindLabel = (kind: string): string => FLIGHT_KIND_LABEL[kind] ?? kind;

/** What Overturn sends FLIGHT, as the operator's own message. */
export const overturnText = (
  d: Pick<FlightDecision, "id" | "about" | "decision">,
  call: string | null,
): string =>
  `I am overturning your decision ${d.id} (${d.about}: ${d.decision}).${call === null ? "" : ` Tell ${call} to hold that point.`} Then ask me what I prefer.`;

function hubLine(text: string): string {
  const rest = text.slice(MC_LINE_PREFIX.length).replace(/^ /, "");
  const line = rest.split("\n")[0] ?? "";
  return line.length > HUB_LINE_MAX ? `${line.slice(0, HUB_LINE_MAX - 1)}…` : line;
}

/** The Chat tab's rows: only what the operator and FLIGHT said to each other. */
export const chatRows = (rows: readonly DockRow[]): DockRow[] =>
  rows.filter((r) => r.kind === "you" || r.kind === "flight");

/** The Feed tab's rows: Mission Control's wake lines and FLIGHT's decisions. */
export const feedRows = (rows: readonly DockRow[]): DockRow[] =>
  rows.filter((r) => r.kind === "hub" || r.kind === "decision");

/**
 * Messages sent but not yet in FLIGHT's stream, as `you` rows marked pending. One is settled once
 * the stream holds more of that text than when it was sent (`seen`).
 */
export interface PendingMsg {
  id: string;
  text: string;
  at: number;
  seen: number;
}

export function withPending(
  rows: readonly DockRow[],
  pending: readonly PendingMsg[],
): { rows: DockRow[]; open: PendingMsg[] } {
  const have = new Map<string, number>();
  for (const r of rows) if (r.kind === "you") have.set(r.text, (have.get(r.text) ?? 0) + 1);
  const open = pending.filter((p) => (have.get(p.text) ?? 0) <= p.seen);
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
          ? { kind: "hub", id: e.id, at: e.at, text: hubLine(e.text) }
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
