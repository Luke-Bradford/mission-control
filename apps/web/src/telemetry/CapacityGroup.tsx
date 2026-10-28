import {
  type CrewRow,
  LOCK_OUTCOME_TEXT,
  lockWaitingLine,
  startOfLocalDay,
  TELEMETRY_RANGES,
  type Telemetry,
  type TestLockHistory,
  type TestLockRun,
} from "@mc/core";
import { useSecond, useTz } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm, mss } from "../fmt.ts";
import { AgentTag, agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { Panel } from "../hud/Panel.tsx";
import { useSeatName } from "../seatName.ts";
import { DASH, indexOf, minutesAgo, NOT_TRACKED, type Scope } from "./common.ts";

const MINUTE_MS = 60_000;

/** Capacity (catalogue 2.6.5): quota per account window, machine load; the test lock waits. */
export function CapacityGroup({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const nameOf = useSeatName();
  const now = useSecond();
  const tz = useTz();
  const history = useResource<TestLockHistory>(RESOURCES.testLockHistory).data;
  const lock = useTestLock();
  const crew = useResource<{ rows: CrewRow[] }>(RESOURCES.crew).data;
  const waits = new Map<string, number>();
  const holds = [...(history?.runs ?? [])];
  const h = lock?.holder;
  if (h && !holds.some((r) => r.runId === h.runId && r.startedAt === h.since))
    holds.unshift({
      runId: h.runId,
      seatId: h.seatId,
      command: h.command,
      queuedAt: h.since,
      startedAt: h.since,
      endedAt: null,
      outcome: null,
      ticket: null,
    });
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
  const from = now - TELEMETRY_RANGES[scope.range] * MINUTE_MS;
  const chart = {
    from,
    to: now,
    xLabels: [`-${scope.range}`, "now"] as [string, string],
    at: (ms: number) => minutesAgo((now - ms) / MINUTE_MS),
    // the window ends now and slides every second, while the telemetry under it is fresh
    live: scope.live,
  };

  // A window keeps its colour whichever account is picked: its place among all the windows.
  const quota = (t?.quota ?? [])
    .map((q, i) => ({ q, color: agentColor(i) }))
    .filter(({ q }) => scope.account === "" || q.accountId === scope.account);
  const quotaLines: LineSeries[] = quota.map(({ q, color }) => ({
    id: `${q.accountId}:${q.window}`,
    name: `${q.accountId} ${q.window}`,
    color,
    points: q.points.map((p) => ({ at: p.at, v: p.pct })),
  }));
  // Usage is cumulative within a provider window. A lower subsequent reading is a reset, not a
  // spent-usage value of zero; mark the discontinuity so operators do not read it as a burn drop.
  const quotaResets = quota.flatMap(({ q }) =>
    q.points.flatMap((point, index) => {
      const previous = q.points[index - 1];
      return previous && point.pct < previous.pct
        ? [{ at: point.at, label: `${q.accountId} ${q.window} reset` }]
        : [];
    }),
  );
  const quotaLegend = quota.map(({ q, color }) => {
    const latest = q.points.at(-1);
    return {
      key: `${q.accountId}:${q.window}`,
      name: `${q.accountId} ${q.window} · ${latest ? `${Math.round(latest.pct)}%` : DASH}`,
      color,
    };
  });
  const machine = t?.machine ?? [];
  const machineLines: LineSeries[] = [
    {
      id: "cpu",
      name: "CPU",
      color: agentColor(0),
      points: machine.map((m) => ({ at: m.at, v: m.cpuPct })),
    },
    {
      id: "mem",
      name: "Memory",
      color: agentColor(1),
      points: machine.map((m) => ({ at: m.at, v: m.memPct })),
    },
  ];

  return (
    <div className="tgrid">
      <Panel id="tQuota" title="Quota used" sub="each account window, 100% is the limit">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : quotaLines.length === 0 ? (
          <p className="pb s muted">No quota readings in the last {scope.range}.</p>
        ) : (
          <div className="pb">
            <LineChart
              series={quotaLines}
              max={110}
              ticks={[0, 50, 100]}
              limit
              annotations={quotaResets}
              label="Quota used"
              {...chart}
            />
            <Legend items={quotaLegend} />
          </div>
        )}
      </Panel>
      <Panel
        id="tMach"
        title="Machine load"
        sub="% of capacity · shaded while the test lock is held"
      >
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : machine.length === 0 ? (
          <p className="pb s muted">No machine samples in the last {scope.range}.</p>
        ) : (
          <div className="pb">
            <LineChart
              series={machineLines}
              label="Machine load"
              bands={holds.map((r) => ({
                from: r.startedAt,
                to: r.endedAt ?? now,
                label: `${nameOf(r.seatId)} suite`,
              }))}
              {...chart}
            />
            <Legend
              items={[
                ...machineLines.map((l) => ({ key: l.id, name: l.name, color: l.color })),
                { key: "lock", name: "test lock held", color: "var(--warn)" },
              ]}
            />
          </div>
        )}
      </Panel>
      <Panel
        id="tLock"
        title="Test lock"
        sub="full-suite runs, waits and stops today"
        className="wide"
      >
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
