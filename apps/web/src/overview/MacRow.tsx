import type { MachineView, OverviewSummary } from "@mc/core";
import { useTestLock } from "../components/LockLines.tsx";
import { useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { percent } from "../fmt.ts";
import { Sparkline } from "../hud/Sparkline.tsx";
import { followLink, PAGE_PATHS } from "../router.ts";

const GIB = 2 ** 30;
const DASH = "—";
const gib = (bytes: number | null | undefined) =>
  bytes == null ? DASH : `${Number((bytes / GIB).toFixed(1))} GiB`;

function Measure({
  label,
  value,
  values,
  color,
  warn = false,
}: {
  label: string;
  value: string;
  values?: (number | null)[];
  color: string;
  warn?: boolean;
}) {
  return (
    <span className="mac-measure">
      <span className="muted">{label}</span> <b className={warn ? "warn-t num" : "num"}>{value}</b>
      {values?.some((reading) => reading !== null) && (
        <Sparkline values={values} color={color} label={`${label}, last 30 minutes`} />
      )}
    </span>
  );
}

/** This Mac at a glance, one row: is it coping? The full readout and its history are in Telemetry. */
export function MacRow() {
  const source = useResource<MachineView>(RESOURCES.machine);
  const summary = useResource<OverviewSummary>(RESOURCES.overview()).data;
  const lock = useTestLock();
  const nameOf = useSeatName();
  const latest = source.data?.latest ?? null;
  const cpu = latest?.cpuPct ?? null;
  const total = latest && latest.memTotalBytes > 0 ? latest.memTotalBytes : null;
  const mem =
    total !== null && latest?.memUsedBytes != null ? (100 * latest.memUsedBytes) / total : null;
  const swap = latest?.swapUsedBytes ?? null;
  const holder = lock?.holder?.seatId;
  return (
    <section id="macP" className="panel mac-row" aria-label="This machine">
      <h2>
        <a href={PAGE_PATHS.telemetry} onClick={(e) => followLink(e, PAGE_PATHS.telemetry)}>
          Mac
        </a>
      </h2>
      {source.error && !source.data ? (
        <span className="s warn-t">Machine reading could not load.</span>
      ) : (
        <>
          <Measure
            label="CPU"
            value={cpu === null ? DASH : percent(cpu)}
            values={summary?.machine?.cpu}
            color="var(--accent)"
          />
          <Measure
            label="Mem"
            value={mem === null ? DASH : percent(mem)}
            values={summary?.machine?.mem}
            color="var(--think)"
          />
          <Measure label="Swap" value={gib(swap)} color="var(--fg-2)" />
          <Measure
            label="Disk"
            value={gib(latest?.diskFreeBytes)}
            values={summary?.machine?.disk}
            color="var(--fg-2)"
          />
          <span className="mac-measure">
            <span className="muted">Lock</span>{" "}
            <b>{lock ? (holder ? nameOf(holder) : "free") : DASH}</b>
          </span>
        </>
      )}
      {source.data?.warning && (
        <span role="status" className="mac-warning s warn-t">
          Holding new work · {source.data.warning}
        </span>
      )}
    </section>
  );
}
