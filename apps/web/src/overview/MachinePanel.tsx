import type { MachineSample, MachineView, OverviewSummary } from "@mc/core";
import { useId } from "react";
import { useNow, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { bytes, hhmm, percent, plural, rel } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { MACHINE_CHART_HEIGHT, machineAreaGeometry } from "./chartGeometry.ts";
import { LockBox } from "./LockBox.tsx";
import { HistoryDataTable } from "./OverviewHistoryPanel.tsx";

const GIB = 2 ** 30;
/** At or under this much free memory another agent does not fit. */
const LOW_MEM_GB = 2;
const DASH = "—";
const NO_SAMPLE = "No machine sample yet";
const AGENTS_COLOUR = "var(--fg-2)";
const OTHER_COLOUR = "var(--line-2)";
/** The shared byte formatter divides by 1024; name the binary unit on this measured panel. */
const binaryBytes = (value: number) => bytes(value).replace(/\b([KMG])B$/, "$1iB");

interface Seg {
  pct: number;
  colour: string;
  label: string;
}

/** A stacked bar; segments that are 0 or not a number are left out, so no data is an empty bar. */
function Bar({ segs }: { segs: Seg[] }) {
  return (
    <span className="stack">
      {segs
        .filter((s) => Number.isFinite(s.pct) && s.pct > 0)
        .map((s) => (
          <i
            key={s.label}
            title={s.label}
            style={{
              width: `${Math.round(Math.min(100, s.pct) * 10) / 10}%`,
              background: s.colour,
            }}
          />
        ))}
    </span>
  );
}

function MachineAreaChart({
  label,
  values,
  max,
  color,
  live,
  at,
  compact = false,
}: {
  label: string;
  values: (number | null)[];
  max?: number;
  color: string;
  /** The history is loaded and its last read succeeded: the now-cursor pulses. */
  live: boolean;
  at: number;
  compact?: boolean;
}) {
  const gradient = `machine-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const geometry = machineAreaGeometry(
    values,
    max ?? Math.max(1, ...values.filter((value) => value !== null)),
  );
  if (geometry.line === null) return null;
  // The scale's top: `max` (100 %), or the series' own peak.
  const { top } = geometry;
  const tick = (value: number) =>
    max === 100 ? percent(value) : `${Number(value.toFixed(2))} GiB`;
  const scale = max ?? Math.max(1, ...values.filter((value) => value !== null));
  return (
    <div className="machine-history">
      <div className="machine-history-reading s num">
        <span>Latest minute {values.at(-1) == null ? "—" : tick(values.at(-1) as number)}</span>
        <span>
          Peak {tick(Math.max(...values.filter((value): value is number => value !== null)))}
        </span>
        {compact && <span>0–{tick(scale)}</span>}
      </div>
      <div className="machine-history-y num">
        <span>{tick(scale)}</span>
        <span>{tick(scale / 2)}</span>
        <span>{tick(0)}</span>
      </div>
      <svg
        className="machine-chart"
        preserveAspectRatio="none"
        viewBox={`0 0 100 ${MACHINE_CHART_HEIGHT}`}
        role="img"
        aria-label={label}
        data-max={max ?? Math.max(1, ...values.filter((value) => value !== null))}
      >
        <title>{`${label} · last ${values.length} complete minutes, a point a minute`}</title>
        <defs>
          <linearGradient
            id={gradient}
            gradientUnits="userSpaceOnUse"
            x1={0}
            y1={top}
            x2={0}
            y2={geometry.baseline}
          >
            <stop offset="0" stopColor={color} stopOpacity={0.24} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line className="machine-grid" x1={0} x2={100} y1={top} y2={top} />
        <path className="machine-gridline" d={`M0,${geometry.baseline}H100`} />
        {geometry.areas.map((area) => (
          <path key={area} d={area} fill={`url(#${gradient})`} />
        ))}
        <path
          d={geometry.line}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <line
          className={`machine-now${live ? " live" : ""}`}
          x1={100}
          x2={100}
          y1={0}
          y2={MACHINE_CHART_HEIGHT}
        />
      </svg>
      <div className="machine-history-x num">
        <span>−{values.length}m</span>
        <span>−{values.length / 2}m</span>
        <span>latest</span>
      </div>
      {!compact && (
        <HistoryDataTable
          values={values}
          format={tick}
          unit={max === 100 ? "%" : "GiB free"}
          at={at}
        />
      )}
    </div>
  );
}

function usage(m: MachineSample | null) {
  const cores = m && m.cores > 0 ? m.cores : null; // 0: the first os.cpus() read failed
  const cpu = m?.cpuPct ?? null;
  const agentsCpu = cpu !== null && cores !== null && m?.agents ? m.agents.cpuPct / cores : 0;
  const memTotal = m && m.memTotalBytes > 0 ? m.memTotalBytes : null;
  const memUsed = m?.memUsedBytes ?? null;
  const agentsMem = memTotal !== null && m?.agents ? (100 * m.agents.rssBytes) / memTotal : 0;
  const memPct = memTotal !== null && memUsed !== null ? (100 * memUsed) / memTotal : null;
  const diskTotal = m?.diskTotalBytes ?? null;
  const diskFree = m?.diskFreeBytes ?? null;
  const diskPct =
    diskTotal !== null && diskTotal > 0 && diskFree !== null
      ? (100 * (diskTotal - diskFree)) / diskTotal
      : null;
  const swapUsed = m?.swapUsedBytes ?? null;
  const swapPct =
    memTotal !== null && swapUsed !== null ? Math.min(100, (100 * swapUsed) / memTotal) : null;
  return {
    cores,
    cpu,
    agentsCpu,
    memTotal,
    memUsed,
    agentsMem,
    memPct,
    swapUsed,
    swapPct,
    diskFree,
    diskPct,
  };
}

/** The agents row: a dot per seat up to the cap, and whether another agent fits (catalogue 2.1.4). */
function AgentSlots({ view }: { view: MachineView }) {
  const { maxSeats, seats, perSessionMax, latest } = view;
  const free = maxSeats - seats;
  const memFree =
    latest && latest.memTotalBytes > 0 && latest.memUsedBytes !== null
      ? (latest.memTotalBytes - latest.memUsedBytes) / GIB
      : null;
  const room = free > 0 && (memFree === null || memFree > LOW_MEM_GB);
  const used = Math.min(seats, maxSeats);
  return (
    <div
      className={`row s agentslots ${room ? "ok-t" : "warn-t"}`}
      title={[
        perSessionMax > 0 ? `${perSessionMax} in the largest configured session` : null,
        room ? `Room for ${plural(free, "more agent")}` : "No room for another agent",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="fg2">Agents</span>
      <span className="slots">
        {Array.from({ length: maxSeats }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the dots are identical, only their count matters
          <i key={i} className={i < used ? "used" : undefined} />
        ))}
      </span>
      <span className="num">{`${seats} of ${maxSeats}`}</span>
      <span className="slot-facts">
        {Math.max(0, free)} configured slots free · largest session {perSessionMax} seats ·{" "}
        {memFree === null
          ? "memory headroom unknown"
          : `${memFree.toFixed(1)} GiB host memory free`}
      </span>
    </div>
  );
}

/** This Mac's CPU, memory and disk, the agents row and the test lock (catalogue 2.1.4). Lock history arrives with run records (2c). */
export function MachinePanel({
  compact = false,
  onInspect,
}: {
  compact?: boolean;
  onInspect?: () => void;
} = {}) {
  const source = useResource<MachineView>(RESOURCES.machine);
  const view = source.data;
  const overview = useResource<OverviewSummary>(RESOURCES.overview());
  const tz = useTz();
  const summary = overview.data;
  const live = summary !== undefined && overview.error === null;
  const m = view?.latest ?? null;
  const u = usage(m);
  const none = m === null ? NO_SAMPLE : undefined;
  const diskHistory = (summary?.machine?.disk ?? []).filter(
    (value): value is number => value !== null,
  );
  const histories = [
    { name: "CPU", values: summary?.machine?.cpu },
    { name: "memory", values: summary?.machine?.mem },
    { name: "disk", values: summary?.machine?.disk },
  ];
  const measuredHistory = histories.some(({ values }) => values?.some((value) => value !== null));
  const missingHistory = histories
    .filter(({ values }) => !values?.some((value) => value !== null))
    .map(({ name }) => name);

  if (compact)
    return (
      <Panel
        id="machineSummaryP"
        title="Machine"
        sub={`${m && tz ? `sample ${hhmm(m.at, tz)}` : "sample time unknown"} · 30m window`}
        actions={
          <button type="button" className="sm" onClick={onInspect}>
            Full machine / lock
          </button>
        }
      >
        <div className="machine-summary pb">
          {source.error && (
            <p className="s warn-t" role="status">
              {m ? "Refresh failed · last sample shown" : "Machine sample could not load"}
            </p>
          )}
          {overview.error && (
            <p className="s warn-t" role="status">
              {summary
                ? "History refresh failed · last received minutes shown"
                : "Machine history could not load"}
            </p>
          )}
          {!m && !source.error && (
            <p className="s muted">{source.loading ? "Loading machine sample…" : NO_SAMPLE}</p>
          )}
          {[
            {
              label: "CPU %",
              values: summary?.machine?.cpu,
              max: 100,
              color: "var(--accent)",
              reading: u.cpu === null ? DASH : percent(u.cpu),
              note: `${u.cores ?? DASH} logical threads`,
            },
            {
              label: "RAM %",
              values: summary?.machine?.mem,
              max: 100,
              color: "var(--think)",
              reading: u.memUsed === null ? DASH : `${(u.memUsed / GIB).toFixed(1)} GiB`,
              note: `of ${u.memTotal === null ? DASH : Math.round(u.memTotal / GIB)} GiB`,
            },
            {
              label: "Disk free",
              values: summary?.machine?.disk,
              max: undefined,
              color: "var(--fg-2)",
              reading: u.diskFree === null ? DASH : `${Number((u.diskFree / GIB).toFixed(1))} GiB`,
              note: "current free space",
            },
          ].map((metric) => (
            <div className="machine-summary-row" key={metric.label}>
              <b className="s">{metric.label}</b>
              <div className="machine-summary-trace">
                {summary && metric.values?.some((value) => value !== null) ? (
                  <MachineAreaChart
                    label={`${metric.label} history`}
                    values={metric.values}
                    max={metric.max}
                    color={metric.color}
                    live={live}
                    at={summary.at}
                    compact
                  />
                ) : (
                  <p className="s muted">History not collected</p>
                )}
              </div>
              <span className="num s">
                {metric.reading}
                <span className="muted">{metric.note}</span>
              </span>
            </div>
          ))}
          {m?.agents && (
            <p className="machine-summary-processes s">
              {m.agents.count} agent processes ·{" "}
              {m.testRun ? `${m.testRun.count} test processes` : "test-process split not reported"}{" "}
              · CPU/RAM breakdown in full details
            </p>
          )}
          <div className="machine-summary-facts s">
            <span>
              Swap{" "}
              {u.swapUsed === null ? "unknown" : `${Number((u.swapUsed / GIB).toFixed(1))} GiB`}
            </span>
            {typeof view?.seats === "number" && typeof view.maxSeats === "number" ? (
              <span>
                {view.seats} / {view.maxSeats} configured slots
              </span>
            ) : (
              <span>Slot capacity unknown</span>
            )}
            <MachineLockSummary onInspect={onInspect} />
          </div>
          {view?.warning && (
            <p role="status" className="s warn-t">
              Holding new work · {view.warning}
            </p>
          )}
        </div>
      </Panel>
    );

  return (
    <Panel
      id="machP"
      title="Machine"
      sub={m && tz ? `Host sample at ${hhmm(m.at, tz)}` : "Host resources · latest sample"}
    >
      <div className="pb">
        {source.error && (
          <p role="status" className="s warn-t">
            {m
              ? "Machine refresh failed. Showing the last sample."
              : "Machine sample could not load."}
          </p>
        )}
        {!m && !source.error && (
          <p className="s muted">{source.loading ? "Loading machine sample…" : NO_SAMPLE}</p>
        )}
        <div
          className="res"
          title={`Claude/Codex processes (${m?.agents ? m.agents.count : DASH}) · other apps`}
        >
          <div className="resrow">
            <span
              className="s fg2"
              title="Total host CPU, normalized across logical threads. Scale 0–100%."
            >
              CPU
            </span>
            {summary?.machine?.cpu?.some((value) => value !== null) ? (
              <MachineAreaChart
                label="CPU history"
                values={summary.machine.cpu}
                max={100}
                color="var(--accent)"
                live={live}
                at={summary.at}
              />
            ) : (
              <Bar
                segs={
                  u.cpu === null
                    ? []
                    : [
                        {
                          pct: u.agentsCpu,
                          colour: AGENTS_COLOUR,
                          label: "Claude/Codex processes",
                        },
                        { pct: u.cpu - u.agentsCpu, colour: OTHER_COLOUR, label: "other apps" },
                      ]
                }
              />
            )}
            <span
              className="num s"
              title={none ?? (u.cpu === null ? "Not measured yet" : undefined)}
            >
              {u.cpu === null ? DASH : percent(u.cpu)}
              <span className="muted">
                {" "}
                ·{" "}
                <span title={u.cores === null ? "Core count not read" : undefined}>
                  {u.cores ?? DASH}
                </span>{" "}
                threads
              </span>
            </span>
          </div>
          <div className="resrow">
            <span className="s fg2">RAM %</span>
            {summary?.machine?.mem?.some((value) => value !== null) ? (
              <MachineAreaChart
                label="Memory history"
                values={summary.machine.mem}
                max={100}
                color="var(--think)"
                live={live}
                at={summary.at}
              />
            ) : (
              <Bar
                segs={
                  u.memPct === null
                    ? []
                    : [
                        {
                          pct: u.agentsMem,
                          colour: AGENTS_COLOUR,
                          label: "Claude/Codex processes",
                        },
                        { pct: u.memPct - u.agentsMem, colour: OTHER_COLOUR, label: "other apps" },
                      ]
                }
              />
            )}
            <span className="num s" title={none}>
              {u.memUsed === null ? DASH : (u.memUsed / GIB).toFixed(1)}
              <span className="muted">
                {" "}
                of {u.memTotal === null ? DASH : Math.round(u.memTotal / GIB)} GiB
              </span>
            </span>
          </div>
          <div className="resrow">
            <span className="s fg2">Swap</span>
            <Bar
              segs={
                u.swapPct === null ? [] : [{ pct: u.swapPct, colour: OTHER_COLOUR, label: "used" }]
              }
            />
            <span
              className="num s"
              title={none ?? (u.swapUsed === null ? "Not measured" : undefined)}
            >
              {u.swapUsed === null
                ? DASH
                : `${(u.swapUsed / GIB).toFixed(1)} GiB${u.memTotal ? ` (${percent((100 * u.swapUsed) / u.memTotal)} of RAM)` : ""}`}
            </span>
          </div>
          <div className="resrow">
            <span className="s fg2">Disk</span>
            {summary?.machine?.disk?.some((value) => value !== null) ? (
              <MachineAreaChart
                label="Disk history · GiB free"
                values={summary.machine.disk}
                color="var(--fg-2)"
                live={live}
                at={summary.at}
              />
            ) : (
              <Bar
                segs={
                  u.diskPct === null
                    ? []
                    : [{ pct: u.diskPct, colour: OTHER_COLOUR, label: "used" }]
                }
              />
            )}
            <span className="num s" title={none}>
              {u.diskFree === null ? DASH : `${Math.round(u.diskFree / GIB)} GiB`}
              <span className="muted"> free</span>
            </span>
          </div>
          {m?.agents && (
            <p className="s machine-processes">
              Agent processes: {m.agents.count} ·{" "}
              {u.cores ? percent(m.agents.cpuPct / u.cores) : "CPU share unknown"} CPU ·{" "}
              {binaryBytes(m.agents.rssBytes)} RAM.{" "}
              {m.testRun
                ? `Test processes: ${m.testRun.count} · ${u.cores ? percent(m.testRun.cpuPct / u.cores) : "CPU share unknown"} CPU · ${binaryBytes(m.testRun.rssBytes)} RAM.`
                : "Test process split not reported."}
            </p>
          )}
          {view?.warning && (
            <div className="row s capwarn warn-t" role="status" title={view.warning}>
              <Pill tone="warn" title={view.warning}>
                Holding new work
              </Pill>
              <span className="muted"> {view.warning}</span>
            </div>
          )}
          {view && typeof view.maxSeats === "number" && <AgentSlots view={view} />}
          {view?.transcripts && (
            <div
              className="resrow transcript-footprint"
              title={
                view.transcripts.seats.length === 0
                  ? "No transcripts"
                  : view.transcripts.seats
                      .map(
                        (seat) => `${seat.seatId} ${binaryBytes(seat.bytes)} · ${seat.files} files`,
                      )
                      .join("\n")
              }
            >
              <span className="s fg2">Transcripts</span>
              <span />
              <span className="num s">
                {binaryBytes(view.transcripts.totalBytes)}
                {view.transcripts.oldestAt !== null && tz && (
                  <TranscriptAge at={view.transcripts.oldestAt} />
                )}
              </span>
            </div>
          )}
          {view?.transcripts && (
            <section className="machine-transcript-detail">
              <h3>Transcript footprint by seat</h3>
              <table>
                <thead>
                  <tr>
                    <th>Seat</th>
                    <th>Footprint</th>
                    <th>Files</th>
                  </tr>
                </thead>
                <tbody>
                  {view.transcripts.seats.map((seat) => (
                    <tr key={seat.seatId}>
                      <th scope="row">{seat.seatId}</th>
                      <td className="num">{binaryBytes(seat.bytes)}</td>
                      <td className="num">{seat.files}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.transcripts.seats.length === 0 && <p>No transcripts reported.</p>}
            </section>
          )}
          <LockBox />
        </div>
        <p className="machine-window s muted">
          {measuredHistory
            ? `History: 30 complete minutes${summary?.at && tz ? ` ending ${hhmm(summary.at, tz)}` : ""} · missing minutes remain gaps · CPU and memory 0–100%${diskHistory.length ? ` · disk 0–${Math.max(1, ...diskHistory).toFixed(0)} GiB free` : " · disk history not collected"}.`
            : "History not collected · current sample only. Bars begin at zero; CPU and memory show percent used, disk shows percent used."}
          {measuredHistory && missingHistory.length > 0 && (
            <>
              {" "}
              {missingHistory.join(", ")} history not collected; those bars use the current sample.
            </>
          )}
        </p>
      </div>
    </Panel>
  );
}

function TranscriptAge({ at }: { at: number }) {
  const now = useNow(),
    tz = useTz();
  return tz ? <span className="muted"> · oldest {rel(at, now, tz)}</span> : null;
}

/** Lock changes are independent of host history and do not rebuild charts on the second clock. */
function MachineLockSummary({ onInspect }: { onInspect?: () => void }) {
  const lock = useTestLock();
  return (
    <button
      type="button"
      className={lock?.holder || lock?.waiting.length ? "warn-t" : undefined}
      onClick={onInspect}
    >
      Test lock:{" "}
      {lock === undefined
        ? "loading"
        : lock.holder
          ? `${lock.holder.seatId} holds it · ${lock.waiting.length} waiting`
          : lock.waiting.length
            ? `${lock.waiting.length} waiting`
            : "free"}{" "}
      · full details →
    </button>
  );
}
