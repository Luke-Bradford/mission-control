import type { MachineView, OverviewSummary } from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { fixed, hhmm, percent } from "../fmt.ts";
import { Sparkline } from "../hud/Sparkline.tsx";
import { followLink, telemetryPath } from "../router.ts";
import { useSession } from "../shell/session.ts";

const GIB = 2 ** 30;
const DASH = "—";
const HUB_OPEN_FILE_RESTART_THRESHOLD = 80;
const gib = (bytes: number | null | undefined) =>
  bytes == null ? DASH : `${Number((bytes / GIB).toFixed(1))} GiB`;

function Measure({
  label,
  value,
  values,
  color,
}: {
  label: string;
  value: string;
  values?: (number | null)[];
  color: string;
}) {
  return (
    <span className="mac-measure">
      <span className="muted">{label}</span> <b className="num">{value}</b>
      {values?.some((reading) => reading !== null) && (
        <Sparkline values={values} color={color} label={`${label}, last 30 minutes`} />
      )}
    </span>
  );
}

/** This Mac at a glance, one row: is it coping? The full readout and its history are in Telemetry. */
export function MacRow() {
  const source = useResource<MachineView>(RESOURCES.machine);
  const [session] = useSession();
  const summary = useResource<OverviewSummary>(RESOURCES.overview(session)).data;
  const now = useNow();
  const tz = useTz();
  const lock = useTestLock();
  const nameOf = useSeatName();
  const latest = source.data?.latest ?? null;
  // CPU needs two samples; until the reading has one, the sparkline's last point stands in.
  const cpu = latest?.cpuPct ?? summary?.machine?.cpu?.findLast((v) => v !== null) ?? null;
  const total = latest && latest.memTotalBytes > 0 ? latest.memTotalBytes : null;
  const mem =
    total !== null && latest?.memUsedBytes != null ? (100 * latest.memUsedBytes) / total : null;
  const swap = latest?.swapUsedBytes ?? null;
  const hubOpenFiles = latest?.hubOpenFiles ?? null;
  const hubOpenFileLimit = latest?.hubOpenFileLimit ?? null;
  const hubFileReading =
    hubOpenFiles !== null && hubOpenFileLimit !== null && hubOpenFileLimit > 0
      ? {
          openFiles: hubOpenFiles,
          limit: hubOpenFileLimit,
          use: (100 * hubOpenFiles) / hubOpenFileLimit,
        }
      : null;
  const hubFileWarning =
    hubFileReading !== null && hubFileReading.use >= HUB_OPEN_FILE_RESTART_THRESHOLD;
  const holder = lock?.holder?.seatId;
  return (
    <section id="macP" className="panel mac-row" aria-label="This machine">
      <h2>
        <a href={telemetryPath("machine")} onClick={(e) => followLink(e, telemetryPath("machine"))}>
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
          <span
            className={`mac-measure mac-files${hubFileWarning ? " warn-t" : ""}`}
            data-testid="hub-open-files"
          >
            <span className="muted">Hub files</span>{" "}
            <b className="num">
              {hubFileReading === null
                ? "unknown"
                : `${fixed(hubFileReading.openFiles, 0)} / ${fixed(hubFileReading.limit, 0)} open files`}
            </b>
            {hubFileReading !== null && (
              <span>
                {" "}
                ·{" "}
                {hubFileWarning
                  ? `at or above the ${HUB_OPEN_FILE_RESTART_THRESHOLD}% restart threshold`
                  : `below the ${HUB_OPEN_FILE_RESTART_THRESHOLD}% restart threshold`}
              </span>
            )}
          </span>
        </>
      )}
      {source.error && source.data && (
        <span role="status" className="mac-warning s warn-t">
          Refresh failed · last sample {latest && tz ? hhmm(latest.at, tz) : "time unknown"}
        </span>
      )}
      {!source.error && latest && now - latest.at > 5 * 60_000 && (
        <span role="status" className="mac-warning s warn-t">
          Last sample {tz ? hhmm(latest.at, tz) : "time unknown"}
        </span>
      )}
      {source.data?.warning && (
        <span role="status" className="mac-warning s warn-t">
          Holding new work · {source.data.warning}
        </span>
      )}
    </section>
  );
}
