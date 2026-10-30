import {
  COMMS_CAPCOM,
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
import { type CommsView, commsAgentPath, commsCrewPath, commsFlightPath } from "../router.ts";

/** The short area label belongs in the compact nav; path globs belong in seat detail. */
export function commsAgentRole(row: CrewRow): string {
  const area = row.area.find((label) => label.startsWith("area:"));
  return area?.slice("area:".length) || row.role?.toLowerCase() || "crew";
}

export function AgentNavRow({
  row,
  view,
  mentions,
  onNavigate,
}: {
  row: CrewRow;
  view: CommsView;
  mentions: number;
  onNavigate: (path: string) => void;
}) {
  const data = useResource<CommsAgentResponse>(RESOURCES.commsAgent(row.id)).data;
  const messages = data?.messages ?? [];
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = messages.filter((message) => message.at !== null && message.at >= since).length;
  const unread = data?.unread ?? 0;
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
          className={recent === 0 ? "zero" : undefined}
          title={`${plural(recent, "message")} in 24h`}
        >
          {recent}
        </small>
        <CountBadges unread={unread} mentions={mentions} direct={direct} />
      </span>
    </button>
  );
}

function CountBadges({
  unread = 0,
  mentions = 0,
  direct = 0,
}: {
  unread?: number;
  mentions?: number;
  /** Unread replies to CAPCOM on the agent's direct line, its transcript included. */
  direct?: number;
}) {
  const unreadLabel = plural(unread, "unread message");
  const mentionsLabel = plural(mentions, "new mention");
  const directLabel = plural(direct, "unread reply to you", "unread replies to you");
  return (
    <>
      {direct > 0 && (
        <span className="comms-unread-count comms-direct-count" title={directLabel}>
          <span aria-hidden="true">↩{direct}</span>
          <span className="sr-only">{directLabel}</span>
        </span>
      )}
      {unread > 0 && (
        <span className="comms-unread-count" title={unreadLabel}>
          <span aria-hidden="true">{unread}</span>
          <span className="sr-only">{unreadLabel}</span>
        </span>
      )}
      {mentions > 0 && (
        <span className="comms-mention-count" title={mentionsLabel}>
          <span aria-hidden="true">@{mentions}</span>
          <span className="sr-only">{mentionsLabel}</span>
        </span>
      )}
    </>
  );
}

function unseenMentionsFor(
  mentions: CommsMention[],
  kind: "crew" | "flight" | "agent",
  id?: string,
): number {
  return mentions.filter(({ message, seen }) => {
    if (seen) return false;
    if (kind === "crew") return message.to === COMMS_CREW || message.from === COMMS_CREW;
    if (message.to === COMMS_CREW || message.from === COMMS_CREW) return false;
    if (kind === "flight")
      return (
        id !== undefined &&
        [message.from, message.to].includes(id) &&
        [message.from, message.to].includes(COMMS_CAPCOM)
      );
    const conversationAgent = message.from === COMMS_CAPCOM ? message.to : message.from;
    return id !== undefined && conversationAgent === id;
  }).length;
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
  const mentions =
    useResource<{ mentions: CommsMention[] }>(RESOURCES.commsMentions).data?.mentions ?? [];
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
        <h2>Comms</h2>
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
          <b>FLIGHT ↔ CAPCOM</b>
          <small>{plural(flight?.messages.length ?? 0, "message")}</small>
        </span>
        <span className="comms-nav-counts">
          <CountBadges
            unread={flight?.unread}
            mentions={unseenMentionsFor(mentions, "flight", flightId)}
          />
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
        <span className="comms-nav-counts">
          <CountBadges unread={crew?.unread} mentions={unseenMentionsFor(mentions, "crew")} />
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
          view={view}
          mentions={unseenMentionsFor(mentions, "agent", row.id)}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}
