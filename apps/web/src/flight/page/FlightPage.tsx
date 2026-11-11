import type { AttentionItem, CrewPause, FlightSummaryView } from "@mc/core";
import { useCallback, useState } from "react";
import { useNow } from "../../clock.ts";
import { RESOURCES, useResource } from "../../data.ts";
import { followLink, PAGE_PATHS } from "../../router.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "../flightTypes.ts";
import { WatchListItems } from "../HeldNeeds.tsx";
import { Pending } from "../Pending.tsx";
import { flightRun } from "../Situation.tsx";
import { BlockersList } from "./BlockersPanel.tsx";
import { buildBlockers } from "./blockers.ts";
import { DoingNowList, doingLines } from "./DoingNow.tsx";
import { DecisionRows, newestFirst } from "./RecentDecisions.tsx";
import { StatusBand } from "./StatusBand.tsx";
import "./page.css";

export const NO_DECISIONS = "FLIGHT has not decided anything in the last 24 hours.";

/**
 * The FLIGHT page: is FLIGHT working, what is it doing now, and what blocks it and who owns each
 * blocker. A status band, Doing now beside Blockers, and the recent decisions in the space left.
 */
export function FlightPage() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const held = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  const pause = useResource<CrewPause | null>(RESOURCES.crewPause).data;
  const now = useNow();
  const [shown, setShown] = useState<number | null>(null);
  const onShown = useCallback((n: number) => setShown(n), []);
  const view = flight.data;
  const run = flightRun(view, pause);
  const blockers = buildBlockers(attention.data, view, run, now);
  const decisions = newestFirst(view?.decisions ?? []);
  const board = PAGE_PATHS.board;
  return (
    <section id="page-flight" className="fp">
      <div className="fp-title">
        <h1>Flight</h1>
        <span className="fp-q">
          Is FLIGHT working, what is it doing, and what blocks it? PR flow is on the{" "}
          <a className="fp-board" href={board} onClick={(e) => followLink(e, board)}>
            Board
          </a>
          .
        </span>
        <a
          className="fp-records"
          href={`${PAGE_PATHS.flight}#handlingP`}
          onClick={(e) => followLink(e, `${PAGE_PATHS.flight}#handlingP`)}
        >
          Records
        </a>
      </div>
      <StatusBand run={run} view={view} now={now} />
      <div className="fp-mid">
        <section className="fp-panel fp-self-start" id="doingP" aria-labelledby="doingH">
          <h2 className="fp-head" id="doingH">
            Doing now
          </h2>
          {summary.data ? (
            <DoingNowList lines={doingLines(run, summary.data)} />
          ) : (
            <Pending
              what="what FLIGHT is doing"
              error={summary.error}
              resource={RESOURCES.flightSummary}
            />
          )}
        </section>
        <section className="fp-panel" id="blockersP" aria-labelledby="blockersH">
          <h2 className="fp-head" id="blockersH">
            Blockers
            <span className="fp-sub">
              {blockers.length ? `${blockers.length} · longest wait first` : "none"}
            </span>
          </h2>
          {attention.data || attention.error === null ? (
            attention.data ? (
              <BlockersList rows={blockers} />
            ) : (
              <Pending what="blockers" error={null} resource={RESOURCES.attention} />
            )
          ) : (
            <Pending what="blockers" error={attention.error} resource={RESOURCES.attention} />
          )}
        </section>
        <section className="fp-panel fp-watch" id="heldWatchP" aria-labelledby="watchH">
          <h2 className="fp-head" id="watchH">
            Watch list
            <span className="fp-sub">
              {held.data === undefined
                ? "loading"
                : `${held.data.length} on a condition${held.data.length === 0 ? " · nothing held" : ""}`}
            </span>
          </h2>
          {held.data === undefined ? (
            <Pending what="Watch list" error={held.error} resource={RESOURCES.heldAttention} />
          ) : held.data.length === 0 ? (
            <p className="fp-note">Nothing is held.</p>
          ) : (
            <WatchListItems items={held.data} />
          )}
        </section>
      </div>
      <section className="fp-panel fp-dec" id="decisionsP" aria-labelledby="decH">
        <h2 className="fp-head" id="decH">
          Recent decisions
          <span className="fp-sub">
            {shown === null || decisions.length === 0
              ? "newest first"
              : `last ${shown} · newest first`}
          </span>
        </h2>
        {view === undefined ? (
          <Pending what="decisions" error={flight.error} resource={RESOURCES.flight} />
        ) : view.seat === null ? (
          <p className="fp-note">{FLIGHT_NO_SEAT}</p>
        ) : decisions.length === 0 ? (
          <p className="fp-note">{NO_DECISIONS}</p>
        ) : (
          <DecisionRows decisions={decisions} onShown={onShown} />
        )}
      </section>
    </section>
  );
}
