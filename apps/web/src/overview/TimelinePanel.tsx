import { type OverviewTimeline, TIMELINE_WINDOW_MS } from "@mc/core";
import { useSecond } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, followLink } from "../router.ts";

const COLORS = {
  turn: "#3d8bfd",
  checks: "#2bb3a3",
  lock: "#e0902f",
  review: "#9a7bff",
};

export function TimelinePanel() {
  const timeline = useResource<OverviewTimeline>(RESOURCES.overviewTimeline);
  const now = useSecond();
  const from = now - TIMELINE_WINDOW_MS;
  const position = (at: number) => (100 * (at - from)) / TIMELINE_WINDOW_MS;
  const lanes = timeline.data?.lanes ?? [];
  let active = false;
  const rows = lanes.map((lane) => {
    const spans = lane.spans.flatMap((span) => {
      const start = Math.max(from, span.from);
      const end = Math.min(now, span.to ?? now);
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
        href={agentPath(lane.agentId)}
        onClick={(e) => followLink(e, agentPath(lane.agentId))}
      >
        <span className="num ellip" title={lane.agentId}>
          {lane.agentId}
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
      <div className="pb">
        <div className="overview-axis num muted">
          {["-60m", "-45m", "-30m", "-15m", "now"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="overview-lanes">{rows}</div>
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
