import { ENGINE_NOT_RUNNING, TELEMETRY_RANGES, type Telemetry } from "@mc/core";
import { useNow } from "../clock.ts";
import { agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { LineChart, type LineSeries } from "../hud/charts/LineChart.tsx";
import { Panel } from "../hud/Panel.tsx";
import { minutesAgo, type Scope } from "./common.ts";

const MINUTE_MS = 60_000;

/** Capacity (catalogue 2.6.5): quota per account window, machine load; the test lock waits. */
export function CapacityGroup({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const now = useNow();
  const from = now - TELEMETRY_RANGES[scope.range] * MINUTE_MS;
  const chart = {
    from,
    to: now,
    xLabels: [`-${scope.range}`, "now"] as [string, string],
    at: (ms: number) => minutesAgo((now - ms) / MINUTE_MS),
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
              label="Quota used"
              {...chart}
            />
            <Legend
              items={quota.map(({ q, color }) => ({
                key: `${q.accountId}:${q.window}`,
                name: `${q.accountId} ${q.window} · ${Math.round(q.points.at(-1)?.pct ?? 0)}%`,
                color,
              }))}
            />
          </div>
        )}
      </Panel>
      {/* Decision: no test-lock shading; the lock arrives with the engine. */}
      <Panel id="tMach" title="Machine load" sub="% of capacity">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : machine.length === 0 ? (
          <p className="pb s muted">No machine samples in the last {scope.range}.</p>
        ) : (
          <div className="pb">
            <LineChart series={machineLines} label="Machine load" {...chart} />
            <Legend
              items={machineLines.map((l) => ({ key: l.id, name: l.name, color: l.color }))}
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
        <p className="pb note">{ENGINE_NOT_RUNNING}</p>
      </Panel>
    </div>
  );
}
