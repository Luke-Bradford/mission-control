import {
  type ConfigView,
  FLIGHT_LEDGER_REF,
  FLIGHT_SUMMARY_LISTED,
  type FlightLedgerEntry,
  type FlightLedgerView,
  type FlightScheduleEntry,
  type FlightScheduleView,
  type FlightSummaryItem,
  type FlightSummaryView,
} from "@mc/core";
import type { ReactNode } from "react";
import { useSecond, useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dayMonth, dur, hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";

const DASH = "—";
export const SUMMARY_EMPTY = "FLIGHT has not written a commander's intent yet.";

type SummaryMode = "command" | "queue" | "record";

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
): { label: string; tone: "crit" | "warn" | "plain" } {
  if (item.status === "blocked" || item.status === "waiting") {
    return { label: "Waiting", tone: item.status === "blocked" ? "crit" : "warn" };
  }
  if (item.kind === "watch") return { label: "Watch", tone: "plain" };
  if (item.due === null) return { label: "Next", tone: "plain" };
  if (item.due <= now) return { label: "Overdue", tone: "crit" };
  if (item.due - now <= 24 * 60 * 60_000) return { label: "Today", tone: "warn" };
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
    <li className="flight-plan-row">
      <span className="flight-plan-horizon">
        <Pill tone={lane.tone}>{lane.label}</Pill>
      </span>
      <span className="flight-plan-work">
        <b>{item.title}</b>
        <span className="flight-plan-refs s">
          <Refs refs={refs} repoId={repoId} />
        </span>
      </span>
      <span className="flight-plan-health">
        <Pill tone={state.tone}>{state.label}</Pill>
      </span>
      <span className="flight-plan-owner">
        {entry?.owner ? <AgentTag id={entry.owner} index={0} bare sm /> : DASH}
      </span>
      <span className="flight-plan-next">{item.next ?? "Next action not recorded"}</span>
      <span className="flight-plan-checkpoint">
        {entry?.waitsOn && <span>Waiting on {entry.waitsOn}</span>}
        {item.due !== null && (
          <span>
            Checkpoint <Timestamp at={item.due} />
          </span>
        )}
        {!entry?.waitsOn && item.due === null && <span className="warn-t">No checkpoint</span>}
      </span>
      <span className="flight-plan-age s num">{age === null ? DASH : dur(age)}</span>
    </li>
  );
}

function OutcomeRow({
  item,
  entry,
  repoId,
}: {
  item: FlightSummaryItem | FlightLedgerEntry;
  entry?: FlightLedgerEntry;
  repoId?: string;
}) {
  return (
    <li className="flight-outcome-row">
      <span>
        <b>{item.title}</b>
        <span className="flight-refs s">
          <Refs refs={entry?.refs ?? []} repoId={repoId} />
        </span>
      </span>
      <span>{entry?.outcome ?? item.next ?? "Outcome not recorded"}</span>
      <span className="fg2">{entry?.basis || DASH}</span>
      <span className="s num">
        <Timestamp at={entry?.updatedAt ?? null} />
      </span>
    </li>
  );
}

function Table({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flight-plan-table">
      <div className="flight-plan-head" aria-hidden="true">
        <span>Horizon</span>
        <span>Workstream</span>
        <span>Health</span>
        <span>Owner</span>
        <span>Next action</span>
        <span>Dependency / checkpoint</span>
        <span>Age</span>
      </div>
      <ol className="flight-plan-list" aria-label={label}>
        {children}
      </ol>
    </div>
  );
}

/** Summary order and counts come from the hub; the ledger supplies each line's details. */
export function Summary({ mode, onOpenQueue }: { mode: SummaryMode; onOpenQueue?: () => void }) {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen);
  const fullLedger = useResource<FlightLedgerView>(
    mode === "record" ? RESOURCES.flightLedger : null,
  );
  const schedule = useResource<FlightScheduleView>(RESOURCES.flightSchedule);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const now = useSecond();
  const view = summary.data;
  const entries = ledger.data?.session === view?.session ? (ledger.data?.entries ?? []) : [];
  const fullEntries =
    fullLedger.data?.session === view?.session ? (fullLedger.data?.entries ?? []) : [];
  // Auto-updated assets can briefly run against a server that predates summary.done. Derive the
  // same live outcomes from its full ledger, while arrivals keep their canonical place in Queue.
  const fallbackDone = fullEntries
    .filter((item) => item.status === "done")
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  const recentlyDone = (view?.done ?? fallbackDone).filter((item) => item.kind !== "incoming");
  // Structured watches have their canonical, actionable presentation in Revisit triggers.
  const plans = schedule.data?.session === view?.session ? (schedule.data?.entries ?? []) : [];
  const repoId = config?.crew?.sessions.find((s) => s.id === view?.session)?.repoId;
  const listed = FLIGHT_SUMMARY_LISTED;
  const row = (item: FlightSummaryItem | FlightLedgerEntry) =>
    !ledger.data && !ledger.error ? (
      <li key={`${item.kind}:${item.key}`}>{DASH}</li>
    ) : (
      <PlanRow
        key={`${item.kind}:${item.key}`}
        item={item}
        entry={[...entries, ...fullEntries].find((e) => e.kind === item.kind && e.key === item.key)}
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
          {mode === "command" && (
            <div className="flight-summary-head">
              <div>
                <p className="flight-source">FLIGHT · COMMANDER'S INTENT</p>
                <p className="sittext">{view.headline || SUMMARY_EMPTY}</p>
                <p className="s fg2 flight-headline-age">
                  Explicit FLIGHT synthesis ·{" "}
                  {view.headlineAgeMin === null
                    ? "not updated yet"
                    : view.headlineAgeMin === 0
                      ? "updated now"
                      : `updated ${dur(view.headlineAgeMin * 60_000)} ago`}
                  {view.headlineAgeMin !== null && view.headlineAgeMin >= 60 && (
                    <Pill tone="warn">stale</Pill>
                  )}
                </p>
              </div>
              {onOpenQueue && (
                <button type="button" className="sm ghost" onClick={onOpenQueue}>
                  Open plan
                </button>
              )}
            </div>
          )}
          {mode === "queue" && ledger.error && (
            <p role="alert" className="note err">
              Ledger: {ledger.error.message}
            </p>
          )}
          {mode === "queue" && (
            <section aria-labelledby="flight-plan-title">
              <div className="flight-plan-intro">
                <div>
                  <h3 id="flight-plan-title">FLIGHT's forward plan</h3>
                  <p className="s fg2">
                    Ordered commitments, unresolved dependencies and deliberate watches. Active
                    execution remains on Command.
                  </p>
                </div>
                <span className="s fg2">
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
                <p className="note">No forward commitment, dependency or watch is recorded.</p>
              )}
            </section>
          )}
          {mode === "record" && (
            <>
              {fullLedger.error && view.done === undefined && (
                <p role="alert" className="note err">
                  Outcomes: {fullLedger.error.message}
                </p>
              )}
              <section className="flight-lane done" aria-labelledby="flight-summary-done">
                <h3 id="flight-summary-done">Recently done</h3>
                {recentlyDone.length ? (
                  <ul className="flight-outcome-list" aria-label="Recently done">
                    {recentlyDone.slice(0, listed).map((item) => {
                      const entry = [...entries, ...fullEntries].find(
                        (candidate) => candidate.kind === item.kind && candidate.key === item.key,
                      );
                      return (
                        <OutcomeRow
                          key={`${item.kind}:${item.key}`}
                          item={item}
                          entry={entry}
                          repoId={repoId}
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p className="note">No recent outcomes recorded.</p>
                )}
              </section>
              <section aria-label="Last 24 hours">
                <dl className="flight-tiles">
                  <div>
                    <dt>Merged (24 h)</dt>
                    <dd>{view.metrics.merged}</dd>
                  </div>
                  <div>
                    <dt>In review</dt>
                    <dd>{view.metrics.inReview}</dd>
                  </div>
                  <div>
                    <dt>CI failures</dt>
                    <dd>{view.metrics.ciFailures}</dd>
                  </div>
                  <div>
                    <dt>Parks</dt>
                    <dd>{view.metrics.parks.day}</dd>
                  </div>
                  <div>
                    <dt>Spend (24 h)</dt>
                    <dd>{cost(view.metrics.seats.reduce((sum, seat) => sum + seat.costUsd, 0))}</dd>
                  </div>
                </dl>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
