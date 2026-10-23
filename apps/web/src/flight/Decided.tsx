import { type Crew, clockHm, seatCallSign } from "@mc/core";
import { useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { useSeatName } from "../seatName.ts";
import { answersToday, overturnText } from "./conversation.ts";
import { FLIGHT_NO_SEAT, type FlightDecision, type FlightView } from "./flightTypes.ts";

const DASH = "—";
export const NO_DECISIONS = "Nothing decided without you today.";

function DecidedRow({
  d,
  seatId,
  live,
  index,
  tz,
}: {
  d: FlightDecision;
  seatId: string;
  live: boolean;
  index: number;
  tz: string | null;
}) {
  const nameOf = useSeatName();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // AgentTag resolves this raw call-sign identifier against the current crew.
  const call = d.seatId ? seatCallSign(d.seatId) : null;
  const overturn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatMessage(seatId), {
        text: overturnText(d, d.seatId ? nameOf(d.seatId) : null),
      });
      setDone(true);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      setErr(errorNote(error) ?? error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="drow" data-testid="decided-row">
      <div className="row">
        {call !== null && <AgentTag id={call} index={index} sm />}
        <span className="s">{tz === null ? DASH : clockHm(d.at, tz)}</span>
        {done ? (
          <Pill tone="plain">You overturned it</Pill>
        ) : (
          <button
            type="button"
            className="sm"
            title="Overturn: tell FLIGHT to undo this"
            disabled={!live || busy}
            onClick={() => void overturn()}
          >
            Overturn
          </button>
        )}
        <span className="min0">{d.about}</span>
      </div>
      <div className="s">
        <b>{d.decision}</b> · {d.basis}
      </div>
      {err !== null && (
        <p className="note err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

/** "Decided without you" (catalogue §2.2.7): the questions FLIGHT answered today, newest first. */
export function Decided() {
  const view = useResource<FlightView>(RESOURCES.flight).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const tz = useTz();
  const now = useNow();
  if (view === undefined) return <p className="pb note">{DASH}</p>;
  if (!view.seat) return <p className="pb note">{FLIGHT_NO_SEAT}</p>;
  const answers = tz === null ? [] : answersToday(view.decisions, now, tz);
  if (answers.length === 0) return <p className="pb note">{NO_DECISIONS}</p>;
  const { seat } = view;
  return (
    <div>
      {[...answers]
        .sort((a, b) => b.at - a.at)
        .map((d) => (
          <DecidedRow
            key={d.id}
            d={d}
            seatId={seat.id}
            live={seat.live}
            index={crew?.rows.find((r) => r.id === d.seatId)?.index ?? 0}
            tz={tz}
          />
        ))}
    </div>
  );
}
