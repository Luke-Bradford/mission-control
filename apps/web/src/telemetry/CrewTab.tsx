import { type Crew, TELEMETRY_RANGES, type Telemetry } from "@mc/core";
import { useNow, useTz } from "../clock.ts";
import { useSeatName } from "../crew.ts";
import { dur, hhmm, kTokens, percent } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { NEEDS_YOU_PATH, PAGE_PATHS, type TelemetryView } from "../router.ts";
import { Subagents, ToolLatency } from "./AgentsGroup.tsx";
import { DASH, indexOf, type Scope } from "./common.ts";
import { Stat, type StatSpec } from "./Stat.tsx";

type SpanState = NonNullable<Telemetry["series"]>["stateSpans"][number]["state"];

/** The four states a lane shows. Shape carries each one, so a state never rests on colour alone. */
const STATES: { key: SpanState; label: string }[] = [
  { key: "running", label: "Running" },
  { key: "waiting", label: "Waiting" },
  { key: "parked", label: "Parked" },
  { key: "idle", label: "Idle" },
];

const MIN_MS = 60_000;
const minutes = (ms: number | null | undefined): string =>
  ms == null ? DASH : (ms / MIN_MS).toFixed(1);

/** Clock labels along a lane axis, oldest to now, at five even steps. */
function axisLabels(from: number, to: number, tz: string | null): { at: number; text: string }[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    at: f * 100,
    text: f === 1 ? "now" : tz ? hhmm(from + f * (to - from), tz) : DASH,
  }));
}

function Lanes({
  t,
  scope,
  from,
  to,
}: {
  t: Telemetry | undefined;
  scope: Scope;
  from: number;
  to: number;
}) {
  const tz = useTz();
  const spans = t?.series?.stateSpans ?? [];
  const lanes = scope.agents.map((a) => {
    const mine = spans
      .filter((s) => s.agentId === a.id && s.endedAt >= from && s.startedAt <= to)
      .sort((x, y) => x.startedAt - y.startedAt);
    return { agent: a, spans: mine, now: mine.at(-1)?.state ?? null };
  });
  const nowCount = (state: SpanState) => lanes.filter((l) => l.now === state).length;
  const width = to - from;
  if (t && !t.series)
    return (
      <p className="pb s muted">
        Timestamped crew-state history data is not available for the last {scope.range} yet.
      </p>
    );
  return (
    <div className="pbody">
      <div className="lanes-chart">
        <ul className="lanes" aria-label="Seat state lanes">
          {lanes.map(({ agent, spans: mine, now }) => (
            <li className="lane" key={agent.id}>
              <AgentTag id={agent.id} index={agent.index} sm bare />
              <div className="lane-track">
                <span className="sr-only">
                  {now ? `now ${now}` : "no observations in this range"}
                </span>
                {mine.map((s) => {
                  const left = (Math.max(s.startedAt, from) - from) / width;
                  const right = (Math.min(Math.max(s.endedAt, s.startedAt), to) - from) / width;
                  return (
                    <i
                      key={`${s.startedAt}:${s.state}`}
                      className={`span ${s.state}`}
                      title={s.state}
                      style={{
                        left: `${left * 100}%`,
                        width: `${Math.max(0.3, (right - left) * 100)}%`,
                      }}
                    />
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        <div className="lane-axis" aria-hidden="true">
          {axisLabels(from, to, tz).map((l, i, all) => (
            <span
              key={l.at}
              className={i === 0 ? "first" : i === all.length - 1 ? "last" : undefined}
              style={{ left: `${l.at}%` }}
            >
              {l.text}
            </span>
          ))}
        </div>
      </div>
      <ul className="readout" aria-label="Seats in each state now">
        {STATES.map((s) => (
          <li key={s.key}>
            <i className={`sw st ${s.key}`} aria-hidden="true" />
            <span className="nm">{s.label}</span>
            <span className="vl num">{nowCount(s.key)} now</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TIME_SHARES = [
  { key: "working", label: "Working", cls: "running" },
  { key: "waiting", label: "Waiting", cls: "waiting" },
  { key: "blocked", label: "Parked or stalled", cls: "parked" },
  { key: "idle", label: "Idle", cls: "idle" },
] as const;

function AgentTime({ t, scope }: { t: Telemetry | undefined; scope: Scope }) {
  const nameOf = useSeatName();
  const capcom = t?.capcom;
  const rows = (t?.utilisation ?? []).filter((u) => scope.agents.some((a) => a.id === u.agentId));
  const ordered = scope.agents.flatMap((a) => rows.filter((r) => r.agentId === a.id));
  return (
    <>
      <div className="pbody">
        <ul className="rows" aria-label="Agent time by seat">
          {ordered.map((r) => {
            const tip = [
              ...TIME_SHARES.map((s) => `${s.label} ${percent(r[s.key] ?? 0)}`),
              ...((r.unknown ?? 0) > 0 ? [`Unknown ${percent(r.unknown ?? 0)}`] : []),
            ].join(" · ");
            return (
              <li className="row" key={r.agentId}>
                <AgentTag id={r.agentId} index={indexOf(scope, r.agentId)} sm bare />
                <div
                  className="bar"
                  role="img"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable bar shows its shares on keyboard focus, as on hover
                  tabIndex={0}
                  data-tip={tip}
                  aria-label={`${r.agentId}: ${tip}`}
                >
                  {TIME_SHARES.filter((s) => (r[s.key] ?? 0) > 0).map((s) => (
                    <i key={s.key} className={`seg ${s.cls}`} style={{ width: `${r[s.key]}%` }} />
                  ))}
                  {(r.unknown ?? 0) > 0 && (
                    <i className="seg unknown" style={{ width: `${r.unknown}%` }} />
                  )}
                </div>
                <span className="vl num">{percent(r.working)} working</span>
              </li>
            );
          })}
        </ul>
        <ul className="readout" aria-label="Agent time shapes">
          {TIME_SHARES.map((s) => (
            <li key={s.key}>
              <i className={`sw st ${s.cls}`} aria-hidden="true" />
              <span className="nm">{s.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="pnote">
        Same shapes as Crew state. Each bar sums to 100% of the seat's day; focus a bar for its
        shares.
      </p>
      {capcom?.longest && (
        <p className="pnote">
          Longest wait today: {nameOf(capcom.longest.agentId)}'s question, {dur(capcom.longest.ms)}.
          Agent time spent waiting on you today: {dur(capcom.agentWaitMs)}.
        </p>
      )}
    </>
  );
}

/** The Crew summary row: today's crew figures, with Your response from the server's CAPCOM numbers. */
function CrewSummary({
  t,
  crew,
  scope,
  onNeedsRoute,
}: {
  t: Telemetry | undefined;
  crew: Crew | undefined;
  scope: Scope;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  const rows = crew?.rows.filter((r) => scope.agents.some((a) => a.id === r.id));
  const capcom = t?.capcom;
  const stats: StatSpec[] = [
    {
      id: "seats",
      label: "Seats running",
      value: rows
        ? `${rows.filter((r) => r.hudState === "running").length} of ${rows.length}`
        : DASH,
      unit: "seats",
      window: "now",
      definition: "Seats with a live run, of the seats configured.",
      drill: { kind: "link", href: PAGE_PATHS.overview, target: "the Overview" },
    },
    {
      id: "waiting",
      label: "Waiting on you",
      value: rows ? String(rows.filter((r) => r.hudState === "waiting").length) : DASH,
      unit: "questions",
      window: "now",
      definition: "Seats waiting for an answer.",
      drill: { kind: "link", href: NEEDS_YOU_PATH, target: "the Needs you list" },
    },
    {
      id: "median",
      label: "Median response",
      value: minutes(capcom?.medianMs),
      unit: "min",
      window: "today",
      definition: "Median time you took to answer a seat's question today.",
      drill: { kind: "needs-route", target: "the runs for each answered question" },
    },
    {
      id: "p90",
      label: "Slowest 10%",
      value: minutes(capcom?.p90Ms),
      unit: "min",
      window: "today",
      definition: "The response time that 90% of today's answers beat.",
      drill: { kind: "needs-route", target: "the slowest answered questions" },
    },
    {
      id: "stopped",
      label: "Runs you stopped",
      value: capcom ? String(capcom.stopped) : DASH,
      unit: "runs",
      window: "today",
      definition: "Runs you ended before they finished today.",
      drill: { kind: "needs-route", target: "the stopped runs" },
    },
    {
      id: "tools",
      label: "Tool calls",
      value: t ? kTokens(t.today.toolCalls) : DASH,
      unit: "calls",
      window: "today",
      definition: "Tool calls made by the seats in view today.",
      drill: { kind: "needs-route", target: "the runs with the most tool calls" },
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

export const CREW_SUMMARY_COUNT = 6;

/** The Crew tab's summary row, as the tab bar's neighbour. */
export function CrewSummaryRow(props: {
  t: Telemetry | undefined;
  crew: Crew | undefined;
  scope: Scope;
  onNeedsRoute: (s: StatSpec) => void;
}) {
  return (
    <section className="summary" aria-label="Crew summary">
      <div className="scope">
        <b>Last {props.scope.range}</b>
        <span>Range {props.scope.range}</span>
      </div>
      <CrewSummary {...props} />
    </section>
  );
}

/** The Crew tab's panels: lanes and agent time as charts, tool latency and subagents as tables. */
export function CrewPanels({
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
  const now = useNow();
  const to = now;
  const from = to - TELEMETRY_RANGES[scope.range] * MIN_MS;
  if (view === "table")
    return (
      <div className={`grid${dim ? " dim" : ""}`} data-view="table" data-n="2">
        <ToolLatency t={t} scope={scope} />
        <Subagents t={t} scope={scope} />
      </div>
    );
  return (
    <div className={`grid${dim ? " dim" : ""}`} data-view="charts" data-n="2">
      <Panel
        id="tCrewState"
        title="Crew state"
        sub={`running, waiting, parked and idle · last ${scope.range}`}
      >
        <Lanes t={t} scope={scope} from={from} to={to} />
        <p className="pnote">
          Running is solid, Waiting is hatched, Parked is dotted and Idle is an underline, so a
          state never rests on colour alone.
        </p>
      </Panel>
      <Panel id="tUtil" title="Where agent time goes" sub="share of today, per seat">
        <AgentTime t={t} scope={scope} />
      </Panel>
    </div>
  );
}
