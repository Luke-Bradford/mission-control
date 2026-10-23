import type { BoardItem, ConfigView, Telemetry } from "@mc/core";
import { ticketRef } from "../board/cards.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { cost, kTokens } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { HBar } from "../hud/charts/HBar.tsx";
import { Panel } from "../hud/Panel.tsx";
import { parseTicket, TicketRef } from "../hud/RepoRef.tsx";
import { DASH, indexOf, NOT_TRACKED, type Scope } from "./common.ts";

/** Cost (catalogue 2.6.6): tokens by ticket, totals and loop steps. */
export function CostGroup({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const tickets = t?.tokensByTicket ?? [];
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const ticketRepos = new Set(tickets.flatMap((r) => parseTicket(r.ticket)?.repoId ?? []));
  const repoIds = (config?.repos ?? []).filter((r) => ticketRepos.has(r.id)).map((r) => r.id);
  const boards = useResources<BoardItem[]>(repoIds.map(RESOURCES.boards));
  const titles = new Map(boards.flatMap((b) => (b.data ?? []).map((i) => [ticketRef(i), i.title])));
  const steps = t?.tokensByStep;
  const mostStep = Math.max(1, ...(steps?.map((r) => r.tokens) ?? []));
  const most = Math.max(1, ...tickets.map((r) => r.tokens));
  const inView = new Set(scope.agents.map((a) => a.id));
  const totals = (t?.totals ?? []).filter(
    (r) => inView.has(r.agentId) && (scope.account === "" || r.accountId === scope.account),
  );

  return (
    <div className="tgrid">
      <Panel id="tTicketBars" title="Tokens by ticket" sub="every agent and step on it">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : tickets.length === 0 ? (
          <p className="pb s muted">No ticket work in the last {scope.range}.</p>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the complete ticket list
          <section className="pb ticket-bars" aria-label="Ticket tokens" tabIndex={0}>
            {tickets.map((r) => (
              <HBar
                key={r.ticket}
                label={
                  <>
                    <TicketRef ticket={r.ticket} />
                    {titles.has(r.ticket) && (
                      <span className="ticket-bar-title">{titles.get(r.ticket)}</span>
                    )}
                  </>
                }
                pct={(r.tokens / most) * 100}
                value={kTokens(r.tokens)}
                extra={cost(r.costUsd)}
                title={`${r.ticket}${titles.has(r.ticket) ? ` · ${titles.get(r.ticket)}` : ""}: ${kTokens(r.tokens)} tokens`}
              />
            ))}
          </section>
        )}
      </Panel>
      <Panel id="tStepBars" title="Tokens by loop step" sub="repeats cost more">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : steps === undefined ? (
          <p className="pb s muted">{NOT_TRACKED}</p>
        ) : (
          <div className="pb">
            {steps.map((r) => (
              <HBar
                key={r.step}
                label={r.step}
                title={r.step}
                pct={(r.tokens / mostStep) * 100}
                value={kTokens(r.tokens)}
                extra={`${cost(r.costUsd)} · ${r.runs} runs`}
              />
            ))}
          </div>
        )}
      </Panel>
      <Panel id="tTotals" title="Totals" sub="selected range" className="wide">
        {!t ? (
          <p className="pb s muted">{scope.wait}</p>
        ) : totals.length === 0 ? (
          <p className="pb s muted">No usage for this filter in the last {scope.range}.</p>
        ) : (
          <div className="pb tw">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Account</th>
                  <th>Model</th>
                  <th className="r">Input</th>
                  <th className="r">Output</th>
                  <th className="r">Cache read</th>
                  <th className="r">Cache hit</th>
                  <th className="r">Turns</th>
                  <th className="r">Tool calls</th>
                  <th className="r">Lines (+/−)</th>
                  <th className="r">~Cost</th>
                </tr>
              </thead>
              <tbody>
                {totals.map((r) => (
                  <tr key={`${r.agentId}\n${r.model ?? ""}`}>
                    <td>
                      <AgentTag id={r.agentId} index={indexOf(scope, r.agentId)} sm />
                    </td>
                    <td className="muted">{r.accountId}</td>
                    <td className="muted">{r.model ?? DASH}</td>
                    <td className="r num">{kTokens(r.input)}</td>
                    <td className="r num">{kTokens(r.output)}</td>
                    <td className="r num">{kTokens(r.cacheRead)}</td>
                    <td className="r num">
                      {r.cacheHitPct === null ? DASH : `${Math.round(r.cacheHitPct)}%`}
                    </td>
                    <td className="r num">{r.turns}</td>
                    <td className="r num">{r.toolCalls}</td>
                    <td className="r num">
                      <span className="add">{r.additions == null ? DASH : `+${r.additions}`}</span>{" "}
                      <span className="del">{r.deletions == null ? DASH : `−${r.deletions}`}</span>
                    </td>
                    <td className="r num muted">{cost(r.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
