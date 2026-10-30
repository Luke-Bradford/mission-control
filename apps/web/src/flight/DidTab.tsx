import {
  type Crew,
  FLIGHT_DECISION_KINDS,
  FLIGHT_VIEW_LIMIT,
  type FlightSummaryView,
} from "@mc/core";
import { useMemo, useState } from "react";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { isForTheController, kindLabel } from "./conversation.ts";
import { DecidedRow } from "./Decided.tsx";
import { FLIGHT_NO_SEAT, type FlightDecision, type FlightView } from "./flightTypes.ts";
import { Incoming } from "./Incoming.tsx";
import { Pending } from "./Pending.tsx";
import { Summary } from "./Summary.tsx";
import { WorkingLog } from "./WorkingLog.tsx";

export const NO_DECISIONS_24H = "FLIGHT has decided nothing in the last 24 hours.";
export const DECISIONS_CAPPED = `newest ${FLIGHT_VIEW_LIMIT} shown · the hub serves no older decisions of the last 24 h`;
export const NO_CONTROLLER_ASKS = "Nothing was addressed to the controller in the last 24 hours.";
export const controllerCapped = (counted: number, listed: number): string =>
  `${counted} asks for the controller were counted, but only the newest ${FLIGHT_VIEW_LIMIT} decisions are listed here, which hold ${listed}.`;
export const NO_MATCHING = "No decision matches those filters.";
export const MISSING_POWERS_PENDING =
  "Missing powers: not available yet. The hub does not report what FLIGHT lacked.";
export const WAKE_GROUPING_UNAVAILABLE =
  "Wake grouping unavailable: the hub does not serve a wake id for a decision, so they are listed by time.";
const ALL = "";

const matches = (d: FlightDecision, text: string): boolean => {
  const q = text.trim().toLowerCase();
  return (
    q === "" ||
    [d.about, d.decision, d.basis, d.ref ?? ""].some((field) => field.toLowerCase().includes(q))
  );
};

/** Every decision FLIGHT made in the last day, newest first, with filters and Overturn. */
function Decisions({ controllerOnly }: { controllerOnly: boolean }) {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const view = flight.data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const tz = useTz();
  const [kind, setKind] = useState(ALL);
  const [seat, setSeat] = useState(ALL);
  const [text, setText] = useState("");
  const counted = useResource<FlightSummaryView>(RESOURCES.flightSummary).data?.metrics
    .forTheController;
  const all = view?.decisions ?? [];
  const rows = useMemo(
    () =>
      all
        .filter(
          (d) =>
            (!controllerOnly || isForTheController(d)) &&
            (kind === ALL || d.kind === kind) &&
            (seat === ALL || d.seatId === seat) &&
            matches(d, text),
        )
        .sort((a, b) => b.at - a.at || b.id - a.id),
    [all, controllerOnly, kind, seat, text],
  );
  if (view === undefined)
    return <Pending what="decisions" error={flight.error} resource={RESOURCES.flight} />;
  if (!view.seat) return <p className="pb note">{FLIGHT_NO_SEAT}</p>;
  if (all.length === 0) return <p className="pb note">{NO_DECISIONS_24H}</p>;
  const seats = [...new Set(all.flatMap((d) => (d.seatId ? [d.seatId] : [])))].sort();
  const shown = rows.length;
  return (
    <div>
      <search className="flight-filters" aria-label="Filter decisions">
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value={ALL}>All kinds</option>
          {FLIGHT_DECISION_KINDS.filter((k) => all.some((d) => d.kind === k)).map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <select aria-label="Seat" value={seat} onChange={(e) => setSeat(e.target.value)}>
          <option value={ALL}>All seats</option>
          {seats.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="search"
          aria-label="Search decisions"
          placeholder="Search about, decision, basis"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="s note">
          {all.length >= FLIGHT_VIEW_LIMIT
            ? DECISIONS_CAPPED
            : `${shown} of ${all.length} · last 24 h`}
        </span>
      </search>
      <p className="pb note">{WAKE_GROUPING_UNAVAILABLE}</p>
      {controllerOnly &&
        all.length >= FLIGHT_VIEW_LIMIT &&
        counted !== undefined &&
        counted > all.filter(isForTheController).length && (
          <p className="pb note" role="status">
            {controllerCapped(counted, all.filter(isForTheController).length)}
          </p>
        )}
      {rows.length === 0 ? (
        <p className="pb note">
          {controllerOnly && text === "" && kind === ALL && seat === ALL
            ? NO_CONTROLLER_ASKS
            : NO_MATCHING}
        </p>
      ) : (
        <section aria-label="Decisions, newest first" data-testid="decision-list">
          {rows.map((d) => (
            <DecidedRow
              key={d.id}
              d={d}
              seatId={view.seat?.id ?? ""}
              live={view.seat?.live ?? false}
              index={crew?.rows.find((r) => r.id === d.seatId)?.index ?? 0}
              tz={tz}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** What FLIGHT did: its decisions, what they led to, and what it could not do. */
export function DidTab() {
  // The "For the controller" tile in Outcomes narrows the decisions to those asks.
  const [controllerOnly, setControllerOnly] = useState(false);
  return (
    <>
      <Panel
        id="decidedP"
        title="Decisions"
        sub={
          controllerOnly
            ? "asks FLIGHT addressed to the controller in the last 24 hours, newest first"
            : "everything FLIGHT decided in the last 24 hours, newest first"
        }
      >
        <div className="flight-panel-scroll">
          <Decisions controllerOnly={controllerOnly} />
        </div>
      </Panel>
      <div className="flight-did-side">
        <Panel id="outcomesP" title="Outcomes" sub="recently completed work and the last 24 hours">
          <div className="flight-panel-scroll">
            <Summary
              mode="record"
              controllerOnly={controllerOnly}
              onControllerOnly={setControllerOnly}
            />
          </div>
        </Panel>
        <Panel id="powersP" title="Missing powers" sub="what FLIGHT could not do">
          <p className="pb note">{MISSING_POWERS_PENDING}</p>
        </Panel>
        <Panel id="incP" title="Arrivals" sub="what came in and how FLIGHT routed it">
          <div className="flight-panel-scroll">
            <Incoming />
          </div>
        </Panel>
        <WorkingLog />
      </div>
    </>
  );
}
