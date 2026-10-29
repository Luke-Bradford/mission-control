import { METRICS, type MetricId } from "@mc/core";
import "./MetricName.css";

/**
 * A registry figure's label: its name, then its window (and any scope tag) kept on one line, so a
 * narrow tile wraps between the two, never inside "· 24h". Its text is `metricLabel(id)`.
 */
export function MetricName({ id, tag }: { id: MetricId; tag?: string | null }) {
  const m = METRICS[id];
  return (
    <>
      {m.label}{" "}
      <span className="metric-win">
        {"· "}
        {m.window}
        {tag ? ` · ${tag}` : ""}
      </span>
    </>
  );
}
