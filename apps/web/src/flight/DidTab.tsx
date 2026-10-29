import { type Crew, clockHm, FLIGHT_DECISION_KINDS, FLIGHT_VIEW_LIMIT } from "@mc/core";
import { useMemo, useState } from "react";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { kindLabel } from "./conversation.ts";
import { DecidedRow } from "./Decided.tsx";
import { FLIGHT_NO_SEAT, type FlightDecision, type FlightView } from "./flightTypes.ts";
import { Incoming } from "./Incoming.tsx";
import { Summary } from "./Summary.tsx";
import { WorkingLog } from "./WorkingLog.tsx";

const DASH = "—";
export const NO_DECISIONS_24H = "FLIGHT has decided nothing in the last 24 hours.";
export const DECISIONS_CAPPED = `newest ${FLIGHT_VIEW_LIMIT} shown · the hub serves no older decisions of the last 24 h`;
export const NO_MATCHING = "No decision matches those filters.";
export const MISSING_POWERS_PENDING =
  "Missing powers: not available yet. The hub does not report what FLIGHT lacked.";
/** Decisions closer together than this belong to one wake of FLIGHT. */
export const WAKE_GAP_MS = 10 * 60_000;
const ALL = "";

/** One wake: the decisions made in it, newest first. */
export interface WakeGroup {
  from: number;
  to: number;
  decisions: FlightDecision[];
}

/**
 * Decisions grouped by wake. The hub stores no wake id, so a wake is a run of decisions with no
 * gap over WAKE_GAP_MS between neighbours. Groups and the decisions in them are newest first.
 */
export function groupByWake(decisions: readonly FlightDecision[]): WakeGroup[] {
  const sorted = [...decisions].sort((a, b) => b.at - a.at || b.id - a.id);
  const groups: WakeGroup[] = [];
  for (const d of sorted) {
    const last = groups.at(-1);
    if (last && last.from - d.at <= WAKE_GAP_MS) {
      last.decisions.push(d);
      last.from = d.at;
    } else groups.push({ from: d.at, to: d.at, decisions: [d] });
  }
  return groups;
}

const matches = (d: FlightDecision, text: string): boolean => {
  const q = text.trim().toLowerCase();
  return (
    q === "" ||
    [d.about, d.decision, d.basis, d.ref ?? ""].some((field) => field.toLowerCase().includes(q))
  );
};

/** Every decision FLIGHT made in the last day, grouped by wake, with filters and Overturn. */
function Decisions() {
  const view = useResource<FlightView>(RESOURCES.flight).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const tz = useTz();
  const [kind, setKind] = useState(ALL);
  const [seat, setSeat] = useState(ALL);
  const [text, setText] = useState("");
  const all = view?.decisions ?? [];
  const groups = useMemo(
    () =>
      groupByWake(
        all.filter(
          (d) =>
            (kind === ALL || d.kind === kind) &&
            (seat === ALL || d.seatId === seat) &&
            matches(d, text),
        ),
      ),
    [all, kind, seat, text],
  );
  if (view === undefined) return <p className="pb note">{DASH}</p>;
  if (!view.seat) return <p className="pb note">{FLIGHT_NO_SEAT}</p>;
  if (all.length === 0) return <p className="pb note">{NO_DECISIONS_24H}</p>;
  const seats = [...new Set(all.flatMap((d) => (d.seatId ? [d.seatId] : [])))].sort();
  const shown = groups.reduce((n, g) => n + g.decisions.length, 0);
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
      {groups.length === 0 ? (
        <p className="pb note">{NO_MATCHING}</p>
      ) : (
        groups.map((g) => (
          <section
            className="flight-wake"
            key={g.decisions[0]?.id}
            aria-label={`Wake at ${tz === null ? DASH : clockHm(g.from, tz)}`}
            data-testid="wake-group"
          >
            <h3 className="pb">
              {tz === null
                ? DASH
                : g.from === g.to
                  ? clockHm(g.to, tz)
                  : `${clockHm(g.from, tz)}–${clockHm(g.to, tz)}`}
              {` · ${g.decisions.length} ${g.decisions.length === 1 ? "decision" : "decisions"}`}
            </h3>
            {g.decisions.map((d) => (
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
        ))
      )}
    </div>
  );
}

/** What FLIGHT did: its decisions by wake, what they led to, and what it could not do. */
export function DidTab() {
  return (
    <>
      <Panel
        id="decidedP"
        title="Decisions"
        sub="everything FLIGHT decided in the last 24 hours, grouped by wake"
      >
        <div className="flight-panel-scroll">
          <Decisions />
        </div>
      </Panel>
      <div className="flight-did-side">
        <Panel id="outcomesP" title="Outcomes" sub="recently completed work and the last 24 hours">
          <div className="flight-panel-scroll">
            <Summary mode="record" />
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
