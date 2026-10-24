import type { CrewRow } from "@mc/core";
import { kTokens } from "../fmt.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Sparkline } from "../hud/Sparkline.tsx";
import { ACTIVITY_MINUTES, ACTIVITY_MS, activityValues, age } from "./agentActivity.ts";

export function AgentActivity({
  row,
  now,
  max,
  eventsOnly = false,
}: {
  row: CrewRow;
  now: number;
  max: number;
  eventsOnly?: boolean;
}) {
  const values = activityValues(row.digest, now);
  const events = (row.events ?? []).filter((e) => e.at >= now - ACTIVITY_MS && e.at <= now);
  const last = events.length ? Math.max(...events.map((e) => e.at)) : null;
  return (
    <div className="agent-activity tok">
      {!eventsOnly && <Sparkline values={values} color={agentColor(row.index)} max={max} />}
      {!eventsOnly && (
        <span
          className="xs muted num"
          title="Average input + output tokens per minute over the last 2 hours"
        >
          {kTokens(values.reduce((a, b) => a + b, 0) / ACTIVITY_MINUTES)}/min
        </span>
      )}
      <div className="heartbeat" role="img" aria-label="Progress events over the last 2 hours">
        {events.map((event, i) => (
          <i
            // Multiple events can share kind and timestamp; their position in the event list is stable.
            // biome-ignore lint/suspicious/noArrayIndexKey: event records have no id
            key={`${event.at}:${event.kind}:${i}`}
            className={`heartbeat-tick event-${event.kind}`}
            data-kind={event.kind}
            style={{ left: `${(100 * (event.at - now + ACTIVITY_MS)) / ACTIVITY_MS}%` }}
            title={`${event.kind} · ${age(event.at, now)} ago`}
          />
        ))}
      </div>
      <span className="xs muted">
        {last === null ? "No events in 2h" : `last event ${age(last, now)} ago`}
      </span>
    </div>
  );
}
