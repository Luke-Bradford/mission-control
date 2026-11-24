import { COMMS_CREW, COMMS_FLIGHT_ESCALATION_MS, type CrewRow } from "@mc/core";
import { callSign } from "../crew.ts";
import type {
  MapHold,
  MapMessage,
  MapParticipant,
  MapRole,
  MapSnapshot,
  MapState,
  MapWait,
} from "./crewMap.ts";

export const CAPCOM = "CAPCOM";
/** The hub's own notices come from this id; the map draws them as rings, never as a seat. */
export const HUB_ID = "MC";
/** The planner and outside helper the map knows by name. */
const HELPER_ID = "CONTROLLER";
const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
/** Seats with no limit of their own are measured against this working limit. */
export const DEFAULT_CONTEXT_LIMIT = 150_000;
const HISTORY_MINUTES = 60;
const HOLDS: ReadonlySet<string> = new Set<MapHold>(["blocked", "stalled", "error"]);

/** One message of `/api/comms/feed`. */
export type FeedMessage = { id: string; from: string; to: string; at: number; text: string };
/** One unanswered question or blocker of `/api/comms/open`. */
export type OpenItem = {
  id: string;
  label: string;
  from: string;
  to: string;
  ticket: string | null;
  waitedMs: number;
  text?: string | null;
  question?: string | null;
};

export type SnapshotInput = {
  rows: readonly CrewRow[];
  flightId: string | undefined;
  feed: readonly FeedMessage[];
  open: readonly OpenItem[];
  now: number;
  /** Whether the last read of the feed and the open asks both worked. */
  ok: boolean;
};

/** System reports belong to CAPCOM's side of the hub; the old FLIGHT address follows the configured seat. */
function endpoint(id: string, flight: string): string {
  return id === "FLIGHT" ? flight : id;
}

function roleOf(row: CrewRow, flight: string): MapRole {
  if (row.id === flight || row.role === "FLIGHT") return "flight";
  if (row.role === "RETRO") return "review";
  if (row.role === "FAO") return "plan";
  return row.area.some((glob) => glob.startsWith("apps/web")) ? "web" : "server";
}

function stateOf(row: CrewRow): { state: MapState; hold: MapHold | null } {
  if (row.paused || row.crewPause != null || row.hudState === "stopped")
    return { state: "stopped", hold: null };
  if (HOLDS.has(row.hudState)) return { state: "idle", hold: row.hudState as MapHold };
  return { state: row.hudState === "running" ? "running" : "idle", hold: null };
}

/** Tokens a minute for the whole crew over the last hour, from every seat's per-minute buckets. */
function crewTokens(rows: readonly CrewRow[], now: number): Array<[number, number]> {
  const last = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const first = last - (HISTORY_MINUTES - 1) * MINUTE_MS;
  const totals = new Map<number, number>();
  for (const row of rows)
    for (const [minute, tokens] of row.digest?.minuteTokens ?? [])
      if (minute >= first && minute <= last) totals.set(minute, (totals.get(minute) ?? 0) + tokens);
  return Array.from({ length: HISTORY_MINUTES }, (_, i): [number, number] => {
    const minute = first + i * MINUTE_MS;
    return [minute, totals.get(minute) ?? 0];
  });
}

/** What the hub says now, as the one picture the map draws. Pure: no clock, no network. */
export function crewMapSnapshot(input: SnapshotInput): MapSnapshot {
  const { rows, feed, open, now } = input;
  const crew = rows.filter((row) => row.kind === "crew");
  const flight = input.flightId ?? crew.find((row) => row.role === "FLIGHT")?.id ?? "FLIGHT";
  const seats = new Set(crew.map((row) => row.id));
  const names = new Set<string>();
  for (const message of feed) {
    names.add(endpoint(message.from, flight));
    names.add(endpoint(message.to, flight));
  }
  const participants: MapParticipant[] = crew.map((row) => {
    const { state, hold } = stateOf(row);
    const digest = row.digest;
    const limit = digest?.contextWindow ?? row.contextWindow;
    return {
      id: row.id,
      label: callSign(row),
      role: roleOf(row, flight),
      kind: "seat",
      state,
      hold,
      stateSince: row.stateSince,
      ticket: row.ticket,
      ticketTitle: row.ticketTitle,
      contextTokens: digest?.contextTokens ?? null,
      contextLimit: limit,
      liveTool: digest?.liveTool?.name ?? null,
    };
  });
  participants.push({
    id: CAPCOM,
    label: CAPCOM,
    role: "operator",
    kind: "operator",
    state: names.has(CAPCOM) ? "unknown" : "nodata",
  });
  if (names.has(HELPER_ID))
    participants.push({
      id: HELPER_ID,
      label: HELPER_ID,
      role: "helper",
      kind: "helper",
      state: "unknown",
    });
  participants.push({ id: HUB_ID, label: "HUB", role: "hub", kind: "hub", state: "unknown" });

  const known = (id: string) => seats.has(id) || id === CAPCOM || id === HELPER_ID;
  const messages: MapMessage[] = feed
    .map((message) => ({
      id: message.id,
      at: message.at,
      from: endpoint(message.from, flight),
      to: endpoint(message.to, flight),
      text: message.text,
    }))
    .filter(
      (message) =>
        message.to !== COMMS_CREW &&
        message.from !== message.to &&
        (message.from === HUB_ID || known(message.from)) &&
        known(message.to),
    )
    .sort((a, b) => a.at - b.at);

  const waits: MapWait[] = [];
  let olderWaits = 0;
  let olderWaitsOldest: number | null = null;
  for (const item of open) {
    const since = now - item.waitedMs;
    // A day old or more is one quiet count; only younger asks ask for an amber cue.
    if (item.waitedMs >= DAY_MS) {
      olderWaits++;
      olderWaitsOldest = olderWaitsOldest === null ? since : Math.min(olderWaitsOldest, since);
      continue;
    }
    const from = endpoint(item.from, flight);
    const to = endpoint(item.to, flight);
    if (from === to || !known(from) || !known(to)) continue;
    waits.push({
      id: item.id,
      from,
      to,
      since,
      followUpAt: since + COMMS_FLIGHT_ESCALATION_MS,
      text: item.question ?? item.text ?? item.label,
    });
  }

  return {
    now,
    source: {
      kind: "live",
      label: "hub",
      ok: input.ok,
      ...(input.ok ? {} : { error: "The hub is not answering." }),
    },
    contextLimit: DEFAULT_CONTEXT_LIMIT,
    participants,
    messages,
    waits,
    olderWaits,
    olderWaitsOldest,
    history: { tokensPerMinute: crewTokens(crew, now) },
  };
}
