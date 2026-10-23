import { type AgentStream, clockHm } from "@mc/core";
import { useMemo } from "react";
import { useTz } from "../clock.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Panel } from "../hud/Panel.tsx";
import { type DockRow, dockRows, feedRows, kindLabel } from "./conversation.ts";
import { FLIGHT_NO_SEAT, type FlightView } from "./flightTypes.ts";

export const NOTHING_LOGGED = "Nothing logged yet.";

export const entriesLabel = (n: number): string => (n === 1 ? "1 entry" : `${n} entries`);

function LogRow({ row, tz }: { row: DockRow; tz: string | null }) {
  const at = row.at !== null && tz !== null ? ` · ${clockHm(row.at, tz)}` : "";
  const who = row.kind === "decision" ? `FLIGHT · ${kindLabel(row.d.kind)}` : "Mission Control";
  return (
    <div className={`dmsg ${row.kind}`}>
      <div className="who">
        {who}
        {at}
      </div>
      <div className="txt">
        {row.kind === "decision" ? `${row.d.about} → ${row.d.decision}` : row.text}
      </div>
    </div>
  );
}

/** FLIGHT › Working log: Mission Control's wake lines and FLIGHT's decisions, collapsed. */
export function WorkingLog() {
  const view = useResource<FlightView>(RESOURCES.flight).data;
  const seat = view?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const tz = useTz();
  const decisions = view?.decisions;
  const rows = useMemo(
    () => (seat ? feedRows(dockRows(stream, decisions ?? [])) : []),
    [seat, stream, decisions],
  );
  return (
    <Panel
      id="logP"
      title="Working log"
      sub="Mission Control's wake lines and FLIGHT's decisions, oldest first"
    >
      {view === undefined ? (
        <p className="pb note">—</p>
      ) : !seat ? (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      ) : (
        <details className="guard" id="workLog">
          <summary>{entriesLabel(rows.length)}</summary>
          {rows.length === 0 ? (
            <p className="note">{NOTHING_LOGGED}</p>
          ) : (
            rows.map((r) => <LogRow key={r.id} row={r} tz={tz} />)
          )}
        </details>
      )}
    </Panel>
  );
}
