import type { CommsAgentResponse, CommsMessagesResponse, CrewRow } from "@mc/core";
import { callSign, seatStatus } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { plural } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { metricText, metricTitle, useMetrics } from "../metrics.ts";
import { type CommsView, commsAgentPath, commsCrewPath, commsFlightPath } from "../router.ts";

/** The short area label belongs in the compact nav; path globs belong in seat detail. */
export function commsAgentRole(row: CrewRow): string {
  const area = row.area.find((label) => label.startsWith("area:"));
  return area?.slice("area:".length) || row.role?.toLowerCase() || "crew";
}

export function AgentNavRow({
  row,
  view,
  onNavigate,
}: {
  row: CrewRow;
  view: CommsView;
  onNavigate: (path: string) => void;
}) {
  const data = useResource<CommsAgentResponse>(RESOURCES.commsNav(row.id)).data;
  // The nav row reads counts, not messages: what its contact conversations hold (the crew
  // channel is not among them).
  const total = (data?.contacts ?? []).reduce((n, c) => n + c.count, 0);
  const direct = data?.directUnread ?? 0;
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
        <b>{callSign(row)}</b>
        <small>{`${commsAgentRole(row)} · ${status.label.toLowerCase()}`}</small>
      </span>
      <span className="comms-nav-counts">
        <small
          className={total === 0 ? "zero" : undefined}
          title={`${plural(total, "message")} with its contacts. A message count, not unread.`}
        >
          {`${total} msgs`}
        </small>
        <CountBadges direct={direct} />
      </span>
    </button>
  );
}

/** The only unread mark: replies and messages addressed to the operator (never the controller's). */
function CountBadges({ direct = 0, flight = 0 }: { direct?: number; flight?: number }) {
  const n = direct + flight;
  if (n === 0) return null;
  const label = plural(n, "unread message to you", "unread messages to you");
  return (
    <span className="comms-unread-count comms-direct-count" title={label}>
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{label}</span>
    </span>
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
  const flight = useResource<CommsMessagesResponse>(RESOURCES.commsFlight).data;
  // Observed loops appear in `/api/crew` too, but are not stored-Comms agents.  In particular,
  // `/api/comms/agents/:id` correctly rejects them, so never mount an AgentNavRow for one.
  const seats = rows.filter((row) => row.kind === "crew" && row.id !== flightId);
  const crewMembers = seats.length + 1;
  const metrics = useMetrics();
  const agentsLive = metrics.readings.agentsLive;
  const live = { label: metricText("agentsLive").label, title: metricTitle(metrics, "agentsLive") };
  return (
    <nav className="comms-nav" aria-label="Comms">
      <div className="comms-section-head">
        <h2>Team</h2>
        <span title={agentsLive?.detail ? `${agentsLive.detail}\n${live.title}` : live.title}>
          {live.label}{" "}
          <b className="num" data-metric="agentsLive">
            {agentsLive?.value ?? "—"}
          </b>
        </span>
      </div>
      <button
        type="button"
        className={`comms-nav-top${view.kind === "flight" ? " on" : ""}`}
        onClick={() => onNavigate(commsFlightPath())}
      >
        <i aria-hidden="true" />
        <span className="comms-nav-agent">
          <b>FLIGHT and you</b>
          <small>{plural(flight?.messages.length ?? 0, "message")}</small>
        </span>
        <span className="comms-nav-counts">
          <CountBadges flight={flight?.unread} />
        </span>
      </button>
      <button
        type="button"
        className={`comms-nav-top${view.kind === "crew" ? " on" : ""}`}
        onClick={() => onNavigate(commsCrewPath())}
      >
        <i className="crew" aria-hidden="true" />
        <span className="comms-nav-agent">
          <b>#crew</b>
          <small>{plural(crewMembers, "member")}</small>
        </span>
      </button>
      <div className="comms-section-head">
        <h2>Agents</h2>
        <span>{plural(seats.length, "agent")}</span>
      </div>
      {seats.map((row) => (
        <AgentNavRow key={row.id} row={row} view={view} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}
