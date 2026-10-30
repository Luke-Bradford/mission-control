import { type AgentStream, clockHm } from "@mc/core";
import { useMemo } from "react";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { type DockRow, dockRows } from "./conversation.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "./flightTypes.ts";
import { Pending } from "./Pending.tsx";

export const NOTHING_LOGGED = "Nothing logged yet.";

export const entriesLabel = (n: number): string => (n === 1 ? "1 entry" : `${n} entries`);

type LogEntry = Extract<DockRow, { kind: "hub" }>;

function LogRow({ row, tz }: { row: LogEntry; tz: string | null }) {
  const at = row.at !== null && tz !== null ? ` · ${clockHm(row.at, tz)}` : "";
  return (
    <div className={`dmsg ${row.kind}`}>
      <div className="who">
        Mission Control
        {at}
      </div>
      <div className="txt">
        <Expandable lines={2}>{row.text}</Expandable>
      </div>
    </div>
  );
}

/**
 * Mission Control wakes and recorded actions. Every FLIGHT decision, whatever its day or kind, is
 * left out: decisions have their one presentation in Decided without you.
 */
export function WorkingLog() {
  const flight = useResource<FlightView>(RESOURCES.flight);
  const view = flight.data;
  const seat = view?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const tz = useTz();
  const rows = useMemo(
    () => (seat ? dockRows(stream, []).filter((row): row is LogEntry => row.kind === "hub") : []),
    [seat, stream],
  );
  return (
    <Panel
      id="logP"
      title="System log"
      sub="Mission Control wakes and recorded actions, newest first"
      actions={seat ? <span className="flight-count">{entriesLabel(rows.length)}</span> : undefined}
    >
      {view === undefined ? (
        <Pending what="the log" error={flight.error} resource={RESOURCES.flight} />
      ) : !seat ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <div className="flight-panel-scroll flight-log" id="workLog">
          {rows.length === 0 ? (
            <p className="pb note">{NOTHING_LOGGED}</p>
          ) : (
            [...rows].reverse().map((r) => <LogRow key={r.id} row={r} tz={tz} />)
          )}
        </div>
      )}
    </Panel>
  );
}
