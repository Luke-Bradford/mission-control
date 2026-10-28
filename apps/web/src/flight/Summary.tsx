import {
  type ConfigView,
  FLIGHT_LEDGER_REF,
  FLIGHT_SUMMARY_LISTED,
  type FlightLedgerEntry,
  type FlightLedgerView,
  type FlightScheduleEntry,
  type FlightScheduleView,
  type FlightSummaryItem,
  type FlightSummaryOutcome,
  type FlightSummaryView,
} from "@mc/core";
import type { ReactNode } from "react";
import { useSecond, useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { dayMonth, dur, hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { metricText, metricTitle, useMetrics } from "../metrics.ts";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";

const DASH = "—";
export const SUMMARY_EMPTY = "FLIGHT has not written a commander's intent yet.";
export const OUTCOME_NOT_RECORDED = "Outcome not recorded";

type SummaryMode = "queue" | "record";

function Timestamp({ at }: { at: number | null }) {
  const tz = useTz();
  return at === null || tz === null ? (
    <span>{DASH}</span>
  ) : (
    <time dateTime={new Date(at).toISOString()}>
      {dayMonth(at, tz)} {hhmm(at, tz)}
    </time>
  );
}

function RefLink({ value, repoId }: { value: string; repoId?: string }) {
  if (repoId && FLIGHT_LEDGER_REF.test(value)) {
    return (
      <RepoRef
        repoId={repoId}
        number={Number(value.slice(value.indexOf("#") + 1))}
        kind={value.startsWith("PR ") ? "pr" : "issue"}
        bare
      />
    );
  }
  return <ExternalLink url={value}>{value}</ExternalLink>;
}

function Refs({ refs, repoId }: { refs: readonly string[]; repoId?: string }) {
  if (refs.length === 0) return <>{DASH}</>;
  return refs.map((ref) => <RefLink key={ref} value={ref} repoId={repoId} />);
}

function horizon(
  item: FlightSummaryItem | FlightLedgerEntry,
  now: number,
): { label: string; tone: "crit" | "plain" } {
  // Health carries blocked/waiting colour; the horizon is a plain time bucket unless overdue.
  if (item.status === "blocked" || item.status === "waiting") {
    return { label: "Waiting", tone: "plain" };
  }
  if (item.kind === "watch") return { label: "Watch", tone: "plain" };
  if (item.due === null) return { label: "Next", tone: "plain" };
  if (item.due <= now) return { label: "Overdue", tone: "crit" };
  if (item.due - now <= 24 * 60 * 60_000) return { label: "Today", tone: "plain" };
  if (item.due - now <= 7 * 24 * 60 * 60_000) return { label: "This week", tone: "plain" };
  return { label: "Later", tone: "plain" };
}

function health(
  item: FlightSummaryItem | FlightLedgerEntry,
  now: number,
): { label: string; tone: "crit" | "warn" | "ok" | "plain" } {
  if (item.status === "blocked") return { label: "Blocked", tone: "crit" };
  if (item.status === "waiting") return { label: "Waiting", tone: "warn" };
  if (item.due !== null && item.due <= now) return { label: "Late", tone: "crit" };
  if (item.kind === "watch") return { label: "Watching", tone: "plain" };
  if (item.kind === "plan") return { label: "Scheduled", tone: "plain" };
  return { label: "Ready", tone: "ok" };
}

function PlanRow({
  item,
  entry,
  plan,
  repoId,
  now,
}: {
  item: FlightSummaryItem | FlightLedgerEntry;
  entry?: FlightLedgerEntry;
  plan?: FlightScheduleEntry;
  repoId?: string;
  now: number;
}) {
  const refs = entry?.refs ?? (plan?.target ? [plan.target] : []);
  const lane = horizon(item, now);
  const state = health(item, now);
  const updatedAt = entry?.updatedAt ?? plan?.createdAt ?? null;
  const age = updatedAt === null ? null : Math.max(0, now - updatedAt);
  return (
    <tr className="flight-plan-row">
      <td className={`flight-plan-horizon${lane.tone === "crit" ? " crit-t" : ""}`}>
        {lane.label}
      </td>
      <td className="flight-plan-work">
        <b>{item.title}</b>
        <span className="flight-plan-refs s">
          <Refs refs={refs} repoId={repoId} />
        </span>
      </td>
      <td className="flight-plan-health">
        <Pill tone={state.tone}>{state.label}</Pill>
      </td>
      <td className="flight-plan-owner">
        {entry?.owner ? <AgentTag id={entry.owner} index={0} bare sm /> : DASH}
      </td>
      <td className="flight-plan-next">
        {item.next ?? <span className="flight-gap">Next action not recorded</span>}
      </td>
      <td className="flight-plan-checkpoint">
        {entry?.waitsOn && <span>Waiting on {entry.waitsOn}</span>}
        {item.due !== null && (
          <span>
            Checkpoint <Timestamp at={item.due} />
          </span>
        )}
        {!entry?.waitsOn && item.due === null && <span className="flight-gap">No checkpoint</span>}
      </td>
      <td className="flight-plan-age num">{age === null ? DASH : dur(age)}</td>
    </tr>
  );
}

/** A closed outcome, entirely from the summary: its result is never stood in for by `next`. */
function OutcomeRow({ item, repoId }: { item: FlightSummaryOutcome; repoId?: string }) {
  return (
    <tr className="flight-outcome-row">
      <td>
        <b>{item.title}</b>
        <span className="flight-refs s">
          <Refs refs={item.refs ?? []} repoId={repoId} />
        </span>
      </td>
      <td>{item.outcome || <span className="flight-gap">{OUTCOME_NOT_RECORDED}</span>}</td>
      <td className="fg2">{item.basis || DASH}</td>
      <td className="flight-outcome-at num">
        <Timestamp at={item.closedAt ?? null} />
      </td>
    </tr>
  );
}

function OutcomeTable({ children }: { children: ReactNode }) {
  return (
    <table className="flight-outcome-table" aria-label="Recently done">
      <thead>
        <tr className="flight-outcome-head">
          <th scope="col">Outcome</th>
          <th scope="col">Result</th>
          <th scope="col">Basis</th>
          <th scope="col">Closed</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <table className="flight-plan-table" aria-label={label}>
      <thead>
        <tr className="flight-plan-head">
          <th scope="col">Horizon</th>
          <th scope="col">Workstream</th>
          <th scope="col">Health</th>
          <th scope="col">Owner</th>
          <th scope="col">Next action</th>
          <th scope="col">Dependency / checkpoint</th>
          <th scope="col">Age</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * Plan's forward table (`queue`) or Record's outcomes and scorecard (`record`). Summary order and
 * counts come from the hub; in Plan the open ledger supplies each line's details, while Record's
 * outcomes carry their own result, refs, basis and close time.
 */
export function Summary({ mode }: { mode: SummaryMode }) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const ledger = useResource<FlightLedgerView>(
    mode === "queue" ? RESOURCES.flightLedgerOpen : null,
  );
  const schedule = useResource<FlightScheduleView>(
    mode === "queue" ? RESOURCES.flightSchedule : null,
  );
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const now = useSecond();
  const metrics = useMetrics();
  const costReading = metrics.readings.cost;
  const costText = { label: metricText("cost").label, title: metricTitle(metrics, "cost") };
  const view = summary.data;
  const entries = ledger.data?.session === view?.session ? (ledger.data?.entries ?? []) : [];
  // A server that predates summary.done has no outcomes to show: Record says none are recorded.
  const recentlyDone = view?.done ?? [];
  // Structured watches have their canonical, actionable presentation in Revisit triggers.
  const plans = schedule.data?.session === view?.session ? (schedule.data?.entries ?? []) : [];
  const repoId = config?.crew?.sessions.find((s) => s.id === view?.session)?.repoId;
  const listed = FLIGHT_SUMMARY_LISTED;
  const row = (item: FlightSummaryItem | FlightLedgerEntry) =>
    !ledger.data && !ledger.error ? (
      <tr key={`${item.kind}:${item.key}`} className="flight-plan-row">
        <td colSpan={7}>{DASH}</td>
      </tr>
    ) : (
      <PlanRow
        key={`${item.kind}:${item.key}`}
        item={item}
        entry={entries.find((e) => e.kind === item.kind && e.key === item.key)}
        plan={item.kind === "plan" ? plans.find((p) => p.id === item.key) : undefined}
        repoId={repoId}
        now={now}
      />
    );
  const queueEntries = entries.filter(
    (entry) =>
      entry.kind === "watch" ||
      entry.kind === "commitment" ||
      (entry.kind === "work" && entry.status === "waiting"),
  );
  const queueItems: (FlightLedgerEntry | FlightSummaryItem)[] = [
    ...queueEntries,
    ...plans.map((plan) => ({
      key: plan.id,
      kind: "plan" as const,
      title: plan.label,
      status: plan.status,
      next: plan.detail ?? null,
      due: plan.dueAt,
      priority: null,
      ageMin: Math.floor((now - plan.createdAt) / 60_000),
    })),
  ].sort((a, b) => {
    const aRank = a.status === "blocked" ? 0 : a.status === "waiting" ? 1 : (a.due ?? Infinity);
    const bRank = b.status === "blocked" ? 0 : b.status === "waiting" ? 1 : (b.due ?? Infinity);
    return aRank - bRank || a.title.localeCompare(b.title);
  });
  return (
    <div className={`flight-summary ${mode}`}>
      {summary.error && (
        <p role="alert" className="note err">
          {summary.error.message}
        </p>
      )}
      {!view ? (
        <p className="sittext note">{DASH}</p>
      ) : view.session === null ? (
        <p className="sittext note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <>
          {mode === "queue" && ledger.error && (
            <p role="alert" className="note err">
              Ledger: {ledger.error.message}
            </p>
          )}
          {mode === "queue" && (
            <section aria-labelledby="flight-plan-title">
              <div className="flight-plan-intro">
                <h3 id="flight-plan-title">FLIGHT's forward plan</h3>
                <p>
                  Ordered commitments, unresolved dependencies and deliberate watches. Active
                  execution stays on Command.
                </p>
                <span className="flight-plan-count">
                  {queueItems.length} tracked ·{" "}
                  {
                    queueItems.filter(
                      (item) => item.status === "blocked" || item.status === "waiting",
                    ).length
                  }{" "}
                  waiting
                </span>
              </div>
              {schedule.error && (
                <p role="alert" className="note err">
                  Schedule: {schedule.error.message}
                </p>
              )}
              {queueItems.length ? (
                <Table label="FLIGHT forward plan">{queueItems.map((item) => row(item))}</Table>
              ) : (
                <p className="pb note">
                  No forward commitment, dependency or watch is recorded. FLIGHT records them with
                  its ledger as it accepts work.
                </p>
              )}
            </section>
          )}
          {mode === "record" && (
            <>
              <section aria-label="Last 24 hours">
                {/* Merged and Review / CI live on Command's pulse rail; cost is the registry's. */}
                <dl className="flight-tiles">
                  <div>
                    <dt>CI failures</dt>
                    <dd>{view.metrics.ciFailures}</dd>
                  </div>
                  <div>
                    <dt>Parks</dt>
                    <dd>{view.metrics.parks.day}</dd>
                  </div>
                  <div title={costText.title}>
                    <dt>{costText.label}</dt>
                    <dd data-metric="cost">{costReading?.value ?? "—"}</dd>
                  </div>
                </dl>
              </section>
              <section className="flight-lane done" aria-labelledby="flight-summary-done">
                <h3 id="flight-summary-done" className="flight-subhead">
                  Recently done
                </h3>
                {recentlyDone.length ? (
                  <OutcomeTable>
                    {recentlyDone.slice(0, listed).map((item) => (
                      <OutcomeRow key={`${item.kind}:${item.key}`} item={item} repoId={repoId} />
                    ))}
                  </OutcomeTable>
                ) : (
                  <p className="pb note">No recent outcomes recorded.</p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
