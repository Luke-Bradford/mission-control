import {
  type AgentId,
  type AgentSeries,
  LIVE_MINUTES,
  SUBAGENT_PILL,
  TELEMETRY_RANGES,
  type Telemetry,
} from "@mc/core";
import { useState } from "react";
import { dur, kTokens, minutesAgo } from "../fmt.ts";
import { AgentTag, agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { StackedArea } from "../hud/charts/StackedArea.tsx";
import { Pill } from "../hud/Pill.tsx";
import { Seg } from "../hud/Seg.tsx";
import { DASH, indexOf, type Scope } from "./common.ts";
import { TPanel as Panel } from "./TPanel.tsx";

type TokMode = "live" | "hist";
const TOK_MODES = [
  { value: "live", label: "Live" },
  { value: "hist", label: "History" },
] as const;

/** The agents in view, in config order, with their series. */
function inView<T extends { agentId: AgentId }>(scope: Scope, rows: T[]): T[] {
  return scope.agents.flatMap((a) => rows.filter((r) => r.agentId === a.id));
}

function TokensPerMinute({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const [mode, setMode] = useState<TokMode>("live");
  const live = mode === "live";
  const sub = live
    ? `live · last ${LIVE_MINUTES} minutes, by agent`
    : `history · last ${scope.range}, by agent`;
  const span = live ? `${LIVE_MINUTES} minutes` : scope.range;
  const rows: AgentSeries[] = t ? inView(scope, live ? t.liveMinutes : t.tokensPerMinute) : [];
  const series = rows.map((r) => ({
    id: r.agentId,
    name: r.agentId,
    color: agentColor(indexOf(scope, r.agentId)),
    values: r.points,
  }));
  const any = series.some((s) => s.values.some((v) => v > 0));
  const rangeMin = TELEMETRY_RANGES[scope.range];
  const pointTimes = Array.from(
    { length: series[0]?.values.length ?? 0 },
    (_, i) =>
      Date.now() -
      (live ? LIVE_MINUTES : rangeMin) *
        60_000 *
        (1 - i / Math.max(1, (series[0]?.values.length ?? 1) - 1)),
  );

  return (
    <Panel
      id="tTok"
      title="Tokens per minute"
      sub={sub}
      className="wide"
      actions={
        <Seg label="Tokens per minute" options={TOK_MODES} value={mode} onChange={setMode} />
      }
    >
      {!t ? (
        <p className="pb s muted">{scope.wait}</p>
      ) : !any ? (
        <p className="pb s muted">No tokens in the last {span}.</p>
      ) : (
        <div className="pb">
          <StackedArea
            series={series}
            label={`Tokens per minute, last ${span}`}
            xLabels={live ? [`${LIVE_MINUTES} min ago`, "now"] : [`-${scope.range}`, "now"]}
            at={(i, n) => minutesAgo(live ? n - 1 - i : rangeMin * (1 - i / (n - 1)))}
            format={kTokens}
            live={scope.live}
            times={pointTimes}
          />
          <Legend items={series.map((s) => ({ key: s.id, name: s.name, color: s.color }))} />
        </div>
      )}
    </Panel>
  );
}

export function ToolLatency({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const ms = (v: number | null): string => (v === null ? DASH : dur(v));
  return (
    <Panel id="tLat" title="Tool latency" sub="p50 and p95 per tool">
      {!t ? (
        <p className="pb s muted">{scope.wait}</p>
      ) : t.toolLatency.length === 0 ? (
        <p className="pb s muted">No tool calls in the last {scope.range}.</p>
      ) : (
        <div className="pb tw">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th className="r">Calls</th>
                <th className="r">p50</th>
                <th className="r">p95</th>
                <th className="r">Failed</th>
                <th>Slowest</th>
              </tr>
            </thead>
            <tbody>
              {t.toolLatency.map((r) => (
                <tr key={r.tool}>
                  <td>{r.tool}</td>
                  <td className="r num">{r.calls}</td>
                  <td className="r num">{ms(r.p50Ms)}</td>
                  <td className="r num">{ms(r.p95Ms)}</td>
                  <td className={`r num ${r.failed > 0 ? "warn-t" : "muted"}`}>{r.failed}</td>
                  <td className="muted wrap">
                    {r.slowest
                      ? `${r.slowest.detail ?? DASH} (${dur(r.slowest.durationMs)}, ${r.slowest.agentId})`
                      : DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function Subagents({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const rows = t ? inView(scope, t.subagents) : [];
  return (
    <Panel id="tSubs" title="Subagents" sub="spawned by the crew today">
      {!t ? (
        <p className="pb s muted">{scope.wait}</p>
      ) : rows.length === 0 ? (
        <p className="pb s muted">No subagents spawned today.</p>
      ) : (
        <div className="pb tw">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Type</th>
                <th>Task</th>
                <th className="r">Tokens</th>
                <th className="r">Tools</th>
                <th className="r">Took</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const pill = SUBAGENT_PILL[x.status];
                return (
                  <tr key={`${x.agentId}:${x.taskId}`}>
                    <td>
                      <AgentTag id={x.agentId} index={indexOf(scope, x.agentId)} sm />
                    </td>
                    <td>{x.type}</td>
                    <td className="wrap fg2">{x.description}</td>
                    <td className="r num">{x.tokens === null ? DASH : kTokens(x.tokens)}</td>
                    <td className="r num">{x.toolUses === null ? DASH : x.toolUses}</td>
                    <td className="r num">
                      {x.durationMs !== null
                        ? dur(x.durationMs)
                        : x.status === "completed"
                          ? DASH
                          : null}
                      {x.status !== "completed" && (
                        <>
                          {x.durationMs !== null && " "}
                          <Pill tone={pill.tone}>{pill.label}</Pill>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The agent series the Cost and tokens tab will take over: tokens per minute, by agent. */
export function AgentsGroup({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  return (
    <div className="tgrid">
      <TokensPerMinute t={t} scope={scope} />
    </div>
  );
}
