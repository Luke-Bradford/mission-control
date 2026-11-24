import type { AttentionItem, CrewPause, FlightLedgerView, FlightSummaryView } from "@mc/core";
import { type KeyboardEvent, useEffect, useMemo, useState } from "react";
import { useNow } from "../../clock.ts";
import { RESOURCES, useResource } from "../../data.ts";
import { followLink, PAGE_PATHS, useHash } from "../../router.ts";
import type { FlightView } from "../flightTypes.ts";
import { Pending } from "../Pending.tsx";
import { flightRun } from "../Situation.tsx";
import { BlockersList } from "./BlockersPanel.tsx";
import { buildBlockers } from "./blockers.ts";
import { ControlRoom } from "./ControlRoom.tsx";
import { DoingNowList, doingLines } from "./DoingNow.tsx";
import { StandingOrders } from "./StandingOrders.tsx";
import { StatusBand } from "./StatusBand.tsx";
import { MemoryTab, PeopleTab, PlanTab, WatchingTab } from "./Tabs.tsx";
import { computeVitals } from "./vitals.ts";
import "./page.css";

export const NO_DECISIONS = "FLIGHT has not decided anything in the last 24 hours.";

/** The FLIGHT page's tabs, each named for what the operator comes to it for. */
export const PAGE_TABS = ["room", "plan", "watching", "memory", "people"] as const;
export type PageTab = (typeof PAGE_TABS)[number];
export const PAGE_TAB_LABEL: Record<PageTab, string> = {
  room: "Control room",
  plan: "Plan",
  watching: "Watching",
  memory: "Memory",
  people: "People",
};

/** The tab holding each panel a `#fragment` link can name; a fragment not here leaves the tab alone. */
const HASH_TAB: Readonly<Record<string, PageTab>> = {
  roomP: "room",
  doingP: "room",
  blockersP: "room",
  decisionsP: "plan",
  heldWatchP: "watching",
  pointersP: "watching",
  peopleP: "people",
};
export const tabForHash = (hash: string): PageTab | null =>
  HASH_TAB[hash.replace(/^#/, "")] ?? null;

function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  current: PageTab,
  select: (t: PageTab) => void,
) {
  const i = PAGE_TABS.indexOf(current);
  const next =
    event.key === "Home"
      ? PAGE_TABS[0]
      : event.key === "End"
        ? PAGE_TABS.at(-1)
        : event.key === "ArrowRight"
          ? PAGE_TABS[(i + 1) % PAGE_TABS.length]
          : event.key === "ArrowLeft"
            ? PAGE_TABS[(i - 1 + PAGE_TABS.length) % PAGE_TABS.length]
            : undefined;
  if (!next) return;
  event.preventDefault();
  select(next);
  document.getElementById(`fp-tab-${next}`)?.focus();
}

/**
 * The FLIGHT page: first what FLIGHT is doing and what blocks it, then how the operation is faring
 * (one row per measure, red to green), then FLIGHT's plan, what it watches, its memory and the people it works with. Only the open
 * tab is mounted, so a hidden tab fetches nothing.
 */
export function FlightPage() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const summary = useResource<FlightSummaryView>(RESOURCES.flightSummary);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention);
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen);
  const pause = useResource<CrewPause | null>(RESOURCES.crewPause).data;
  const now = useNow();
  const hash = useHash();
  const [tab, setTab] = useState<PageTab>(() => tabForHash(hash) ?? "room");
  // A link to a panel opens the tab holding it.
  useEffect(() => {
    const linked = tabForHash(hash);
    if (linked !== null) setTab(linked);
  }, [hash]);
  const view = flight.data;
  const run = flightRun(view, pause);
  const blockers = buildBlockers(attention.data, view, run, now);
  const board = PAGE_PATHS.board;
  const vitals = useMemo(
    () =>
      computeVitals({
        now,
        run,
        view,
        summary: summary.data,
        attention: attention.data,
        ledger: ledger.data?.entries,
      }),
    [now, run, view, summary.data, attention.data, ledger.data],
  );
  return (
    <section id="page-flight" className="fp">
      <div className="fp-title">
        <h1>Flight</h1>
        <span className="fp-q">
          How is the operation faring, what is FLIGHT doing, and what blocks it? PR flow is on the{" "}
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
        <StandingOrders />
      </div>
      <div className="flight-tabs" role="tablist" aria-label="Flight views">
        {PAGE_TABS.map((item) => (
          <button
            type="button"
            role="tab"
            key={item}
            id={`fp-tab-${item}`}
            aria-controls={`fp-tabbody-${item}`}
            aria-selected={tab === item}
            tabIndex={tab === item ? 0 : -1}
            onClick={() => setTab(item)}
            onKeyDown={(event) => moveTab(event, item, setTab)}
          >
            <span className="flight-tab-index" aria-hidden="true">
              {String(PAGE_TABS.indexOf(item) + 1).padStart(2, "0")}
            </span>
            {PAGE_TAB_LABEL[item]}
          </button>
        ))}
      </div>
      <div
        className="fp-tabbody"
        id={`fp-tabbody-${tab}`}
        role="tabpanel"
        aria-labelledby={`fp-tab-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the APG tabs pattern makes a tabpanel a tab stop.
        tabIndex={0}
      >
        {tab === "room" && (
          <>
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
                {attention.data ? (
                  <BlockersList rows={blockers} />
                ) : (
                  <Pending what="blockers" error={attention.error} resource={RESOURCES.attention} />
                )}
              </section>
            </div>
            <ControlRoom vitals={vitals} now={now} />
          </>
        )}
        {tab === "plan" && <PlanTab />}
        {tab === "watching" && <WatchingTab />}
        {tab === "memory" && <MemoryTab />}
        {tab === "people" && <PeopleTab />}
      </div>
    </section>
  );
}
