import { BUILTIN_ROLES, COMMS_CREW, type CrewRow, HUD_STATE_LABEL } from "@mc/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { callSign, seatRoleTitle } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import type { RailEdgeView, RailSeatView } from "./CommsRails.tsx";
import {
  type Flow,
  type Flows,
  type LastMessage,
  type OpenItem,
  presenceOf,
  type Waiting,
} from "./chartTypes.ts";
import type { RailGroup } from "./rails.ts";

/** One direction of a link over the window, with its newest message (absent on older hubs). */
type Link = {
  from: string;
  to: string;
  count: number;
  lastId?: string;
  lastAt?: number;
  lastText?: string;
};

export const CAPCOM = "CAPCOM";
const MC = "MC";
/** Observed loops share one group. */
export const LOOPS_GROUP = "LOOPS";

export function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** System reports belong to CAPCOM; historical FLIGHT reports follow the configured seat. */
export function canonicalEndpoint(id: string, flight: string): string {
  if (id === MC) return CAPCOM;
  if (id === "FLIGHT") return flight;
  return id;
}

/** `Idle`, `Paused`, `Crew paused`, ...: the HUD's word for a seat's state. */
function stateLabel(row: CrewRow): string {
  if (row.crewPause != null) return "Crew paused";
  if (row.paused) return "Paused";
  return HUD_STATE_LABEL[row.hudState];
}

const newer = (a: LastMessage | null, b: LastMessage | null) =>
  a === null ? b : b === null ? a : b.at > a.at ? b : a;

/** Built-in roles first in their own order, then configured roles A–Z, then the loops. */
function groupOrder(keys: string[]): string[] {
  const builtin = Object.keys(BUILTIN_ROLES);
  const rank = (key: string) =>
    key === LOOPS_GROUP ? Number.POSITIVE_INFINITY : builtin.indexOf(key) + 1 || builtin.length + 1;
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The seats' role groups: one per role (and one for the loops), seats in config order. */
export function groupsFor(rows: readonly CrewRow[], flight: string): RailGroup[] {
  const groups = new Map<string, CrewRow[]>();
  for (const row of rows) {
    if (row.id === flight) continue;
    const key = row.kind === "loop" ? LOOPS_GROUP : (row.role ?? "CREW");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groupOrder([...groups.keys()]).map((key) => {
    const ids = (groups.get(key) ?? []).sort((a, b) => a.index - b.index).map((row) => row.id);
    return { key, ids, header: ids.length > 1 };
  });
}

/** What is waiting, per pair: how many, the longest wait, who asked and the oldest question. */
export function waitingByPair(
  items: readonly OpenItem[],
  flight: string,
  known: ReadonlySet<string>,
): Map<string, Waiting> {
  const out = new Map<string, Waiting>();
  for (const item of items) {
    const from = canonicalEndpoint(item.from, flight);
    const to = canonicalEndpoint(item.to, flight);
    if (!known.has(from) || !known.has(to) || from === to) continue;
    const [a, b] = pair(from, to);
    const key = `${a}\0${b}`;
    const before = out.get(key);
    const longest = before === undefined || item.waitedMs > before.ms;
    out.set(key, {
      n: (before?.n ?? 0) + 1,
      ms: Math.max(before?.ms ?? 0, item.waitedMs),
      asker: longest ? from : (before?.asker ?? from),
      question: longest ? (item.question ?? item.text ?? null) : (before?.question ?? null),
    });
  }
  return out;
}

/**
 * Everything the Comms chart draws, from the crew and the hub's links and open items. Used by the
 * panel on the Comms page and by the full-screen view, so the two show the same chart.
 */
export function useChartData(rows: CrewRow[], flightId: string | undefined) {
  const linksResource = useResource<{ links: Link[] }>(RESOURCES.commsLinks);
  const links = linksResource.data?.links;
  // Live only while the links are loaded and the last read of them succeeded.
  const streaming = links !== undefined && linksResource.error === null;
  const openItems = useResource<{ items: OpenItem[] }>(RESOURCES.commsOpen).data?.items;
  const [flows, setFlows] = useState<Flows>({ generation: 0, list: [] });
  const previousLinks = useRef<Map<string, { count: number; lastId?: string }> | null>(null);

  const crewRows = useMemo(() => rows.filter((row) => row.kind === "crew"), [rows]);
  const flight = flightId ?? crewRows.find((row) => row.role === "FLIGHT")?.id ?? "FLIGHT";
  const known = useMemo(
    () => new Set([CAPCOM, COMMS_CREW, flight, ...rows.map((row) => row.id)]),
    [rows, flight],
  );

  // New messages are read from the links alone (raw endpoints), so crew rows or the FLIGHT seat
  // resolving later neither re-run this nor make a link that just became visible look new. A link
  // has new messages when its count rises or its newest message changes (the 24h window can drop
  // an old one as a new one lands, leaving the count where it was).
  useEffect(() => {
    if (links === undefined) return;
    const current = new Map<string, { count: number; lastId?: string }>();
    for (const link of links) {
      const key = `${link.from}\0${link.to}`;
      const seen = current.get(key);
      current.set(key, {
        count: (seen?.count ?? 0) + link.count,
        lastId: link.lastId ?? seen?.lastId,
      });
    }
    const previous = previousLinks.current;
    previousLinks.current = current;
    if (previous === null) return;
    const fresh: Flow[] = [];
    for (const [key, now] of current) {
      const before = previous.get(key);
      const rise = now.count - (before?.count ?? 0);
      const moved = now.lastId !== undefined && before?.lastId !== now.lastId;
      const n = Math.max(rise, moved ? 1 : 0);
      if (n > 0) {
        const [from = "", to = ""] = key.split("\0");
        fresh.push({ from, to, n });
      }
    }
    if (fresh.length > 0) setFlows((last) => ({ generation: last.generation + 1, list: fresh }));
  }, [links]);
  const canonicalFlows = useMemo<Flows>(
    () => ({
      generation: flows.generation,
      list: flows.list.flatMap((flow) => {
        const from = canonicalEndpoint(flow.from, flight);
        const to = canonicalEndpoint(flow.to, flight);
        return from !== to && known.has(from) && known.has(to) ? [{ ...flow, from, to }] : [];
      }),
    }),
    [flight, known, flows],
  );

  const waiting = useMemo(
    () => waitingByPair(openItems ?? [], flight, known),
    [openItems, flight, known],
  );

  const edges = useMemo<RailEdgeView[]>(() => {
    const combined = new Map<
      string,
      { a: string; b: string; aToB: number; bToA: number; last: LastMessage | null }
    >();
    for (const link of links ?? []) {
      const from = canonicalEndpoint(link.from, flight);
      const to = canonicalEndpoint(link.to, flight);
      if (!known.has(from) || !known.has(to) || from === to) continue;
      const [a, b] = pair(from, to);
      const value = combined.get(`${a}\0${b}`) ?? { a, b, aToB: 0, bToA: 0, last: null };
      if (from === a) value.aToB += link.count;
      else value.bToA += link.count;
      if (link.lastAt !== undefined && link.lastText !== undefined)
        value.last = newer(value.last, { from, to, text: link.lastText, at: link.lastAt });
      combined.set(`${a}\0${b}`, value);
    }
    // A question nobody has answered shows even where no message passed in the window.
    for (const key of waiting.keys()) {
      if (combined.has(key)) continue;
      const [a = "", b = ""] = key.split("\0");
      combined.set(key, { a, b, aToB: 0, bToA: 0, last: null });
    }
    const heaviest = Math.max(1, ...[...combined.values()].map((e) => e.aToB + e.bToA));
    return [...combined].map(([key, e]) => ({
      key,
      ...e,
      weight: Math.sqrt((e.aToB + e.bToA) / heaviest),
      waiting: waiting.get(key) ?? null,
    }));
  }, [flight, known, links, waiting]);

  const groups = useMemo(() => groupsFor(rows, flight), [rows, flight]);

  const seats = useMemo<RailSeatView[]>(() => {
    const sentBy = (id: string) =>
      edges.reduce((n, e) => n + (e.a === id ? e.aToB : e.b === id ? e.bToA : 0), 0);
    const receivedBy = (id: string) =>
      edges.reduce((n, e) => n + (e.a === id ? e.bToA : e.b === id ? e.aToB : 0), 0);
    const hub = (id: string, name: string, color: string, row?: CrewRow): RailSeatView => ({
      id,
      name,
      role: row ? (seatRoleTitle(row.id, rows, undefined) ?? row.role) : null,
      color,
      presence: row ? presenceOf(row) : "idle",
      state: row ? stateLabel(row) : null,
      since: row?.stateSince ?? null,
      alert: row ? row.hudState === "error" || row.hudState === "stalled" : false,
      hub: true,
      sent: sentBy(id),
      received: receivedBy(id),
    });
    const flightRow = rows.find((row) => row.id === flight);
    return [
      hub(CAPCOM, CAPCOM, "var(--fg)"),
      hub(flight, "FLIGHT", "var(--accent)", flightRow),
      hub(COMMS_CREW, "#crew", "var(--fg-2)"),
      ...rows
        .filter((row) => row.id !== flight)
        .map(
          (row): RailSeatView => ({
            id: row.id,
            name: callSign(row),
            role:
              row.kind === "loop"
                ? `${LOOPS_GROUP.toLowerCase()} · observed`
                : (seatRoleTitle(row.id, rows, undefined) ?? row.role),
            color: agentColor(row.index),
            presence: presenceOf(row),
            state: stateLabel(row),
            since: row.stateSince,
            alert: row.hudState === "error" || row.hudState === "stalled",
            hub: false,
            sent: sentBy(row.id),
            received: receivedBy(row.id),
          }),
        ),
    ];
  }, [edges, flight, rows]);

  return {
    flight,
    known,
    groups,
    seats,
    edges,
    flows: canonicalFlows,
    streaming,
    hasData: links !== undefined,
    openCount: edges.filter((e) => e.waiting !== null).length,
    hubIds: [CAPCOM, flight, COMMS_CREW] as const,
  };
}
