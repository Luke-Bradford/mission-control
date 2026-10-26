import type { CrewRow } from "@mc/core";
import { RESOURCES, useResource } from "../data.ts";
import { type CommsView, commsAgentPath, commsCrewPath, commsFlightPath } from "../router.ts";

function AgentNavRow({
  row,
  view,
  onNavigate,
}: {
  row: CrewRow;
  view: CommsView;
  onNavigate: (path: string) => void;
}) {
  const messages =
    useResource<{ messages: { at: number | null; seen: boolean }[] }>(RESOURCES.comms(row.id)).data
      ?.messages ?? [];
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = messages.filter((message) => message.at !== null && message.at >= since).length;
  const unread = messages.filter((message) => !message.seen).length;
  const active = "agentId" in view && view.agentId === row.id;
  return (
    <button
      type="button"
      className={`comms-nav-row${active ? " on" : ""}`}
      onClick={() => onNavigate(commsAgentPath(row.id))}
    >
      <span>{row.id}</span>
      <small>{`${recent} · ${unread} unread`}</small>
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
  return (
    <nav className="comms-nav" aria-label="Comms">
      <button
        type="button"
        className={view.kind === "flight" ? "on" : ""}
        onClick={() => onNavigate(commsFlightPath())}
      >
        FLIGHT ↔ CAPCOM
      </button>
      <button
        type="button"
        className={view.kind === "crew" ? "on" : ""}
        onClick={() => onNavigate(commsCrewPath())}
      >
        #crew
      </button>
      <p>Agents</p>
      {rows
        .filter((row) => row.id !== flightId)
        .map((row) => (
          <AgentNavRow key={row.id} row={row} view={view} onNavigate={onNavigate} />
        ))}
    </nav>
  );
}
