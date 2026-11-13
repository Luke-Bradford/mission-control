import {
  COMMS_CAPCOM,
  COMMS_CONTROLLER,
  COMMS_CREW,
  type CommsAgentResponse,
  type CommsMention,
  type CommsMessagesResponse,
  type CrewRow,
} from "@mc/core";
import { callSign, seatStatus } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { plural } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { metricText, metricTitle, useMetrics } from "../metrics.ts";
import {
  type CommsView,
  commsAgentPath,
  commsContactPath,
  commsCrewPath,
  commsFlightPath,
} from "../router.ts";
import { useMentions } from "../shell/operatorMessages.ts";
import { useNoticeResource } from "./model.ts";

/** The short area label belongs in the compact nav; path globs belong in seat detail. */
export function commsAgentRole(row: CrewRow): string {
  const area = row.area.find((label) => label.startsWith("area:"));
  return area?.slice("area:".length) || row.role?.toLowerCase() || "crew";
}

/**
 * The messages to the operator still unseen in one conversation: the same read state the header
 * chat button, the dock and the bell count, so every view shows one number.
 */
export function unseenMentionsFor(
  mentions: readonly CommsMention[],
  kind: "flight" | "agent",
  id?: string,
): number {
  return mentions.filter(({ message, seen }) => {
    if (seen || message.to === COMMS_CREW || message.from === COMMS_CREW) return false;
    if (kind === "flight")
      return (
        id !== undefined &&
        [message.from, message.to].includes(id) &&
        [message.from, message.to].includes(COMMS_CAPCOM)
      );
    const other = message.from === COMMS_CAPCOM ? message.to : message.from;
    return id !== undefined && other === id;
  }).length;
}

export function AgentNavRow({
  row,
  view,
  onNavigate,
  hideNotices = false,
}: {
  row: CrewRow;
  view: CommsView;
  hideNotices?: boolean;
  onNavigate: (path: string) => void;
}) {
  const data = useNoticeResource<CommsAgentResponse>(RESOURCES.commsNav(row.id), hideNotices).data;
  // The nav row reads counts, not messages: what its contact conversations hold (the crew
  // channel is not among them).
  const total = (data?.contacts ?? []).reduce((n, c) => n + c.count, 0);
  const direct = unseenMentionsFor(useMentions(), "agent", row.id);
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

/** FLIGHT's conversation with the controller; offered only when it has stored messages. */
function ControllerNavRow({
  flightId,
  view,
  onNavigate,
}: {
  flightId: string;
  view: CommsView;
  onNavigate: (path: string) => void;
}) {
  const contact = useResource<CommsAgentResponse>(RESOURCES.commsNav(flightId)).data?.contacts.find(
    (c) => c.id === COMMS_CONTROLLER,
  );
  if (!contact?.hasMessages) return null;
  const active =
    view.kind === "contact" && view.agentId === flightId && view.contactId === COMMS_CONTROLLER;
  return (
    <button
      type="button"
      className={`comms-nav-top${active ? " on" : ""}`}
      onClick={() => onNavigate(commsContactPath(flightId, COMMS_CONTROLLER))}
    >
      <i aria-hidden="true" />
      <span className="comms-nav-agent">
        <b>FLIGHT and the controller</b>
        <small title="A message count, not unread.">{plural(contact.count, "message")}</small>
      </span>
    </button>
  );
}

export function CommsNav({
  rows,
  flightId,
  view,
  onNavigate,
  hideNotices = false,
}: {
  rows: CrewRow[];
  flightId: string | undefined;
  view: CommsView;
  onNavigate: (path: string) => void;
  hideNotices?: boolean;
}) {
  const flight = useNoticeResource<CommsMessagesResponse>(RESOURCES.commsFlight, hideNotices).data;
  const toYou = unseenMentionsFor(useMentions(), "flight", flightId);
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
          <CountBadges flight={toYou} />
        </span>
      </button>
      {flightId && <ControllerNavRow flightId={flightId} view={view} onNavigate={onNavigate} />}
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
        <AgentNavRow
          key={row.id}
          row={row}
          hideNotices={hideNotices}
          view={view}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}
