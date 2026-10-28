import {
  type ConfigView,
  type Crew,
  TELEMETRY_RANGES,
  type Telemetry as TelemetryData,
  type TelemetryRange,
} from "@mc/core";
import { useEffect, useId, useMemo, useState } from "react";
import { RESOURCES, useResource } from "../data.ts";
import { ChartCursorProvider } from "../hud/charts/Hover.tsx";
import { Seg } from "../hud/Seg.tsx";
import { useSelectedAgent } from "../shell/selection.ts";
import { AgentsGroup } from "../telemetry/AgentsGroup.tsx";
import { CapacityGroup } from "../telemetry/CapacityGroup.tsx";
import { CostGroup } from "../telemetry/CostGroup.tsx";
import type { AgentInfo, Scope } from "../telemetry/common.ts";
import { FlowOfWork } from "../telemetry/FlowOfWork.tsx";
import { InstrumentCharts } from "../telemetry/InstrumentCharts.tsx";
import { Kpis } from "../telemetry/Kpis.tsx";

const RANGES = (Object.keys(TELEMETRY_RANGES) as TelemetryRange[]).map((r) => ({
  value: r,
  label: r,
}));
const DEFAULT_RANGE: TelemetryRange = "6h";

/**
 * Telemetry (catalogue 2.6): running numbers, then history, from `GET /api/telemetry?range=`.
 * Agent, Account and Ticket scope the server's usage figures. Per-agent series, flow of work,
 * quota and machine retain their own scope. While a request loads the last response stays, dimmed.
 */
export function Telemetry() {
  const [range, setRange] = useState<TelemetryRange>(DEFAULT_RANGE);
  const [agent, setAgent] = useState("");
  const [account, setAccount] = useState("");
  const [ticket, setTicket] = useState("");
  const ticketSel = useId();
  const agentSel = useId();
  const accountSel = useId();
  const res = useResource<TelemetryData>(RESOURCES.telemetry(range, agent, account, ticket));
  const available = useResource<TelemetryData>(RESOURCES.telemetry(range, agent, account)).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const tickets = useMemo(
    () =>
      [
        ...new Set([
          ...(crew?.rows.flatMap((r) => (r.ticket ? [r.ticket] : [])) ?? []),
          ...(available?.tokensByTicket.map((r) => r.ticket) ?? []),
        ]),
      ].sort(),
    [crew, available],
  );
  useEffect(() => {
    if (ticket && available && !tickets.includes(ticket)) {
      setTicket("");
    }
  }, [ticket, available, tickets]);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const [selected] = useSelectedAgent();

  const [last, setLast] = useState<TelemetryData | undefined>(undefined);
  useEffect(() => {
    if (res.data) setLast(res.data);
  }, [res.data]);
  const t = res.data ?? last;
  const refetching = res.data === undefined && t !== undefined;

  // Config order: the loops, then each session's seats (the crew rows' colour order).
  const all: AgentInfo[] = config
    ? [
        ...config.loops.map((l) => ({ id: l.id, accountId: l.accountId })),
        ...(config.crew?.sessions.flatMap((s) => s.seats) ?? []).map((s) => ({
          id: s.id,
          accountId: s.accountId,
        })),
      ].map((a, index) => ({ ...a, index }))
    : (t?.tokensPerMinute.map((s, index) => ({ id: s.agentId, index, accountId: null })) ?? []);
  const agents = all.filter(
    (a) => (agent === "" || a.id === agent) && (account === "" || a.accountId === account),
  );
  const scope: Scope = {
    range,
    all,
    agents,
    account,
    ticket,
    wait: res.error && !t ? "Telemetry did not load." : "Loading…",
    live: res.data !== undefined && res.error === null,
  };
  const turnAgent = agents.find((a) => a.id === selected)?.id ?? agents[0]?.id ?? null;

  return (
    <ChartCursorProvider>
      <section id="page-telemetry" className={refetching ? "refetching" : undefined}>
        <div className="toolbar">
          <h1 className="toolbar-heading">Telemetry</h1>
          <Seg label="Range" options={RANGES} value={range} onChange={setRange} />
          <label className="s fg2" htmlFor={agentSel}>
            Agent
          </label>
          <select id={agentSel} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">All</option>
            {all.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
          <label className="s fg2" htmlFor={accountSel}>
            Account
          </label>
          <select id={accountSel} value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">All</option>
            {(config?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </select>
          <label className="s fg2" htmlFor={ticketSel}>
            Ticket
          </label>
          <select id={ticketSel} value={ticket} onChange={(e) => setTicket(e.target.value)}>
            <option value="">All</option>
            {(tickets.length ? tickets : ticket ? [ticket] : []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="note">
            Token counts come from each provider's usage events. Costs marked ~ are API-equivalent
            estimates; a subscription isn't billed per token.
          </span>
        </div>
        {res.error && !res.data && (
          <p className="s crit-t">Could not load telemetry: {res.error.message}</p>
        )}
        <Kpis t={t} live={scope.live} filtered={agent !== "" || account !== "" || ticket !== ""} />
        <h2 className="grp">Flow of work</h2>
        <FlowOfWork t={t} scope={scope} />
        <h2 className="grp">Instrument charts</h2>
        <InstrumentCharts scope={scope} series={t?.series} />
        <h2 className="grp">Agents</h2>
        <AgentsGroup t={t} scope={scope} turnAgent={turnAgent} />
        <h2 className="grp">Capacity</h2>
        <CapacityGroup t={t} scope={scope} />
        <h2 className="grp">Cost</h2>
        <CostGroup t={t} scope={scope} />
      </section>
    </ChartCursorProvider>
  );
}
