import type { MachineSample, MachineView, OverviewSummary } from "@mc/core";
import { useId } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { MACHINE_CHART_HEIGHT, machineAreaGeometry } from "./chartGeometry.ts";
import { LockBox } from "./LockBox.tsx";

const GIB = 2 ** 30;
/** At or under this much free memory another agent does not fit. */
const LOW_MEM_GB = 2;
const DASH = "—";
const NO_SAMPLE = "No machine sample yet";
const AGENTS_COLOUR = "var(--fg-2)";
const OTHER_COLOUR = "var(--line-2)";

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
}: {
  label: string;
  values: (number | null)[];
  max?: number;
  color: string;
}) {
  const gradient = `machine-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const geometry = machineAreaGeometry(
    values,
    max ?? Math.max(1, ...values.filter((value) => value !== null)),
  );
  if (geometry.line === null) return null;
  // The scale's top (as machineAreaGeometry draws it): `max` (100 %), or the series' own peak.
  const top = geometry.baseline - (MACHINE_CHART_HEIGHT - 5);
  return (
    <svg
      className="machine-chart"
      preserveAspectRatio="none"
      viewBox={`0 0 100 ${MACHINE_CHART_HEIGHT}`}
      role="img"
      aria-label={label}
      data-max={max ?? Math.max(1, ...values.filter((value) => value !== null))}
    >
      <title>{`${label} · last 30 minutes, a point a minute`}</title>
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
      <line className="machine-now" x1={100} x2={100} y1={0} y2={MACHINE_CHART_HEIGHT} />
    </svg>
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
  return { cores, cpu, agentsCpu, memTotal, memUsed, agentsMem, memPct, diskFree, diskPct };
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
        perSessionMax > 0 ? `up to ${perSessionMax} per session` : null,
        room ? `Room for ${free} more agent${free === 1 ? "" : "s"}` : "No room for another agent",
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
    </div>
  );
}

/** This Mac's CPU, memory and disk, the agents row and the test lock (catalogue 2.1.4). Lock history arrives with run records (2c). */
export function MachinePanel() {
  const view = useResource<MachineView>(RESOURCES.machine).data;
  const summary = useResource<OverviewSummary>(RESOURCES.overview()).data;
  const m = view?.latest ?? null;
  const u = usage(m);
  const none = m === null ? NO_SAMPLE : undefined;

  return (
    <Panel id="machP" title="Machine" sub="this Mac · every 2 s">
      <div className="pb">
        <div
          className="res"
          title={`Claude/Codex processes (${m?.agents ? m.agents.count : DASH}) · other apps`}
        >
          <div className="resrow">
            <span className="s fg2">CPU</span>
            {summary?.machine?.cpu?.length ? (
              <MachineAreaChart
                label="CPU history"
                values={summary.machine.cpu}
                max={100}
                color="var(--accent)"
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
              {u.cpu === null ? DASH : `${Math.round(u.cpu)}%`}
              <span className="muted">
                {" "}
                of{" "}
                <span title={u.cores === null ? "Core count not read" : undefined}>
                  {u.cores ?? DASH}
                </span>{" "}
                threads
              </span>
            </span>
          </div>
          <div className="resrow">
            <span className="s fg2">Memory</span>
            {summary?.machine?.mem?.length ? (
              <MachineAreaChart
                label="Memory history"
                values={summary.machine.mem}
                max={100}
                color="var(--think)"
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
                of {u.memTotal === null ? DASH : Math.round(u.memTotal / GIB)} GB
              </span>
            </span>
          </div>
          <div className="resrow">
            <span className="s fg2">Disk</span>
            {summary?.machine?.disk?.length ? (
              <MachineAreaChart
                label="Disk history · GB free"
                values={summary.machine.disk}
                color="var(--fg-2)"
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
              {u.diskFree === null ? DASH : `${Math.round(u.diskFree / GIB)} GB`}
              <span className="muted"> free</span>
            </span>
          </div>
          {view && typeof view.maxSeats === "number" && <AgentSlots view={view} />}
          <LockBox />
        </div>
      </div>
    </Panel>
  );
}
