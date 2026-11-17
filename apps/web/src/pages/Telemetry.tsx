import {
  type ConfigView,
  type Crew,
  TELEMETRY_RANGES,
  type Telemetry as TelemetryData,
  type TelemetryRange,
} from "@mc/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { elapsed, hhmm } from "../fmt.ts";
import { ChartCursorProvider } from "../hud/charts/Hover.tsx";
import { Seg } from "../hud/Seg.tsx";
import {
  navigate,
  TELEMETRY_VIEWS,
  type TelemetryTab,
  type TelemetryView,
  telemetryPath,
  telemetryTabParam,
  telemetryViewParam,
  useSearch,
} from "../router.ts";
import { useStore } from "../shell/store.ts";
import { ComingTab } from "../telemetry/ComingTab.tsx";
import { CostPanels, CostSummaryRow } from "../telemetry/CostTab.tsx";
import { CrewPanels, CrewSummaryRow } from "../telemetry/CrewTab.tsx";
import type { AgentInfo, Scope } from "../telemetry/common.ts";
import { HealthBand } from "../telemetry/HealthBand.tsx";
import { RunsDialog } from "../telemetry/RunsDialog.tsx";
import type { StatSpec } from "../telemetry/Stat.tsx";
import { TAB_PANEL_ID, TabBar, tabId } from "../telemetry/TabBar.tsx";
import { tabDef } from "../telemetry/tabs.ts";
import "../telemetry/telemetry.css";

const RANGES = (Object.keys(TELEMETRY_RANGES) as TelemetryRange[]).map((r) => ({
  value: r,
  label: r,
}));
const DEFAULT_RANGE: TelemetryRange = "24h";
const VIEWS = TELEMETRY_VIEWS.map((v) => ({
  value: v,
  label: v === "charts" ? "Charts" : "Table",
}));

/** True when the crew did nothing in the range: no state but idle, no tool calls, no subagents. */
function nothingRan(t: TelemetryData): boolean {
  const spans = t.series?.stateSpans ?? [];
  return (
    t.today.toolCalls === 0 &&
    t.toolLatency.length === 0 &&
    t.subagents.length === 0 &&
    spans.every((s) => s.state === "idle")
  );
}

function StatePanel({
  kind,
  range,
  fixed,
  onRetry,
}: {
  kind: "loading" | "empty" | "error";
  range: string;
  fixed: string | null;
  onRetry: () => void;
}) {
  if (kind === "loading")
    return (
      <section className="panel state-panel" aria-busy="true" aria-label="Loading telemetry">
        <p>Loading…</p>
        <div className="skeleton" />
      </section>
    );
  if (kind === "empty")
    return (
      <section className="panel state-panel">
        <p>Nothing ran in the last {fixed ? "14 days" : range}.</p>
        <span className="pnote">Seats that start a run will appear here.</span>
      </section>
    );
  return (
    <section className="panel state-panel" role="alert">
      <p>Telemetry did not load.</p>
      <button type="button" className="tel-primary" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

/**
 * Telemetry: is the crew healthy right now? The health band answers at a glance; five tabs say why
 * (`?tab=`), each a Charts or Table view (`?view=`). Data is `GET /api/telemetry?range=`; Agent,
 * Account and Ticket scope the server's usage figures, and the band stays crew-wide. While a request
 * loads the last response stays, dimmed.
 */
export function Telemetry() {
  const search = useSearch();
  const tab = telemetryTabParam(search);
  const view = telemetryViewParam(search);
  const def = tabDef(tab);
  const [range, setRange] = useState<TelemetryRange>(DEFAULT_RANGE);
  const [agent, setAgent] = useState("");
  const [account, setAccount] = useState("");
  const [ticket, setTicket] = useState("");
  const [runs, setRuns] = useState<StatSpec | null>(null);
  const ticketSel = useId();
  const agentSel = useId();
  const accountSel = useId();
  const ref = RESOURCES.telemetry(range, agent, account, ticket);
  const res = useResource<TelemetryData>(ref);
  const bandRes = useResource<TelemetryData>(RESOURCES.telemetry(range));
  const available = useResource<TelemetryData>(RESOURCES.telemetry(range, agent, account)).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const tz = useTz();
  const connection = useStore(streamStatus);
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

  const [last, setLast] = useState<TelemetryData | undefined>(undefined);
  const updatedAt = useRef<number | null>(null);
  useEffect(() => {
    if (res.data) {
      setLast(res.data);
      updatedAt.current = Date.now();
    }
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

  const setTab = (next: TelemetryTab) => navigate(telemetryPath(next, view));
  const setView = (next: TelemetryView) => navigate(telemetryPath(tab, next));

  const stale = t !== undefined && res.error !== null;
  const disconnected = !connection.connected && connection.reconnecting;
  const age = updatedAt.current === null ? null : Date.now() - updatedAt.current;
  const when = updatedAt.current !== null && tz ? hhmm(updatedAt.current, tz) : null;
  const chip = disconnected
    ? {
        crit: true,
        text: `Not connected to the hub.${when ? ` These figures are from ${when}.` : ""}`,
      }
    : stale
      ? { crit: false, text: `Figures are ${age === null ? "old" : `${elapsed(age)} old`}.` }
      : null;
  const dim = chip !== null;
  const retry = () => hub.refetch(ref.path);
  const state: "loading" | "empty" | "error" | null =
    t === undefined
      ? res.error
        ? "error"
        : "loading"
      : tab === "crew" && nothingRan(t)
        ? "empty"
        : null;

  return (
    <ChartCursorProvider>
      <section id="page-telemetry" data-tab={tab} className={refetching ? "refetching" : undefined}>
        <div className="toolbar">
          <h1 className="toolbar-heading">Telemetry</h1>
          {!def.fixed && <Seg label="Range" options={RANGES} value={range} onChange={setRange} />}
          {def.filters.includes("agent") && (
            <>
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
            </>
          )}
          {def.filters.includes("account") && (
            <>
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
            </>
          )}
          {def.filters.includes("ticket") && (
            <>
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
            </>
          )}
          {tab === "cost" && (
            <span className="note">
              Token counts come from each provider's usage events. Costs marked ~ are API-equivalent
              estimates; a subscription isn't billed per token.
            </span>
          )}
          <span className="grow" />
          {def.built && <Seg label="View" options={VIEWS} value={view} onChange={setView} />}
        </div>
        <HealthBand t={bandRes.data} onNeedsRoute={setRuns} />
        <div className="tabsrow">
          <TabBar value={tab} onChange={setTab} />
          {chip && (
            <span className={`chip${chip.crit ? " crit" : ""}`} role="status">
              {chip.text}
            </span>
          )}
        </div>
        {tab === "crew" && (
          <CrewSummaryRow t={t} crew={crew} scope={scope} onNeedsRoute={setRuns} />
        )}
        {tab === "cost" && <CostSummaryRow t={t} scope={scope} onNeedsRoute={setRuns} />}
        <section
          id={TAB_PANEL_ID}
          className="tabpanel"
          role="tabpanel"
          aria-labelledby={tabId(tab)}
          aria-busy={t === undefined && res.error === null}
        >
          {!def.built && res.error && !res.data && (
            <p className="s crit-t">Could not load telemetry: {res.error.message}</p>
          )}
          {def.built ? (
            state ? (
              <div className="grid" data-state={state}>
                <StatePanel kind={state} range={range} fixed={def.fixed} onRetry={retry} />
              </div>
            ) : tab === "cost" ? (
              <CostPanels t={t} scope={scope} view={view} dim={dim} />
            ) : (
              <CrewPanels t={t} crew={crew} scope={scope} view={view} dim={dim} />
            )
          ) : (
            <ComingTab
              tab={tab as Exclude<TelemetryTab, "crew" | "cost">}
              label={def.label}
              t={t}
              scope={scope}
              live={scope.live}
              filtered={agent !== "" || account !== "" || ticket !== ""}
            />
          )}
        </section>
        <RunsDialog stat={runs} onClose={() => setRuns(null)} />
      </section>
    </ChartCursorProvider>
  );
}
