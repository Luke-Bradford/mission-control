import {
  LOCK_OUTCOME_TEXT,
  lockWaitingLine,
  type MachineView,
  startOfLocalDay,
  TELEMETRY_RANGES,
  type Telemetry,
  type TestLockHistory,
  type TestLockRun,
} from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { useSeatName } from "../crew.ts";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm, minutesAgo, mss } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { Panel } from "../hud/Panel.tsx";
import { agentPath, telemetryPath } from "../router.ts";
import { chartAnnotations } from "./annotations.ts";
import { DASH, indexOf, NOT_TRACKED, type Scope } from "./common.ts";
import { LOCK_TILE_FREE, LOCK_TILE_LABEL, lockFreeDetail, lockHolderDetail } from "./guardCopy.ts";
import { MachineReadout } from "./MachineReadout.tsx";
import { Stat, type StatSpec } from "./Stat.tsx";

const MINUTE_MS = 60_000;
export const MACHINE_SUMMARY_COUNT = 6;
/** Said in place of a series the server does not send yet: never drawn as a flat zero. */
export const NOT_COLLECTED = "not collected yet";
const LOCK_TABLE_HREF = telemetryPath("machine", "table");

type Sample = Telemetry["machine"][number];

/** Whether any sample in the window carries a reading for `key`. */
const collected = (machine: Sample[], key: keyof Sample): boolean =>
  machine.some((m) => m[key] != null);

const pct = (v: number | null | undefined): string => (v == null ? DASH : String(Math.round(v)));

/** The lock's runs with the one in progress, which the history may not hold yet; newest first. */
function lockRuns(
  history: TestLockHistory | undefined,
  holder: NonNullable<ReturnType<typeof useTestLock>>["holder"] | undefined,
): TestLockRun[] {
  const runs = [...(history?.runs ?? [])];
  if (holder && !runs.some((r) => r.runId === holder.runId && r.startedAt === holder.since))
    runs.unshift({
      runId: holder.runId,
      seatId: holder.seatId,
      command: holder.command,
      queuedAt: holder.since,
      startedAt: holder.since,
      endedAt: null,
      outcome: null,
      ticket: null,
    });
  return runs;
}

/** The Machine summary row: memory, CPU and swap now, and the test lock. */
export function MachineSummaryRow({
  t,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const nameOf = useSeatName();
  const now = useSecond();
  const view = useResource<MachineView>(RESOURCES.machine).data;
  const lock = useTestLock();
  const history = useResource<TestLockHistory>(RESOURCES.testLockHistory);
  const latest = view?.latest ?? null;
  const last = t?.machine.at(-1);
  const memTotal = latest && latest.memTotalBytes > 0 ? latest.memTotalBytes : null;
  const memUsedPct =
    memTotal !== null && latest?.memUsedBytes != null
      ? (100 * latest.memUsedBytes) / memTotal
      : (last?.memPct ?? null);
  // macOS's own free share when it is read; otherwise what is not in use.
  const memFree = latest?.memoryPressureFreePct ?? (memUsedPct === null ? null : 100 - memUsedPct);
  const cpu = latest?.cpuPct ?? last?.cpuPct ?? null;
  const swapTotal = latest?.swapTotalBytes;
  const swap =
    latest?.swapUsedBytes != null && swapTotal != null && swapTotal > 0
      ? Math.min(100, (100 * latest.swapUsedBytes) / swapTotal)
      : (last?.swapPct ?? null);
  const loadedMachine = t !== undefined || view !== undefined;
  const why = (v: number | null, none: string): string | undefined =>
    v !== null ? undefined : loadedMachine ? none : "Loading.";
  const day = history.data?.today;
  const holder = lock?.holder ?? null;
  const lockLoaded = history.data !== undefined || history.error !== null;
  const stats: StatSpec[] = [
    {
      id: "mem",
      label: "Memory free",
      value: pct(memFree),
      unit: "% of memory",
      window: "now",
      reason: why(memFree, "No memory reading yet."),
      definition: "Memory the Mac has free now: macOS's memory-pressure free share.",
      drill: { kind: "needs-route", target: "the runs using the most memory" },
    },
    {
      id: "cpu",
      label: "CPU",
      value: pct(cpu),
      unit: "% of capacity",
      window: "now",
      reason: why(cpu, "No CPU reading yet."),
      definition: "CPU in use across all cores now.",
      drill: { kind: "needs-route", target: "the runs using the most CPU" },
    },
    {
      id: "swap",
      label: "Swap used",
      value: pct(swap),
      unit: "% of swap",
      window: "now",
      reason: why(
        swap,
        swapTotal === 0
          ? "The Mac has no swap file."
          : `Swap is ${NOT_COLLECTED}: the server sent no swap reading.`,
      ),
      definition: "Share of the swap file in use now.",
      drill: { kind: "needs-route", target: "the runs using swap" },
    },
    {
      id: "lockwait",
      label: "Lock wait",
      value: day ? (day.waitMs / MINUTE_MS).toFixed(1) : DASH,
      unit: "min",
      window: "today",
      reason: day ? undefined : lockLoaded ? "Test lock history is not tracked yet." : "Loading.",
      definition: "Total time seats waited for the test lock today.",
      drill: { kind: "link", href: LOCK_TABLE_HREF, target: "the Test lock table" },
    },
    {
      id: "lock",
      label: LOCK_TILE_LABEL,
      value: lock === undefined ? DASH : holder ? nameOf(holder.seatId) : LOCK_TILE_FREE,
      unit: holder ? "holds it" : "lock",
      window: "now",
      reason: lock === undefined ? "Loading." : undefined,
      detail:
        lock === undefined
          ? undefined
          : holder
            ? lockHolderDetail(mss(now - holder.since), lock.waiting.length)
            : lockFreeDetail(lock.waiting.length),
      definition: "The seat running a full test suite now, or Free.",
      drill: holder
        ? { kind: "link", href: agentPath(holder.seatId), target: "that seat's page" }
        : { kind: "link", href: LOCK_TABLE_HREF, target: "the Test lock table" },
    },
    {
      id: "runs",
      label: "Full-suite runs",
      value: day ? String(day.runs) : DASH,
      unit: "runs",
      window: "today",
      reason: day ? undefined : lockLoaded ? "Test lock history is not tracked yet." : "Loading.",
      definition: "Full test-suite runs under the lock today.",
      drill: { kind: "link", href: LOCK_TABLE_HREF, target: "the Test lock table" },
    },
  ];
  return (
    <section className="summary" aria-label="Machine summary">
      <div className="scope">
        <b>Last 24 h</b>
        <span>Range 24h</span>
      </div>
      {stats.map((s) => (
        <Stat key={s.id} stat={s} onNeedsRoute={onNeedsRoute} />
      ))}
    </section>
  );
}

/** What a panel says in place of a chart. */
const say = (text: string) => <p className="pb s muted">{text}</p>;

/** A round top for a stacked memory axis, in GB. */
function niceGb(v: number): number {
  const steps = [4, 8, 16, 32, 48, 64, 96, 128, 192, 256];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 64) * 64;
}

const gb = (v: number): string => `${Math.round(v * 10) / 10} GB`;

/**
 * The Machine tab's charts: CPU over Memory used on one time axis, then Memory pressure and swap
 * beside Agent and test-run memory. Full-suite runs under the test lock are shaded on CPU and memory.
 */
export function MachineCharts({
  t,
  scope,
  dim,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  dim: boolean;
}) {
  const now = useSecond();
  const nameOf = useSeatName();
  const history = useResource<TestLockHistory>(RESOURCES.testLockHistory).data;
  const lock = useTestLock();
  const machine = t?.machine ?? [];
  const from = now - TELEMETRY_RANGES[scope.range] * MINUTE_MS;
  const chart = {
    from,
    to: now,
    xLabels: [`-${scope.range}`, "now"] as [string, string],
    at: (ms: number) => minutesAgo((now - ms) / MINUTE_MS),
    // the window ends now and slides every second, while the telemetry under it is fresh
    live: scope.live,
    fill: true,
    height: 96,
  };
  const bands = lockRuns(history, lock?.holder).map((r) => ({
    from: r.startedAt,
    to: r.endedAt ?? now,
    label: `${nameOf(r.seatId)} suite`,
  }));
  const annotations = chartAnnotations(t?.series?.annotations ?? []);
  const line = (
    id: string,
    name: string,
    color: string,
    key: keyof Omit<Sample, "at">,
  ): LineSeries => ({
    id,
    name,
    color,
    points: machine.map((m) => ({ at: m.at, v: m[key] ?? null })),
  });
  const lockKey = { key: "lock", name: "test lock held", color: "var(--warn)" };
  const swapSeen = collected(machine, "swapPct");
  const pressureSeen = collected(machine, "pressurePct");
  const agentsSeen = collected(machine, "agentGb");
  const testsSeen = collected(machine, "testRunGb");
  const pressureLines = [
    ...(pressureSeen ? [line("pressure", "Memory pressure", "var(--warn)", "pressurePct")] : []),
    ...(swapSeen ? [line("swap", "Swap used", "var(--fg-2)", "swapPct")] : []),
  ];
  const stacked = [
    ...(agentsSeen ? [line("agents", "Agents", "var(--accent)", "agentGb")] : []),
    ...(testsSeen ? [line("tests", "Test runs", "var(--think)", "testRunGb")] : []),
  ];
  const peakGb = Math.max(1, ...machine.map((m) => (m.agentGb ?? 0) + (m.testRunGb ?? 0)));
  const topGb = niceGb(peakGb);
  const missing = (parts: [boolean, string][]): string[] =>
    parts.filter(([seen]) => !seen).map(([, name]) => `${name} ${NOT_COLLECTED}`);
  const empty = machine.length === 0;
  const body = (children: React.ReactNode) =>
    !t ? say(scope.wait) : empty ? say(`No machine samples in the last ${scope.range}.`) : children;

  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="charts" data-tab="machine">
      <Panel id="tMach" title="CPU" sub="% of capacity · shaded while the test lock is held">
        {body(
          <div className="pb">
            <MachineReadout />
            <LineChart
              series={[line("cpu", "CPU", "var(--accent)", "cpuPct")]}
              label="CPU"
              bands={bands}
              annotations={annotations}
              xAxis={false}
              {...chart}
            />
            <Legend items={[{ key: "cpu", name: "CPU", color: "var(--accent)" }, lockKey]} />
          </div>,
        )}
      </Panel>
      <Panel id="mMem" title="Memory used" sub="% of memory · same time axis as CPU">
        {body(
          <div className="pb">
            <LineChart
              series={[line("mem", "Memory used", "var(--think)", "memPct")]}
              label="Memory used"
              bands={bands}
              annotations={annotations}
              {...chart}
            />
            <Legend items={[{ key: "mem", name: "Memory used", color: "var(--think)" }, lockKey]} />
          </div>,
        )}
      </Panel>
      <Panel id="mPressure" title="Memory pressure and swap" sub="% · not shaded">
        {body(
          <div className="pb">
            {pressureLines.length === 0 ? (
              <p className="s muted">Memory pressure and swap: {NOT_COLLECTED}.</p>
            ) : (
              <>
                <LineChart
                  series={pressureLines}
                  label="Memory pressure and swap"
                  annotations={annotations}
                  {...chart}
                />
                <Legend
                  items={pressureLines.map((l) => ({ key: l.id, name: l.name, color: l.color }))}
                />
                {missing([
                  [pressureSeen, "Memory pressure"],
                  [swapSeen, "Swap used"],
                ]).map((m) => (
                  <p key={m} className="pnote">
                    {m}.
                  </p>
                ))}
              </>
            )}
          </div>,
        )}
      </Panel>
      <Panel id="mAgentMem" title="Agent and test-run memory" sub="GB, stacked">
        {body(
          <div className="pb">
            {stacked.length === 0 ? (
              <p className="s muted">Agent and test-run memory: {NOT_COLLECTED}.</p>
            ) : (
              <>
                <LineChart
                  series={stacked}
                  label="Agent and test-run memory"
                  max={topGb}
                  ticks={[0, topGb / 2, topGb]}
                  format={gb}
                  stack
                  annotations={annotations}
                  {...chart}
                />
                <Legend items={stacked.map((l) => ({ key: l.id, name: l.name, color: l.color }))} />
                {missing([
                  [agentsSeen, "Agents"],
                  [testsSeen, "Test runs"],
                ]).map((m) => (
                  <p key={m} className="pnote">
                    {m}.
                  </p>
                ))}
              </>
            )}
          </div>,
        )}
      </Panel>
    </div>
  );
}

/** The Table view: today's full-suite runs under the test lock, and who waits. */
export function MachineTable({ scope, dim }: { scope: Scope; dim: boolean }) {
  const now = useSecond();
  const tz = useTz();
  const nameOf = useSeatName();
  const history = useResource<TestLockHistory>(RESOURCES.testLockHistory).data;
  const lock = useTestLock();
  const crew = useResource<{ rows: { id: string; hudState: string }[] }>(RESOURCES.crew).data;
  const h = lock?.holder;
  const holds = lockRuns(history, h);
  const today =
    tz === null
      ? []
      : holds.filter((r) => r.endedAt === null || r.startedAt >= startOfLocalDay(now, tz));
  const result = (r: TestLockRun) =>
    r.outcome === null
      ? crew?.rows.find((row) => row.id === r.seatId)?.hudState === "stalled"
        ? "no output"
        : "running"
      : LOCK_OUTCOME_TEXT[r.outcome];
  const waits = new Map<string, number>();
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="table" data-n="1">
      <Panel id="tLock" title="Test lock" sub="full-suite runs, waits and stops today">
        {!history && !h ? (
          <p className="pb s muted">{NOT_TRACKED}</p>
        ) : tz === null ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : today.length === 0 ? (
          <p className="pb s muted">No full-suite runs today.</p>
        ) : (
          <div className="pb tw">
            <table>
              <thead>
                <tr>
                  {["Started", "Agent", "Run", "Waited", "Took", "Result"].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {today.map((r) => (
                  <tr key={`${r.runId}:${r.startedAt}`}>
                    <td className="num">{tz ? hhmm(r.startedAt, tz) : DASH}</td>
                    <td>
                      <AgentTag id={r.seatId} index={indexOf(scope, r.seatId)} sm bare />
                    </td>
                    <td>
                      <span className="chipref">{r.command}</span>
                    </td>
                    <td className="num">
                      {/* The live row's Waited is "—" because /api/test-lock gives no queued time. */}
                      {history?.runs.some(
                        (stored) => stored.runId === r.runId && stored.startedAt === r.startedAt,
                      )
                        ? mss(r.startedAt - r.queuedAt)
                        : DASH}
                    </td>
                    <td className="num">{mss((r.endedAt ?? now) - r.startedAt)}</td>
                    <td className={r.outcome === "freed" ? "warn-t" : "ok-t"}>{result(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {h && !history && <p className="pb s muted">History: {NOT_TRACKED}</p>}
        {lock && (
          <div className="pb">
            {lock.waiting.length === 0 ? (
              <p className="s muted">Nobody waiting.</p>
            ) : (
              lock.waiting.map((w) => {
                const n = (waits.get(w.runId) ?? 0) + 1;
                waits.set(w.runId, n);
                return (
                  <p key={`${w.runId}#${n}`} className="s warn-t">
                    {lockWaitingLine(nameOf(w.seatId), mss(now - w.since))}
                  </p>
                );
              })
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
