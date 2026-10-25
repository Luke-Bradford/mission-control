import {
  type ConfigView,
  FLIGHT_LEDGER_KINDS,
  FLIGHT_LEDGER_REF,
  FLIGHT_SUMMARY_LISTED,
  type FlightLedgerEntry,
  type FlightLedgerKind,
  type FlightLedgerView,
  type FlightScheduleEntry,
  type FlightScheduleView,
  type FlightSummaryItem,
  type FlightSummaryView,
} from "@mc/core";
import { useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { cost, dayMonth, hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { FLIGHT_NO_SEAT } from "./flightTypes.ts";

const DASH = "—";
export const SUMMARY_EMPTY = "FLIGHT has not written a headline yet.";
const KIND_LABEL: Record<FlightLedgerKind, string> = {
  work: "Work",
  watch: "Watch",
  commitment: "Commitments",
  incoming: "Incoming",
};

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

function SummaryRow({
  item,
  entry,
  plan,
  repoId,
  due = false,
}: {
  item: FlightSummaryItem | FlightLedgerEntry;
  entry?: FlightLedgerEntry;
  plan?: FlightScheduleEntry;
  repoId?: string;
  due?: boolean;
}) {
  const refs = entry?.refs ?? (plan?.target ? [plan.target] : []);
  return (
    <li>
      <Expandable
        summary={
          <span className="flight-summary-line">
            {entry?.owner && <AgentTag id={entry.owner} index={0} bare sm />}
            <span className="flight-summary-title">{item.title}</span>
            <Pill
              tone={
                item.status === "blocked" ? "crit" : item.status === "waiting" ? "warn" : "plain"
              }
            >
              {item.status}
            </Pill>
            {entry?.waitsOn && <span className="fg2">waiting on {entry.waitsOn}</span>}
            {due && (
              <span className="s fg2">
                {item.due === null ? (
                  "No due time"
                ) : (
                  <>
                    Due <Timestamp at={item.due} />
                  </>
                )}
              </span>
            )}
          </span>
        }
      >
        <dl className="flight-details">
          <div>
            <dt>Next</dt>
            <dd>{item.next ?? DASH}</dd>
          </div>
          <div>
            <dt>Refs</dt>
            <dd className="flight-refs">
              {refs.length
                ? refs.map((ref) => <RefLink key={ref} value={ref} repoId={repoId} />)
                : DASH}
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>
              <Timestamp at={entry?.updatedAt ?? null} />
            </dd>
          </div>
          {plan && (
            <div>
              <dt>Created</dt>
              <dd>
                <Timestamp at={plan.createdAt} />
              </dd>
            </div>
          )}
          {entry?.outcome && (
            <div>
              <dt>Outcome</dt>
              <dd>{entry.outcome}</dd>
            </div>
          )}
          {entry?.basis && (
            <div>
              <dt>Basis</dt>
              <dd>{entry.basis}</dd>
            </div>
          )}
        </dl>
      </Expandable>
    </li>
  );
}

/** Summary order and counts come from the hub; the ledger supplies each line's details. */
export function Summary() {
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen);
  const [fullOpen, setFullOpen] = useState(false);
  const fullLedger = useResource<FlightLedgerView>(fullOpen ? RESOURCES.flightLedger : null);
  const schedule = useResource<FlightScheduleView>(RESOURCES.flightSchedule);
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const full = useRef<HTMLDetailsElement>(null);
  const view = summary.data;
  const entries = ledger.data?.session === view?.session ? (ledger.data?.entries ?? []) : [];
  const fullEntries =
    fullLedger.data?.session === view?.session ? (fullLedger.data?.entries ?? []) : [];
  const plans = schedule.data?.session === view?.session ? (schedule.data?.entries ?? []) : [];
  const repoId = config?.crew?.sessions.find((s) => s.id === view?.session)?.repoId;
  const row = (item: FlightSummaryItem, due = false) =>
    !ledger.data && !ledger.error ? (
      <li key={`${item.kind}:${item.key}`}>{DASH}</li>
    ) : (
      <SummaryRow
        key={`${item.kind}:${item.key}`}
        item={item}
        entry={entries.find((e) => e.kind === item.kind && e.key === item.key)}
        plan={item.kind === "plan" ? plans.find((p) => p.id === item.key) : undefined}
        repoId={repoId}
        due={due}
      />
    );
  return (
    <div className="flight-summary">
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
          <p className="sittext">{view.headline || SUMMARY_EMPTY}</p>
          <button
            type="button"
            className="sm ghost"
            aria-controls="flight-ledger"
            onClick={() => {
              setFullOpen(true);
              if (full.current) {
                full.current.open = true;
                full.current.querySelector("summary")?.focus();
                full.current.scrollIntoView?.({ block: "nearest" });
              }
            }}
          >
            Ledger
          </button>
          {ledger.error && (
            <p role="alert" className="note err">
              Ledger: {ledger.error.message}
            </p>
          )}
          <section aria-labelledby="flight-summary-now">
            <h3 id="flight-summary-now">Now</h3>
            {view.now.length ? (
              <ul className="flight-summary-list" aria-label="Now">
                {view.now.slice(0, FLIGHT_SUMMARY_LISTED).map((item) => row(item))}
              </ul>
            ) : (
              <p className="note">No work in progress.</p>
            )}
          </section>
          <section aria-labelledby="flight-summary-watching">
            <h3 id="flight-summary-watching">Watching</h3>
            <p className="s fg2">
              {view.watching.counts.active} active · {view.watching.counts.blocked} blocked ·{" "}
              {view.watching.counts.waiting} waiting
            </p>
            {view.watching.top.length ? (
              <ul className="flight-summary-list" aria-label="Watching">
                {view.watching.top.slice(0, FLIGHT_SUMMARY_LISTED).map((item) => row(item))}
              </ul>
            ) : (
              <p className="note">Nothing to watch.</p>
            )}
          </section>
          <section aria-labelledby="flight-summary-next">
            <h3 id="flight-summary-next">Next</h3>
            {schedule.error && (
              <p role="alert" className="note err">
                Schedule: {schedule.error.message}
              </p>
            )}
            {view.next.length ? (
              <ol className="flight-summary-list" aria-label="Next">
                {view.next.map((item) => row(item, true))}
              </ol>
            ) : (
              <p className="note">Nothing scheduled.</p>
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
          <details
            id="flight-ledger"
            className="flight-ledger"
            ref={full}
            onToggle={(event) => setFullOpen(event.currentTarget.open)}
          >
            <summary>Full ledger</summary>
            {fullLedger.error && (
              <p role="alert" className="note err">
                Ledger: {fullLedger.error.message}
              </p>
            )}
            {!fullLedger.data ? (
              <p className="note">{DASH}</p>
            ) : (
              FLIGHT_LEDGER_KINDS.map((kind) => {
                const group = fullEntries.filter((entry) => entry.kind === kind);
                return (
                  <section key={kind} aria-label={KIND_LABEL[kind]}>
                    <h3>{KIND_LABEL[kind]}</h3>
                    {group.length ? (
                      <ul className="flight-summary-list">
                        {group.map((entry) => (
                          <SummaryRow
                            key={entry.key}
                            item={entry}
                            entry={entry}
                            repoId={repoId}
                            due={entry.kind === "commitment"}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="note">No entries.</p>
                    )}
                  </section>
                );
              })
            )}
            <section aria-label="Scheduled">
              <h3>Scheduled</h3>
              {plans.length ? (
                <ol className="flight-summary-list">
                  {plans.map((plan) =>
                    row(
                      {
                        key: plan.id,
                        kind: "plan",
                        title: plan.label,
                        status: plan.status,
                        due: plan.dueAt,
                        next: plan.detail ?? null,
                        priority: null,
                        ageMin: 0,
                      },
                      true,
                    ),
                  )}
                </ol>
              ) : (
                <p className="note">{schedule.data ? "Nothing scheduled." : DASH}</p>
              )}
            </section>
          </details>
        </>
      )}
    </div>
  );
}
