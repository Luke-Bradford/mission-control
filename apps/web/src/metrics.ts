import {
  type AttentionItem,
  type Crew,
  type MetricId,
  type MetricReading,
  type MetricsView,
  metricHover,
  metricLabel,
  metricReadings,
} from "@mc/core";
import { needsYouItems } from "./attention.ts";
import { RESOURCES, useResource } from "./data.ts";
import { useSessionScope } from "./shell/session.ts";

export interface Metrics {
  readings: Record<MetricId, MetricReading | null>;
  /** The server's figures, for context such as the oldest in-progress ticket. */
  view: MetricsView | undefined;
  error: Error | null;
}

/**
 * The registry's figures as every page shows them: the server's (`GET /api/metrics`) and the crew
 * rows under the header's session filter, and Needs you as the operator's whole inbox
 * (`needsYouItems`). Overview, FLIGHT, Telemetry and Comms read figures only through this.
 */
export function useMetrics(): Metrics {
  const { session, inView } = useSessionScope();
  const res = useResource<MetricsView>(RESOURCES.metrics(session));
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const readings = metricReadings({
    view: res.data,
    rows: crew?.rows.filter(inView),
    needsYou: attention === undefined ? undefined : needsYouItems(attention).length,
  });
  return { readings, view: res.data, error: res.error };
}

/** The label (window included) and the hover text a figure carries on every page. */
export const metricText = (id: MetricId) => ({ label: metricLabel(id), title: metricHover(id) });
