import type { CommsAgentResponse, CommsMessagesResponse, CrewRow } from "@mc/core";
import { callSign, seatStatus } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { type CommsView, commsAgentPath, commsCrewPath, commsFlightPath } from "../router.ts";

/** The short area label belongs in the compact nav; path globs belong in seat detail. */
export function commsAgentRole(row: CrewRow): string {
  const area = row.area.find((label) => label.startsWith("area:"));
  return area?.slice("area:".length) || row.role?.toLowerCase() || "crew";
}

function AgentNavRow({
  row,
  view,
  onNavigate,
}: {
  row: CrewRow;
  view: CommsView;
  onNavigate: (path: string) => void;
}) {
  const data = useResource<CommsAgentResponse>(RESOURCES.commsAgent(row.id)).data;
  const messages = data?.messages ?? [];
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = messages.filter((message) => message.at !== null && message.at >= since).length;
  const unread = data?.unread ?? 0;
  const active = "agentId" in view && view.agentId === row.id;
  const status = seatStatus(row);
  return (
    <button
      type="button"
      className={`comms-nav-row${active ? " on" : ""}`}
      onClick={() => onNavigate(commsAgentPath(row.id))}
    >
      <i aria-hidden="true" style={{ background: agentColor(row.index) }} />
      <span className="comms-nav-agent">
        <b style={{ color: agentColor(row.index) }}>{callSign(row)}</b>
        <small>{`${commsAgentRole(row)} · ${status.label.toLowerCase()}`}</small>
      </span>
      <span className="comms-nav-counts">
        <small>{recent}</small>
        {unread > 0 && <em>{unread}</em>}
      </span>
    </button>
  );
}

export function CommsNav({
  rows,
  flightId,
  view,
  onNavigate,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
  onNavigate: (path: string) => void;
}) {
  const crew = useResource<CommsMessagesResponse>(RESOURCES.commsCrew).data;
  const flight = useResource<CommsMessagesResponse>(RESOURCES.commsFlight).data;
  // Observed loops appear in `/api/crew` too, but are not stored-Comms agents.  In particular,
  // `/api/comms/agents/:id` correctly rejects them, so never mount an AgentNavRow for one.
  const seats = rows.filter((row) => row.kind === "crew" && row.id !== flightId);
  const crewMembers = seats.length + 1;
  return (
    <nav className="comms-nav" aria-label="Comms">
      <div className="comms-section-head">
        <h2>Comms</h2>
        <span>{`${seats.length} agents live`}</span>
      </div>
      <button
        type="button"
        className={`comms-nav-top${view.kind === "flight" ? " on" : ""}`}
        onClick={() => onNavigate(commsFlightPath())}
      >
        <i aria-hidden="true" />
        <span className="comms-nav-agent">
          <b>FLIGHT ↔ CAPCOM</b>
          <small>{`${flight?.messages.length ?? 0} messages`}</small>
        </span>
        {(flight?.unread ?? 0) > 0 && <em>{flight?.unread}</em>}
      </button>
      <button
        type="button"
        className={`comms-nav-top${view.kind === "crew" ? " on" : ""}`}
        onClick={() => onNavigate(commsCrewPath())}
      >
        <i aria-hidden="true" />
        <span className="comms-nav-agent">
          <b>#crew</b>
          <small>{`${crewMembers} members`}</small>
        </span>
        {(crew?.unread ?? 0) > 0 && <em>{crew?.unread}</em>}
      </button>
      <div className="comms-section-head">
        <h2>Agents</h2>
        <span>{`${seats.length} agents`}</span>
      </div>
      {seats.map((row) => (
        <AgentNavRow key={row.id} row={row} view={view} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}
