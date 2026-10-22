import {
  type AgentId,
  type AgentSeries,
  LIVE_MINUTES,
  SUBAGENT_PILL,
  TELEMETRY_RANGES,
  type Telemetry,
} from "@mc/core";
import { type ReactNode, useState } from "react";
import { dur, kTokens } from "../fmt.ts";
import { AgentTag, agentColor } from "../hud/AgentTag.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { StackedArea } from "../hud/charts/StackedArea.tsx";
import { VBars } from "../hud/charts/VBars.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { Seg } from "../hud/Seg.tsx";
import { DASH, indexOf, minutesAgo, type Scope } from "./common.ts";

type TokMode = "live" | "hist";
const TOK_MODES = [
  { value: "live", label: "Live" },
  { value: "hist", label: "History" },
] as const;

/**
 * **Decision:** three buckets. The observed loops have no lock or review waits, so the mockup's
 * "waiting (lock, reviews)" and "blocked, parked or stalled" become one: waiting on you (amber,
 * which always means you).
 */
const UTIL = [
  { key: "working", label: "working", color: "var(--ok)" },
  { key: "waiting", label: "waiting on you", color: "var(--warn-mark)" },
  { key: "idle", label: "idle", color: "var(--line-2)" },
] as const;

const TURN_KINDS = [
  { key: "input", label: "input" },
  { key: "output", label: "output" },
  { key: "cacheRead", label: "cache read" },
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
          />
          <Legend items={series.map((s) => ({ key: s.id, name: s.name, color: s.color }))} />
        </div>
      )}
    </Panel>
  );
}

function Utilisation({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const rows = t ? inView(scope, t.utilisation) : [];
  let body: ReactNode;
  if (!t) body = <p className="pb s muted">{scope.wait}</p>;
  else if (t.utilisation.length === 0) body = <p className="pb s muted">No agents configured.</p>;
  else if (rows.length === 0) body = <p className="pb s muted">No agents match this filter.</p>;
  else
    body = (
      <div className="pb">
        {rows.map((r) => (
          <div className="hrow util" key={r.agentId}>
            <span>
              <AgentTag id={r.agentId} index={indexOf(scope, r.agentId)} sm />
            </span>
            <span className="ubar">
              {UTIL.filter((u) => r[u.key] > 0).map((u) => (
                <i
                  key={u.key}
                  title={`${u.label} ${Math.round(r[u.key])}%`}
                  style={{ width: `${r[u.key]}%`, background: u.color }}
                />
              ))}
            </span>
            <span className="num xs">{Math.round(r.working)}%</span>
          </div>
        ))}
        <div className="tnote">
          <Legend items={UTIL.map((u) => ({ key: u.key, name: u.label, color: u.color }))} />
        </div>
      </div>
    );
  return (
    <Panel id="tUtil" title="Where agent time goes" sub="share of today, per agent">
      {body}
    </Panel>
  );
}

function TokensPerTurn({
  t,
  scope,
  agent,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  agent: AgentId | null;
}) {
  const turns = t?.turnUsage.find((u) => u.agentId === agent)?.turns ?? [];
  let body: ReactNode;
  if (!t) body = <p className="pb s muted">{scope.wait}</p>;
  else if (agent === null)
    body = (
      <p className="pb s muted">
        {scope.all.length === 0 ? "No agents configured." : "No agents match this filter."}
      </p>
    );
  else if (turns.length === 0)
    body = <p className="pb s muted">No turns recorded for {agent} yet.</p>;
  else {
    const kinds = TURN_KINDS.map((k, i) => ({ ...k, color: agentColor(i) }));
    body = (
      <div className="pb">
        <VBars
          label={`Tokens per turn, ${agent}`}
          height={160}
          every={Math.max(1, Math.ceil(turns.length / 8))}
          format={kTokens}
          bars={turns.map((u, i) => ({
            key: String(i),
            label: `turn ${i + 1}`,
            tip: `turn ${i + 1}`,
            segments: kinds.map((k) => ({ name: k.label, value: u[k.key], color: k.color })),
          }))}
        />
        <Legend items={kinds.map((k) => ({ key: k.key, name: k.label, color: k.color }))} />
      </div>
    );
  }
  // Decision: the server sends the latest run's turns, finished or not, so "latest run".
  return (
    <Panel id="tTurn" title="Tokens per turn" sub={agent === null ? DASH : `${agent} · latest run`}>
      {body}
    </Panel>
  );
}

function ToolLatency({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const ms = (v: number | null): string => (v === null ? DASH : dur(v));
  return (
    // Decision: no Slowest column; the digest keeps durations, not which call took them.
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Subagents({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
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

/** Agents (catalogue 2.6.4): tokens per minute, where time goes, per turn, tool latency, subagents. */
export function AgentsGroup({
  t,
  scope,
  turnAgent,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  /** Whose turns: the Agent filter, else the selected agent in view, else the first in view. */
  turnAgent: AgentId | null;
}) {
  return (
    <div className="tgrid">
      <TokensPerMinute t={t} scope={scope} />
      <Utilisation t={t} scope={scope} />
      <TokensPerTurn t={t} scope={scope} agent={turnAgent} />
      <ToolLatency t={t} scope={scope} />
      <Subagents t={t} scope={scope} />
    </div>
  );
}
