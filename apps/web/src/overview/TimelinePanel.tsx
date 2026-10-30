import { type ConfigView, type Crew, type OverviewTimeline, TIMELINE_WINDOW_MS } from "@mc/core";
import type { CSSProperties } from "react";
import { useNow } from "../clock.ts";
import { callSign } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink, PAGE_PATHS } from "../router.ts";
import { timelineGeometry } from "./chartGeometry.ts";
import { configuredAgents, OVERVIEW_LOADING_ROWS } from "./loading.ts";

const COLORS = {
  turn: "var(--accent)",
  checks: "var(--ok)",
  lock: "var(--warn)",
  review: "var(--think)",
};

/** The axis labels and where they sit on the track (%), matching its 15-minute gridlines. */
const AXIS: [string, number][] = [
  ["-60m", 0],
  ["-45m", 25],
  ["-30m", 50],
  ["-15m", 75],
  ["now", 100],
];

/**
 * The last hour per agent: one thin sub-track per kind (turn, checks, lock, review) so overlapping
 * activity stays visible, 5- and 15-minute gridlines and a "now" cursor.
 */
export function TimelinePanel() {
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const roster = configuredAgents(config);
  const now = useNow();
  const openEnd = timeline.error && timeline.data ? Math.min(now, timeline.data.to) : now;
  const from = now - TIMELINE_WINDOW_MS;
  const geometry = timelineGeometry({ from, to: now });
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
      // An open turn says its end is unknown. A parked seat must not be painted as turning for the
      // whole view, but independent open activity (locks, checks and reviews) remains observable.
      if (span.to === null && span.kind === "turn" && agent?.hudState === "parked") return [];
      const start = Math.max(from, span.from);
      const end = Math.min(now, span.to ?? openEnd);
      if (end <= start) return [];
      active = true;
      const segment = geometry.segment(start, end);
      if (segment === null) return [];
      return (
        <i
          key={`${span.kind}:${span.from}:${span.to}`}
          className={`overview-span k-${span.kind}`}
          title={span.kind}
          style={{
            left: `${segment.left}%`,
            width: `${segment.width}%`,
            background: COLORS[span.kind],
          }}
        />
      );
    });
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
        </span>
      </a>
    );
  });
  return (
    <Panel
      id="timelineP"
      title="Timeline"
      sub="last 60 minutes"
      actions={
        <a
          className="ph-link"
          href={PAGE_PATHS.map}
          title="Where in each repo the crew is working (g m)"
          onClick={(e) => followLink(e, PAGE_PATHS.map)}
        >
          Activity map →
        </a>
      }
    >
      <div className="pb scroll timeline-body">
        <div
          className="overview-lanes"
          aria-busy={pending}
          style={{ "--lane-count": lanes.length } as CSSProperties}
        >
          {rows}
        </div>
        <div className="overview-axis num muted">
          {AXIS.map(([label, left]) => (
            <span key={label} style={{ left: `${left}%` }}>
              {label}
            </span>
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
        </div>
      </div>
    </Panel>
  );
}
