import { type AgentId, SUBAGENT_PILL, type Telemetry } from "@mc/core";
import { dur, kTokens } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { DASH, indexOf, type Scope } from "./common.ts";
import { TPanel as Panel } from "./TPanel.tsx";

/** The agents in view, in config order, with their series. */
function inView<T extends { agentId: AgentId }>(scope: Scope, rows: T[]): T[] {
  return scope.agents.flatMap((a) => rows.filter((r) => r.agentId === a.id));
}

export function ToolLatency({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const ms = (v: number | null): string => (v === null ? DASH : dur(v));
  return (
    <Panel id="tLat" title="Tool latency" sub="p50 and p95 per tool, most calls first">
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
                <th className="r" aria-sort="descending">
                  Calls
                </th>
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
    <Panel id="tSubs" title="Subagents" sub="spawned by the crew today, oldest first">
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
