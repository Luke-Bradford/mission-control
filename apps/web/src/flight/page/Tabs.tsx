import type { AttentionItem, FlightLedgerView } from "@mc/core";
import { useState } from "react";
import { useNow, useTz } from "../../clock.ts";
import { RESOURCES, useResource } from "../../data.ts";
import { rel } from "../../fmt.ts";
import { Panel } from "../../hud/Panel.tsx";
import { BriefPanel, WatchList as RevisitTriggers } from "../Brief.tsx";
import { FLIGHT_NO_SEAT, type FlightView } from "../flightTypes.ts";
import { WatchListItems } from "../HeldNeeds.tsx";
import { MemoryPanel } from "../Memory.tsx";
import { Pending } from "../Pending.tsx";
import { Summary } from "../Summary.tsx";
import { changedSomething } from "./decisionEffect.ts";
import { DecisionRows, newestFirst } from "./RecentDecisions.tsx";
import { ScrollList } from "./ScrollList.tsx";
import { NOT_MEASURED } from "./vitals.ts";

const NO_DECISIONS = "FLIGHT has not decided anything in the last 24 hours.";

/** Plan: what is queued and coming up, and what FLIGHT decided lately. */
export function PlanTab() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const [shown, setShown] = useState<number | null>(null);
  const view = flight.data;
  const decisions = newestFirst((view?.decisions ?? []).filter(changedSomething));
  return (
    <>
      <Panel
        id="ledgerP"
        title="FLIGHT's queue"
        sub="what is waiting, what comes next, why, and when it must be revisited"
      >
        <div className="flight-panel-scroll">
          <Summary mode="queue" />
        </div>
      </Panel>
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
          <DecisionRows decisions={decisions} onShown={setShown} />
        )}
      </section>
    </>
  );
}

/** The things FLIGHT has pointed at: what each is, what changed and when. */
function PointerList() {
  const ledger = useResource<FlightLedgerView>(RESOURCES.flightLedgerOpen);
  const now = useNow();
  const tz = useTz();
  if (ledger.data === undefined)
    return <Pending what="pointers" error={ledger.error} resource={RESOURCES.flightLedgerOpen} />;
  const rows = ledger.data.entries.flatMap((e) =>
    (e.pointers ?? []).map((p) => ({ entry: e, pointer: p })),
  );
  if (rows.length === 0) return <p className="fp-note">FLIGHT has not pointed at anything yet.</p>;
  return (
    <ScrollList row=".drow">
      {rows.map(({ entry, pointer }) => (
        <li key={`${entry.key}:${pointer.kind}:${pointer.target}`} className="drow">
          <strong>{pointer.target}</strong> <span className="fp-muted">({pointer.kind})</span> for{" "}
          {entry.title}
          <div className="fp-muted">
            {pointer.changedAt === null || tz === null
              ? "Nothing has changed yet."
              : `${pointer.change ?? "Changed"} · ${rel(pointer.changedAt, now, tz)}`}
          </div>
        </li>
      ))}
    </ScrollList>
  );
}

/** Watching: work held on a condition, FLIGHT's revisit triggers and its pointers. */
export function WatchingTab() {
  const held = useResource<AttentionItem[]>(RESOURCES.heldAttention);
  return (
    <>
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
          <ScrollList row=".drow">
            <WatchListItems items={held.data} />
          </ScrollList>
        )}
      </section>
      <Panel
        id="watchP"
        title="Revisit triggers"
        sub="structured follow-ups with an exact action when one is available"
      >
        <div className="flight-panel-scroll">
          <RevisitTriggers />
        </div>
      </Panel>
      <section className="fp-panel" id="pointersP" aria-labelledby="pointersH">
        <h2 className="fp-head" id="pointersH">
          Pointers
          <span className="fp-sub">what FLIGHT keeps an eye on</span>
        </h2>
        <PointerList />
      </section>
    </>
  );
}

/** Memory: what FLIGHT remembers for each repo, then its dated working context. */
export function MemoryTab() {
  return (
    <>
      <MemoryPanel expanded />
      <BriefPanel />
    </>
  );
}

/** People: who asked what, by when. The hub does not record it yet. */
export function PeopleTab() {
  return (
    <section className="fp-panel" id="peopleP" aria-labelledby="peopleH">
      <h2 className="fp-head" id="peopleH">
        People
        <span className="fp-sub">{NOT_MEASURED}</span>
      </h2>
      <p className="fp-note">
        Who asked for what, where, by when and its status is not measured yet: the hub reads
        messages from Teams but does not file them as requests. This tab shows them once it does.
      </p>
    </section>
  );
}
