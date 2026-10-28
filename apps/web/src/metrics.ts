import {
  type AttentionItem,
  type Crew,
  METRICS,
  type MetricId,
  type MetricReading,
  type MetricsView,
  metricHover,
  metricLabel,
  metricReadings,
} from "@mc/core";
import { needsYouItems } from "./attention.ts";
import { RESOURCES, useResource } from "./data.ts";
import { SESSION_ALL, useSessionScope } from "./shell/session.ts";

export type MetricState = "loading" | "error" | "ready";

export interface Metrics {
  readings: Record<MetricId, MetricReading | null>;
  /** The server's figures, for context such as the oldest in-progress ticket. */
  view: MetricsView | undefined;
  /** `/api/metrics`'s load error, else null. */
  error: Error | null;
  /** Loading until the figure's source answers; error when it failed with nothing to show. */
  state: (id: MetricId) => MetricState;
  /** The failed source's message, for the figure's hover; null unless `state` is error. */
  errorOf: (id: MetricId) => string | null;
  /** The header's session filter: `all` or a session id. */
  session: string;
}

/**
 * The registry's figures as every page shows them: the server's (`GET /api/metrics`) and the crew
 * rows under the header's session filter, and Needs you as the operator's whole inbox
 * (`needsYouItems`). Overview, FLIGHT, Telemetry and Comms read figures only through this.
 */
export function useMetrics(): Metrics {
  const { session, inView } = useSessionScope();
  const res = useResource<MetricsView>(RESOURCES.metrics(session));
  const crew = useResource<Crew>(RESOURCES.crew);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const readings = metricReadings({
    view: res.data,
    rows: crew.data?.rows.filter(inView),
    needsYou: attention.data === undefined ? undefined : needsYouItems(attention.data).length,
  });
  const failed = {
    server: res.data === undefined ? res.error : null,
    crew: crew.data === undefined ? crew.error : null,
    attention: attention.data === undefined ? attention.error : null,
  };
  const errorOf = (id: MetricId): string | null => failed[METRICS[id].from]?.message ?? null;
  const state = (id: MetricId): MetricState =>
    readings[id] !== null ? "ready" : errorOf(id) !== null ? "error" : "loading";
  return { readings, view: res.data, error: res.error, state, errorOf, session };
}

/** The label (window included) and the hover text a figure carries on every page. */
export const metricText = (id: MetricId) => ({ label: metricLabel(id), title: metricHover(id) });

/** A figure's hover, led by its load error when its source failed. */
export const metricTitle = (m: Metrics, id: MetricId): string => {
  const error = m.errorOf(id);
  return error === null ? metricHover(id) : `Could not load: ${error}\n${metricHover(id)}`;
};

/**
 * Telemetry's own figures ignore the header's session filter, so a registry tile there names the
 * session it follows ("s/mission-control"); null when every session is in view.
 */
export const sessionTag = (session: string): string | null =>
  session === SESSION_ALL ? null : `s/${session}`;
