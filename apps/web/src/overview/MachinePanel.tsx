import { LOCK_HISTORY_NOTE, type MachineSample } from "@mc/core";
import { LockLines, useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";

const GIB = 2 ** 30;
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

/** This Mac's CPU, memory and disk (catalogue 2.1.4). Slots arrive with the engine; lock history with run records (2c). */
export function MachinePanel() {
  const machine = useResource<{ latest: MachineSample | null }>(RESOURCES.machine).data;
  const m = machine?.latest ?? null;
  const lock = useTestLock();
  const u = usage(m);
  const none = m === null ? NO_SAMPLE : undefined;

  return (
    <Panel id="machP" title="Machine" sub="this Mac · every 2 s">
      <div className="pb">
        <div className="res">
          <div className="resrow">
            <span className="s fg2">CPU</span>
            <Bar
              segs={
                u.cpu === null
                  ? []
                  : [
                      { pct: u.agentsCpu, colour: AGENTS_COLOUR, label: "Claude/Codex processes" },
                      { pct: u.cpu - u.agentsCpu, colour: OTHER_COLOUR, label: "other apps" },
                    ]
              }
            />
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
            <Bar
              segs={
                u.memPct === null
                  ? []
                  : [
                      { pct: u.agentsMem, colour: AGENTS_COLOUR, label: "Claude/Codex processes" },
                      { pct: u.memPct - u.agentsMem, colour: OTHER_COLOUR, label: "other apps" },
                    ]
              }
            />
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
            <Bar
              segs={
                u.diskPct === null ? [] : [{ pct: u.diskPct, colour: OTHER_COLOUR, label: "used" }]
              }
            />
            <span className="num s" title={none}>
              {u.diskFree === null ? DASH : `${Math.round(u.diskFree / GIB)} GB`}
              <span className="muted"> free</span>
            </span>
          </div>
          <div className="legend">
            <span>
              <i style={{ background: AGENTS_COLOUR }} />
              Claude/Codex processes ({m?.agents ? m.agents.count : DASH})
            </span>
            <span>
              <i style={{ background: OTHER_COLOUR }} />
              other apps
            </span>
          </div>
          <div className="lock">
            <div className="row">
              <h3 title={LOCK_HISTORY_NOTE}>Full test suite · one at a time</h3>
            </div>
            <LockLines lock={lock} nobodyWaiting />
          </div>
        </div>
      </div>
    </Panel>
  );
}
