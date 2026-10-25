import { type ConfigView, type Crew, type OverviewTimeline, TIMELINE_WINDOW_MS } from "@mc/core";
import type { CSSProperties } from "react";
import { useSecond } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink } from "../router.ts";
import { configuredAgents, OVERVIEW_LOADING_ROWS } from "./loading.ts";

const COLORS = {
  turn: "var(--accent)",
  checks: "var(--ok)",
  lock: "var(--warn)",
  review: "var(--think)",
};

export function TimelinePanel() {
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roster = configuredAgents(config);
  const now = useSecond();
  const openEnd = timeline.error && timeline.data ? Math.min(now, timeline.data.to) : now;
  const from = now - TIMELINE_WINDOW_MS;
  const position = (at: number) => (100 * (at - from)) / TIMELINE_WINDOW_MS;
  const pending = !timeline.data && !timeline.error;
  const fallback =
    crew?.rows.map((row) => ({ id: row.id })) ??
    (config
      ? roster
      : Array.from({ length: OVERVIEW_LOADING_ROWS }, (_, i) => ({ id: `loading-${i}` })));
  const lanes =
    timeline.data?.lanes ??
    (pending ? fallback.map((agent) => ({ agentId: agent.id, spans: [], ticks: [] })) : []);
  let active = false;
  const rows = lanes.map((lane) => {
    const name = roster.find((row) => row.id === lane.agentId)?.name;
    const agent = crew?.rows.find((row) => row.id === lane.agentId);
    const spans = lane.spans.flatMap((span) => {
      const start = Math.max(from, span.from);
      const end = Math.min(now, span.to ?? openEnd);
      if (end <= start) return [];
      active = true;
      return (
        <i
          key={`${span.kind}:${span.from}:${span.to}`}
          className="overview-span"
          title={span.kind}
          style={{
            left: `${position(start)}%`,
            width: `${position(end) - position(start)}%`,
            background: COLORS[span.kind],
          }}
        />
      );
    });
    const ticks = lane.ticks.filter((at) => at >= from && at <= now);
    if (ticks.length) active = true;
    return (
      <a
        key={lane.agentId}
        className="overview-lane"
        href={pending && !config && !crew ? undefined : agentPath(lane.agentId)}
        onClick={
          pending && !config && !crew ? undefined : (e) => followLink(e, agentPath(lane.agentId))
        }
      >
        <span
          className="num ellip"
          title={lane.agentId}
          style={{ color: agentColor(agent?.index ?? "flight") }}
        >
          {agent ? callSign(agent) : (name ?? (pending ? "Loading…" : lane.agentId))}
        </span>
        <span className="overview-track" aria-hidden="true">
          {spans}
          {ticks.map((at) => (
            <i key={at} className="overview-tick" style={{ left: `${position(at)}%` }} />
          ))}
        </span>
      </a>
    );
  });
  return (
    <Panel id="timelineP" title="Timeline" sub="last 60 minutes">
      <div className="pb scroll timeline-body">
        <div
          className="overview-lanes"
          aria-busy={pending}
          style={{ "--lane-count": lanes.length } as CSSProperties}
        >
          {rows}
        </div>
        <div className="overview-axis num muted">
          {["-60m", "-45m", "-30m", "-15m", "now"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        {timeline.error && timeline.data && (
          <p className="crit-t">Could not refresh timeline. Showing stale data.</p>
        )}
        {!timeline.data && (
          <p className={timeline.error ? "crit-t" : "muted"}>
            {timeline.error ? "Could not load timeline." : "Loading…"}
          </p>
        )}
        {timeline.data && !active && <p className="muted">No activity in the last hour.</p>}
        <div className="overview-legend muted">
          {Object.entries(COLORS).map(([kind, color]) => (
            <span key={kind}>
              <i style={{ background: color }} />
              {kind}
            </span>
          ))}
          <span>
            <i className="tool-tick" />
            tool calls
          </span>
        </div>
      </div>
    </Panel>
  );
}
