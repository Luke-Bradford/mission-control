import {
  type BoardItem,
  type ConfigView,
  LIVE_MINUTES,
  type LimitRow,
  TELEMETRY_RANGES,
  type Telemetry,
} from "@mc/core";
import { useState } from "react";
import { ticketRef } from "../board/cards.ts";
import { useNow, useTz } from "../clock.ts";
import { RESOURCES, useResource, useResources } from "../data.ts";
import { cost, kTokens, minutesAgo, percent, plural } from "../fmt.ts";
import { AgentTag, agentColor } from "../hud/AgentTag.tsx";
import { HBar } from "../hud/charts/HBar.tsx";
import { Legend } from "../hud/charts/Hover.tsx";
import { StackedArea } from "../hud/charts/StackedArea.tsx";
import { Panel } from "../hud/Panel.tsx";
import { parseTicket, TicketRef } from "../hud/RepoRef.tsx";
import { Seg } from "../hud/Seg.tsx";
import { resetWhen } from "../quota.ts";
import { PAGE_PATHS, type TelemetryView } from "../router.ts";
import { CapacityGroup } from "./CapacityGroup.tsx";
import { DASH, indexOf, type Scope } from "./common.ts";
import {
  cacheHitPct,
  costCoverage,
  costPerMergedTicket,
  OTHER_LAYER,
  stackTokens,
} from "./costMath.ts";
import { InstrumentCharts } from "./InstrumentCharts.tsx";
import { Stat, type StatSpec } from "./Stat.tsx";
import { VisiblePanels } from "./TPanel.tsx";

const MINUTE_MS = 60_000;

/** The three loop steps, in the order they run, each with the token the mockup gives it. */
const STEP_COLORS = {
  plan: "var(--think)",
  build: "var(--accent)",
  review: "var(--ok)",
} as const;

/** "dev-2 on sonnet and dev-3", capped so the line stays one short sentence. */
function nameList(names: string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const head = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0];
  return more > 0 ? `${shown.join(", ")} and ${more} more` : (head ?? "");
}

/** What the usage rows left out, in words: the text the summary and the totals share. */
function coverageText(
  t: Telemetry | undefined,
  scope: Scope,
  kind?: "cost" | "tokens",
): string | null {
  if (!t) return null;
  const rows = t.totals.filter(
    (r) =>
      scope.agents.some((a) => a.id === r.agentId) &&
      (scope.account === "" || r.accountId === scope.account),
  );
  const c = costCoverage(rows);
  if (kind === "cost")
    return c.missingCost.length > 0
      ? `No cost reported for ${nameList(c.missingCost)}; not counted as $0.`
      : null;
  if (kind === "tokens")
    return c.missingTokens.length > 0
      ? `No tokens reported for ${nameList(c.missingTokens)}; not counted as 0.`
      : null;
  const missing = [
    c.missingCost.length > 0 &&
      `No cost reported for ${nameList(c.missingCost)}; not counted as $0.`,
    c.missingTokens.length > 0 &&
      `No tokens reported for ${nameList(c.missingTokens)}; not counted as 0.`,
  ].filter(Boolean);
  return missing.length > 0 ? missing.join(" ") : null;
}

/** The Cost and tokens summary row: today's spend and tokens, cost per merged ticket, and coverage. */
function CostSummary({
  t,
  scope,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const rows = (t?.totals ?? []).filter(
    (r) =>
      scope.agents.some((a) => a.id === r.agentId) &&
      (scope.account === "" || r.accountId === scope.account),
  );
  const cover = costCoverage(rows);
  const hit = t ? cacheHitPct(t.today) : null;
  const perTicket = t ? costPerMergedTicket(t.tokensByTicket) : null;
  const costDetail = coverageText(t, scope, "cost") ?? undefined;
  const tokensDetail = coverageText(t, scope, "tokens") ?? undefined;
  const stats: StatSpec[] = [
    {
      id: "cost",
      label: "~Cost",
      value: t ? cost(t.today.costUsd) : DASH,
      unit: "USD",
      window: "today",
      definition:
        "API-equivalent estimate of today's spend. A subscription is not billed per token. A dash means no run reported a cost; it is not $0.",
      drill: { kind: "needs-route", target: "the runs that make up today's cost" },
    },
    {
      id: "tokens",
      label: "Tokens",
      value: t ? kTokens(t.today.tokens) : DASH,
      unit: "in + out",
      window: "today",
      definition: "Input plus output tokens today. Cache reads are counted separately.",
      drill: { kind: "needs-route", target: "the runs that make up today's tokens" },
    },
    {
      id: "cache",
      label: "Cache hit",
      value: hit === null ? DASH : percent(hit).replace("%", ""),
      unit: "% of input",
      window: "today",
      definition: "Share of input tokens served from cache, today.",
      drill: { kind: "needs-route", target: "the runs with the lowest cache hit" },
    },
    {
      id: "perticket",
      label: "~Cost per merged ticket",
      value: perTicket === null ? DASH : cost(perTicket),
      unit: "USD",
      window: scope.range,
      definition: `API-equivalent cost of every run on a ticket, averaged over the tickets merged in the last ${scope.range}. A merged ticket with no reported cost is left out, not counted as $0.`,
      drill: { kind: "link", href: PAGE_PATHS.board, target: "the Board" },
    },
    {
      id: "ccover",
      label: "Cost coverage",
      value: cover.costPct === null ? DASH : String(Math.round(cover.costPct)),
      unit: "% of usage rows",
      window: scope.range,
      definition:
        "Seat and model rows that reported a cost, of all rows in the range. Mission Control does not count runs here yet.",
      detail: costDetail,
      drill: { kind: "needs-route", target: "the rows that reported no cost" },
    },
    {
      id: "tcover",
      label: "Tokens coverage",
      value: cover.tokensPct === null ? DASH : String(Math.round(cover.tokensPct)),
      unit: "% of usage rows",
      window: scope.range,
      definition:
        "Seat and model rows that reported tokens, of all rows in the range. Mission Control does not count runs here yet.",
      detail: tokensDetail,
      drill: { kind: "needs-route", target: "the rows that reported no tokens" },
    },
  ];
  return (
    <>
      {stats.map((s) => (
        <Stat key={s.id} stat={s} onNeedsRoute={onNeedsRoute} />
      ))}
    </>
  );
}

export const COST_SUMMARY_COUNT = 6;

/** The Cost and tokens summary row, as the tab bar's neighbour. */
export function CostSummaryRow(props: {
  t: Telemetry | undefined;
  scope: Scope;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  return (
    <section className="summary" aria-label="Cost and tokens summary">
      <div className="scope">
        <b>Last {props.scope.range}</b>
        <span>Range {props.scope.range}</span>
      </div>
      <CostSummary {...props} />
    </section>
  );
}

function Wait({ scope }: { scope: Scope }) {
  return <p className="pb s muted">{scope.wait}</p>;
}

/** Spend by loop step: one bar per step, plus what the hub does not keep (an hourly series). */
function SpendByStep({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const steps = t?.tokensByStep;
  const spent = (steps ?? []).reduce((a, s) => a + (s.costUsd ?? 0), 0);
  const withCost = (steps ?? []).filter((s) => s.costUsd !== null);
  const total = withCost.length > 0 ? spent : null;
  const most = Math.max(1, ...(steps ?? []).map((s) => s.tokens));
  return (
    <Panel id="tStepBars" title="Spend by step" sub={`~USD, API-equivalent · last ${scope.range}`}>
      {!t ? (
        <Wait scope={scope} />
      ) : steps === undefined ? (
        <p className="pb s muted">Spend by step is not tracked yet.</p>
      ) : (
        <>
          <div className="pb">
            <div
              className="spend-stack"
              role="img"
              aria-label={`Spend by step: ${steps.map((s) => `${s.step} ${cost(s.costUsd)}`).join(", ")}`}
            >
              {withCost
                .filter((s) => (s.costUsd ?? 0) > 0)
                .map((s) => (
                  <i
                    key={s.step}
                    style={{
                      width: `${((s.costUsd ?? 0) / Math.max(spent, 0.0001)) * 100}%`,
                      background: STEP_COLORS[s.step],
                    }}
                    title={`${s.step}: ${cost(s.costUsd)}`}
                  />
                ))}
            </div>
            {steps.map((r) => (
              <HBar
                key={r.step}
                label={
                  <>
                    <i className="step-sw" style={{ background: STEP_COLORS[r.step] }} />
                    {r.step}
                  </>
                }
                title={`${r.step}: ${cost(r.costUsd)}, ${kTokens(r.tokens)} tokens, ${plural(r.runs, "run")}`}
                pct={(r.tokens / most) * 100}
                value={cost(r.costUsd)}
                extra={`${kTokens(r.tokens)} · ${plural(r.runs, "run")}`}
              />
            ))}
            <p className="s">
              <span className="muted">Total </span>
              <span className="num">{cost(total)}</span>
            </p>
          </div>
          <p className="pnote">
            Spend per hour by step is not tracked yet, so the bars show the whole range. A step with
            no reported cost shows a dash; it is not counted as $0.
          </p>
        </>
      )}
    </Panel>
  );
}

/** Cost by ticket: ranked bars, the full title on hover and on keyboard focus. */
function CostByTicket({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const rows = [...(t?.tokensByTicket ?? [])].sort(
    (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens,
  );
  const titles = useTicketTitles(rows.map((r) => r.ticket));
  const most = Math.max(0.0001, ...rows.map((r) => r.costUsd ?? 0));
  return (
    <Panel id="tTicketBars" title="Cost by ticket" sub={`~USD, ranked · last ${scope.range}`}>
      {!t ? (
        <Wait scope={scope} />
      ) : rows.length === 0 ? (
        <p className="pb s muted">No ticket work in the last {scope.range}.</p>
      ) : (
        <>
          <section
            className="pb ticket-bars"
            aria-label="Ticket cost"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the complete ticket list
            tabIndex={0}
          >
            {rows.map((r) => {
              const title = titles.get(r.ticket);
              const full = `${r.ticket}${title ? ` · ${title}` : ""}`;
              return (
                <HBar
                  key={r.ticket}
                  label={
                    <span
                      className="ticket-label"
                      data-tip={full}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the full title, as hover does
                      tabIndex={0}
                    >
                      <TicketRef ticket={r.ticket} />
                      {title && <span className="ticket-bar-title">{title}</span>}
                    </span>
                  }
                  pct={((r.costUsd ?? 0) / most) * 100}
                  value={cost(r.costUsd)}
                  extra={`${kTokens(r.tokens)} tok`}
                  title={`${full}: ${cost(r.costUsd)}, ${kTokens(r.tokens)} tokens`}
                />
              );
            })}
          </section>
          <p className="pnote">
            Every run on the ticket counts: plan, build and review. Hover or focus a title for the
            full text.
          </p>
        </>
      )}
    </Panel>
  );
}

/** Titles of the tickets in view, from the boards of the repos they belong to. */
function useTicketTitles(tickets: string[]): Map<string, string> {
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const repos = new Set(tickets.flatMap((r) => parseTicket(r)?.repoId ?? []));
  const ids = (config?.repos ?? []).filter((r) => repos.has(r.id)).map((r) => r.id);
  const boards = useResources<BoardItem[]>(ids.map(RESOURCES.boards));
  return new Map(boards.flatMap((b) => (b.data ?? []).map((i) => [ticketRef(i), i.title])));
}

type TokMode = "live" | "hist";
const TOK_MODES = [
  { value: "live", label: "Live" },
  { value: "hist", label: "History" },
] as const;

/** Tokens per minute: the three busiest seats and Other, stacked, so the layers sum to the total. */
function TokensPerMinute({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const [mode, setMode] = useState<TokMode>("live");
  const live = mode === "live";
  const span = live ? `${LIVE_MINUTES} minutes` : scope.range;
  const rows = (live ? t?.liveMinutes : t?.tokensPerMinute) ?? [];
  const inView = scope.agents.flatMap((a) => rows.filter((r) => r.agentId === a.id));
  const layers = stackTokens(inView);
  const series = layers.map((l) => ({
    id: l.id,
    name: l.name,
    color: l.id === OTHER_LAYER ? "var(--muted)" : agentColor(indexOf(scope, l.id)),
    values: l.values,
  }));
  const n = series[0]?.values.length ?? 0;
  const rangeMin = TELEMETRY_RANGES[scope.range];
  const now = useNow();
  const times = Array.from(
    { length: n },
    (_, i) => now - (live ? LIVE_MINUTES : rangeMin) * MINUTE_MS * (1 - i / Math.max(1, n - 1)),
  );
  const any = series.some((s) => s.values.some((v) => v > 0));
  return (
    <Panel
      id="tTok"
      title="Tokens per minute"
      sub={`${live ? `live · last ${LIVE_MINUTES} minutes` : `history · last ${scope.range}`} · top 3 seats and other`}
      actions={
        <Seg label="Tokens per minute" options={TOK_MODES} value={mode} onChange={setMode} />
      }
    >
      {!t ? (
        <Wait scope={scope} />
      ) : !any ? (
        <p className="pb s muted">No tokens in the last {span}.</p>
      ) : (
        <>
          <div className="pb">
            <StackedArea
              series={series}
              label={`Tokens per minute, last ${span}`}
              xLabels={live ? [`${LIVE_MINUTES} min ago`, "now"] : [`-${scope.range}`, "now"]}
              at={(i, count) => minutesAgo(live ? count - 1 - i : rangeMin * (1 - i / (count - 1)))}
              format={kTokens}
              live={scope.live}
              times={times}
              height={140}
            />
            <Legend items={series.map((s) => ({ key: s.id, name: s.name, color: s.color }))} />
          </div>
          <p className="pnote">
            Layers stack to the total. Tokens are input plus output, as each provider reports them.
          </p>
        </>
      )}
    </Panel>
  );
}

/** A quota window's small 24 h line, as a path in a 100 x 100 box. */
function historyPath(points: { at: number; pct: number }[], from: number, to: number): string {
  return points
    .filter((p) => p.at >= from)
    .map((p, i) => {
      const x = ((p.at - from) / Math.max(1, to - from)) * 100;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${(100 - Math.min(100, p.pct)).toFixed(1)}`;
    })
    .join("");
}

const DAY_MS = 24 * 60 * MINUTE_MS;

/** One quota window as a meter shows it: the live reading where the hub has one, else the last sample. */
interface QuotaMeterRow {
  key: string;
  name: string;
  used: number;
  alertAt: number | null;
  stopAt: number | null;
  limit: LimitRow | null;
  points: { at: number; pct: number }[];
}

function quotaRows(
  limits: LimitRow[],
  history: { accountId: string; window: "5h" | "7d"; points: { at: number; pct: number }[] }[],
  account: string,
): QuotaMeterRow[] {
  const keyOf = (a: string, w: string) => `${a} ${w}`;
  const byKey = new Map<string, QuotaMeterRow>();
  for (const h of history) {
    const last = h.points.at(-1);
    if (!last) continue;
    const alertAt = "alertAt" in h ? (h as { alertAt: number }).alertAt : null;
    const stopAt = "stopAt" in h ? (h as { stopAt: number }).stopAt : null;
    byKey.set(keyOf(h.accountId, h.window), {
      key: keyOf(h.accountId, h.window),
      name: keyOf(h.accountId, h.window),
      used: last.pct,
      alertAt,
      stopAt,
      limit: null,
      points: h.points,
    });
  }
  for (const l of limits) {
    const key = keyOf(l.accountId, l.window);
    byKey.set(key, {
      key,
      name: key,
      used: l.used,
      alertAt: l.alertAt,
      stopAt: l.stopAt,
      limit: l,
      points: byKey.get(key)?.points ?? [],
    });
  }
  return [...byKey.values()]
    .filter((r) => account === "" || r.key.startsWith(`${account} `))
    .sort((a, b) => b.used - a.used);
}

/** Quota used: a meter per account window, with the alert and stop levels ticked and a 24 h line. */
function QuotaUsed({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const limits = useResource<LimitRow[]>(RESOURCES.limits).data ?? [];
  const tz = useTz();
  const now = useNow();
  const rows = quotaRows(limits, t?.series?.quota ?? t?.quota ?? [], scope.account);
  return (
    <Panel id="tQuotaUsed" title="Quota used" sub="each account window · 24 h line">
      {!t ? (
        <Wait scope={scope} />
      ) : rows.length === 0 ? (
        <p className="pb s muted">No quota readings in the last {scope.range}.</p>
      ) : (
        <>
          <ul className="pb quota-meters" aria-label="Quota used by window">
            {rows.map((r) => {
              const level =
                r.stopAt !== null && r.used >= r.stopAt
                  ? "stop"
                  : r.alertAt !== null && r.used >= r.alertAt
                    ? "alert"
                    : "ok";
              const d = historyPath(r.points, now - DAY_MS, now);
              const levels =
                r.alertAt !== null && r.stopAt !== null
                  ? `; alert at ${percent(r.alertAt)}, stop at ${percent(r.stopAt)}`
                  : "";
              const reset = r.limit && tz ? resetWhen(r.limit, now, tz) : DASH;
              return (
                <li key={r.key} className="quota-row" data-level={level}>
                  <span className="lb" title={r.name}>
                    {r.name}
                  </span>
                  <div
                    className="tr"
                    role="img"
                    aria-label={`${r.name}: ${percent(r.used)} used${levels}`}
                  >
                    <i style={{ width: `${Math.min(100, r.used)}%` }} />
                    {r.alertAt !== null && (
                      <span className="tick" style={{ left: `${r.alertAt}%` }} aria-hidden="true" />
                    )}
                    {r.stopAt !== null && (
                      <span
                        className="tick stop"
                        style={{ left: `${r.stopAt}%` }}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <svg
                    className="hist"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    {d && (
                      <path d={d} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                    )}
                  </svg>
                  <span className="vl num">
                    {percent(r.used)} used · {reset}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="pnote">
            Ticks mark the alert and stop levels. The small line is the last 24 h.
          </p>
        </>
      )}
    </Panel>
  );
}

/** Totals: every seat and model in the range. */
function Totals({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const totals = (t?.totals ?? []).filter(
    (r) =>
      scope.agents.some((a) => a.id === r.agentId) &&
      (scope.account === "" || r.accountId === scope.account),
  );
  const missing = coverageText(t, scope);
  return (
    <Panel id="tTotals" title="Totals" sub={`per seat and model · last ${scope.range}`}>
      {!t ? (
        <Wait scope={scope} />
      ) : totals.length === 0 ? (
        <p className="pb s muted">No usage for this filter in the last {scope.range}.</p>
      ) : (
        <>
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
                      {r.cacheHitPct === null ? DASH : percent(r.cacheHitPct)}
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
          {missing && <p className="pnote">{missing}</p>}
        </>
      )}
    </Panel>
  );
}

/** The table view's ticket list: every ticket with its cost and tokens, costliest first. */
function CostTable({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const rows = [...(t?.tokensByTicket ?? [])].sort(
    (a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens,
  );
  const titles = useTicketTitles(rows.map((r) => r.ticket));
  return (
    <Panel id="tCostTable" title="Cost by ticket" sub={`~USD, ranked · last ${scope.range}`}>
      {!t ? (
        <Wait scope={scope} />
      ) : rows.length === 0 ? (
        <p className="pb s muted">No ticket work in the last {scope.range}.</p>
      ) : (
        <div className="pb tw">
          <table>
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Title</th>
                <th className="r">Tokens</th>
                <th className="r">~Cost</th>
                <th className="r">~Full cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticket}>
                  <td>
                    <TicketRef ticket={r.ticket} />
                  </td>
                  <td className="wrap fg2">{titles.get(r.ticket) ?? DASH}</td>
                  <td className="r num">{kTokens(r.tokens)}</td>
                  <td className="r num">{cost(r.costUsd)}</td>
                  <td className="r num muted">{cost(r.totalCostUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** Tokens and cost by loop step, as a table. */
function StepTable({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const steps = t?.tokensByStep;
  return (
    <Panel id="tStepTable" title="Tokens by loop step" sub="repeats cost more">
      {!t ? (
        <Wait scope={scope} />
      ) : steps === undefined ? (
        <p className="pb s muted">Not tracked yet.</p>
      ) : (
        <div className="pb tw">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th className="r">Tokens</th>
                <th className="r">Runs</th>
                <th className="r">~Cost</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((r) => (
                <tr key={r.step}>
                  <td>{r.step}</td>
                  <td className="r num">{kTokens(r.tokens)}</td>
                  <td className="r num">{r.runs}</td>
                  <td className="r num muted">{cost(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The panels the earlier page held that the table view keeps whole: the allowance reader and the two history charts. */
const QUOTA_HISTORY = new Set(["quotaP", "tQuota"]);
const MERGED_COST = new Set(["tCostMerged"]);

/** The Cost and tokens panels: four charts, or the tables and the longer histories behind them. */
export function CostPanels({
  t,
  scope,
  view,
  dim,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  view: TelemetryView;
  dim: boolean;
}) {
  if (view === "table")
    return (
      <div className={`grid cost-tables${dim ? " dim" : ""}`} data-view="table" data-cost="tables">
        <Totals t={t} scope={scope} />
        <CostTable t={t} scope={scope} />
        <StepTable t={t} scope={scope} />
        <VisiblePanels.Provider value={QUOTA_HISTORY}>
          <CapacityGroup t={t} scope={scope} />
        </VisiblePanels.Provider>
        <VisiblePanels.Provider value={MERGED_COST}>
          <InstrumentCharts scope={scope} series={t?.series} ticketCosts={t?.tokensByTicket} />
        </VisiblePanels.Provider>
      </div>
    );
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="charts" data-n="4">
      <SpendByStep t={t} scope={scope} />
      <CostByTicket t={t} scope={scope} />
      <TokensPerMinute t={t} scope={scope} />
      <QuotaUsed t={t} scope={scope} />
    </div>
  );
}
