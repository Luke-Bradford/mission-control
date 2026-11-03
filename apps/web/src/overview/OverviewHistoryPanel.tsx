import type { OverviewSummary } from "@mc/core";
import { useState } from "react";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { costRate, hhmm, kTokens, percent } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { useSession } from "../shell/session.ts";
import { machineAreaGeometry } from "./chartGeometry.ts";

export type History = "tokens" | "spend" | "inflight" | "ci" | "needs";
const LABELS: Record<History, string> = {
  tokens: "Token throughput",
  spend: "Cost per minute",
  inflight: "In-progress tickets",
  ci: "CI pass rate · rolling 24h",
  needs: "Needs you · global inbox",
};

/** Axes are HTML, so resizing a plot never shrinks the labels below the shared type scale. */
export function MeasuredHistory({
  values,
  format,
  tickFormat = format,
  max,
  unit,
  label,
  at,
  description,
  recent = false,
}: {
  values: (number | null)[];
  format: (n: number) => string;
  tickFormat?: (n: number) => string;
  max?: number;
  unit: string;
  label: string;
  at: number;
  description?: string;
  recent?: boolean;
}) {
  const tz = useTz();
  const readings = values.filter((v): v is number => v !== null);
  if (!readings.length) return <p className="s muted">History not collected for this window.</p>;
  const peak = Math.max(...readings),
    top = max ?? (peak > 0 ? peak : 1),
    scale = top < 1 ? 1 / top : 1;
  const latest = values.at(-1);
  const geometry = machineAreaGeometry(
      values.map((value) => (value === null ? null : value * scale)),
      top * scale,
    ),
    end = Number.isFinite(at) ? Math.floor(at / 60_000) * 60_000 : null;
  return (
    <div className="measured-history">
      <div className="measured-reading s">
        <span className="num">
          Latest {latest == null ? "—" : format(latest)} {unit}
        </span>
        <span className="num">Peak {format(peak)}</span>
        {peak === 0 && (
          <span className="muted measured-zero">No activity in the measured minutes.</span>
        )}
      </div>
      <div className={recent ? "measured-evidence" : undefined}>
        <div className="measured-plot">
          <div className="measured-y num">
            <span>{tickFormat(top)}</span>
            <span>{tickFormat(top / 2)}</span>
            <span>{tickFormat(0)}</span>
          </div>
          <svg
            viewBox="0 0 100 24"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${label} · ${unit} · last ${values.length} complete minutes · missing samples remain gaps`}
          >
            {[3, 12.5, 22].map((y) => (
              <line className="measured-grid" key={y} x1={0} x2={100} y1={y} y2={y} />
            ))}
            {geometry.line && (
              <path
                d={geometry.line}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          <div className="measured-x num">
            <span>
              {tz && end !== null ? hhmm(end - values.length * 60_000, tz) : `−${values.length}m`}
            </span>
            <span>
              {tz && end !== null
                ? hhmm(end - (values.length / 2) * 60_000, tz)
                : `−${values.length / 2}m`}
            </span>
            <span>{tz && end !== null ? hhmm(end, tz) : "Last minute"}</span>
          </div>
        </div>
        {recent && (
          <section
            className="history-recent"
            aria-label={`Latest ${Math.min(5, values.length)} ${unit} readings`}
          >
            <h3>Latest complete minutes</h3>
            <dl>
              {values.slice(-5).map((value, index, shown) => {
                const minutes = shown.length - index;
                return (
                  <div key={minutes}>
                    <dt>
                      {tz && end !== null ? hhmm(end - minutes * 60_000, tz) : `−${minutes}m`}
                    </dt>
                    <dd className="num">{value === null ? "Not collected" : format(value)}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
        )}
      </div>
      <HistoryDataTable
        values={values}
        format={format}
        unit={unit}
        at={at}
        description={description}
      />
    </div>
  );
}

/** Existing page-shaped history only: selecting another measure does not fetch a new series. */
export function OverviewHistoryPanel({
  measure,
  compact = false,
  onInspect,
  id,
  recent = false,
  selectedHistory,
  onSelectHistory,
}: {
  id?: string;
  measure?: History;
  compact?: boolean;
  onInspect?: (measure: History) => void;
  recent?: boolean;
  selectedHistory?: History;
  onSelectHistory?: (measure: History) => void;
} = {}) {
  const [session] = useSession(),
    [choice, setSelected] = useState<History>("tokens");
  const selected = measure ?? selectedHistory ?? choice;
  const source = useResource<OverviewSummary>(RESOURCES.overview(session));
  const k = source.data?.kpis;
  const values =
    selected === "tokens"
      ? k?.tokensPerMin?.series
      : selected === "spend"
        ? k?.spendToday?.series
        : selected === "inflight"
          ? k?.inFlight?.series
          : selected === "ci"
            ? k?.ciPassRate24h?.series
            : k?.needsYou?.series;
  const format =
    selected === "tokens"
      ? kTokens
      : selected === "spend"
        ? costRate
        : selected === "ci"
          ? (n: number) => percent(n)
          : (n: number) => String(Math.round(n));
  // Readings are whole tokens/counts; an axis midpoint can be half a unit.
  const tickFormat =
    selected === "tokens"
      ? (n: number) => (n < 1000 ? String(n) : kTokens(n))
      : selected === "inflight" || selected === "needs"
        ? String
        : format;
  const unit =
    selected === "tokens"
      ? "tokens/min"
      : selected === "spend"
        ? "USD/min"
        : selected === "ci"
          ? "percent of completed runs"
          : selected === "inflight"
            ? "tickets"
            : "items";
  const definition =
    selected === "ci"
      ? "Each point is passed / completed CI runs in its previous 24 hours."
      : selected === "spend"
        ? "Estimated spend in each minute; the daily total is a separate statistic."
        : selected === "needs"
          ? "Observed operator-inbox episodes; all sessions included."
          : selected === "tokens"
            ? "Input + output per full minute. Rate is separate from context and account allowance."
            : "Recorded tickets started and not yet merged.";

  return (
    <Panel
      id={id ?? (measure ? `overviewHistory-${measure}` : "overviewHistoryP")}
      title={LABELS[selected]}
      sub="30m history"
      actions={
        <>
          {!measure && (
            <select
              aria-label="Measured Overview history"
              value={selected}
              onChange={(e) => (onSelectHistory ?? setSelected)(e.target.value as History)}
            >
              {Object.entries(LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {onInspect && (
            <button type="button" className="sm" onClick={() => onInspect(selected)}>
              Inspect
            </button>
          )}
        </>
      }
    >
      <div className="pb overview-history">
        {source.error && (
          <p role="status" className="s warn-t">
            {source.data
              ? "History refresh failed. Showing the last received minutes."
              : "Overview history could not load."}
          </p>
        )}
        {!source.data && !source.error ? (
          <p className="s muted">Loading measured history…</p>
        ) : source.data && values?.length ? (
          <MeasuredHistory
            values={values}
            format={format}
            tickFormat={tickFormat}
            max={selected === "ci" ? 100 : undefined}
            unit={unit}
            label={LABELS[selected]}
            at={source.data.at}
            recent={recent}
            description={compact ? `${definition} Missing intervals remain gaps.` : undefined}
          />
        ) : (
          <p className="s muted">History not collected for this measure.</p>
        )}
        <p className="s muted history-window">
          {compact
            ? `${unit} · full-minute buckets · gaps = not collected`
            : `${unit} · ${definition} Missing intervals remain gaps.`}
        </p>
      </div>
    </Panel>
  );
}

/** The same loaded observations, readable with a keyboard; never reconstruct absent readings. */
export function HistoryDataTable({
  values,
  format,
  unit,
  at,
  description,
}: {
  values: (number | null)[];
  format: (value: number) => string;
  unit: string;
  at: number;
  description?: string;
}) {
  const tz = useTz(),
    end = Number.isFinite(at) ? Math.floor(at / 60_000) * 60_000 : null;
  return (
    <details className="history-data">
      <summary>Recorded values · {values.length} points</summary>
      <section
        className="history-data-scroll scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: this named bounded evidence table supports keyboard scrolling.
        tabIndex={0}
        aria-label={`Recorded ${unit} observations`}
      >
        <p className="s muted">
          {`Complete minutes${tz ? ` · ${tz}` : ""}`} ·{" "}
          {end === null ? "Window end not reported · " : ""}Scroll ↕ for every observation.
        </p>
        {description && <p className="s muted">{description}</p>}
        <table>
          <thead>
            <tr>
              <th>Minute starting</th>
              <th className="num">Display · {unit}</th>
              <th className="num">Recorded · {unit}</th>
            </tr>
          </thead>
          <tbody>
            {values.map((value, index) => {
              const timestamp = end === null ? null : end - (values.length - index) * 60_000;
              const key = timestamp === null ? `point-${index}` : String(timestamp);
              return (
                <tr key={key}>
                  <th scope="row">
                    {tz && timestamp !== null ? hhmm(timestamp, tz) : `−${values.length - index}m`}
                  </th>
                  <td className="num">{value === null ? "Not collected" : format(value)}</td>
                  <td className="num">{value === null ? "—" : String(value)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </details>
  );
}
