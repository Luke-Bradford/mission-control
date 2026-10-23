import { type CrewRow, LOCK_FREE_TEXT, LOCK_NOBODY_WAITING, seatCallSign } from "@mc/core";
import { useState } from "react";
import { interruptSeat, seatError } from "../agent/seat.ts";
import { useSecond } from "../clock.ts";
import { useTestLock } from "../components/LockLines.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { mss } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { TicketRef } from "../hud/RepoRef.tsx";
import { agentPath, navigate } from "../router.ts";

const LOCK_FREE_NEXT = "The next verify step takes it straight away.";

/** A seat's ticket as a chip; nothing for a seat the crew does not list or one without a ticket. */
const TicketChip = ({ row }: { row: CrewRow | undefined }) =>
  row?.ticket ? <TicketRef ticket={row.ticket} /> : null;

/**
 * The test lock (catalogue 2.1.4): who holds it, how long, with Stop the run and Open, and the
 * seats in line; or that it is free. A stalled holder gives the box an amber border and a pulse.
 */
export function LockBox() {
  const lock = useTestLock();
  const crew = useResource<{ rows: CrewRow[] }>(RESOURCES.crew).data;
  const now = useSecond();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = <h3>Full test suite · one at a time</h3>;
  if (lock === undefined) {
    return (
      <div className="lock">
        <div className="row">{heading}</div>
      </div>
    );
  }
  const h = lock.holder;
  if (h === null) {
    return (
      <div className="lock">
        <div className="row">
          {heading}
          <span className="spacer" />
          <Pill tone="neutral">Free</Pill>
        </div>
        <div className="s muted">
          {LOCK_FREE_TEXT} {LOCK_FREE_NEXT}
        </div>
      </div>
    );
  }
  const rowOf = (id: string) => crew?.rows.find((r) => r.id === id);
  const holder = rowOf(h.seatId);
  const stalled = holder?.hudState === "stalled";
  const quiet = holder?.lastOutputAt ?? null;
  const call = seatCallSign(h.seatId);
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await interruptSeat({ id: h.seatId });
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  const waits = new Map<string, number>();
  return (
    <div className={stalled ? "lock hot pulse-warn" : "lock"}>
      <div className="row">
        {heading}
        <span className="spacer" />
        {stalled ? <Pill tone="warn">No output</Pill> : <Pill tone="ok">Running</Pill>}
      </div>
      <div className="row">
        <AgentTag id={h.seatId} index={holder?.index ?? 0} sm />
        <span className="chipref">{h.command}</span>
        <TicketChip row={holder} />
      </div>
      <div className="s fg2">
        <span className="num">{mss(now - h.since)}</span> elapsed
        {stalled && quiet !== null && (
          <>
            {" · nothing printed for "}
            <span className="num">{mss(now - quiet)}</span>
          </>
        )}
      </div>
      <div className="row">
        <button type="button" className="sm warn" disabled={busy} onClick={() => void stop()}>
          Stop the run
        </button>
        <button type="button" className="sm" onClick={() => navigate(agentPath(h.seatId))}>
          Open {call}
        </button>
        {error && (
          <span className="crit-t s" role="alert">
            {error}
          </span>
        )}
      </div>
      {lock.waiting.length > 0 ? (
        <>
          <div className="qsec">Waiting</div>
          {lock.waiting.map((w, i) => {
            // one run can wait with two calls at once (parallel Bash): its run id alone repeats
            const n = (waits.get(w.runId) ?? 0) + 1;
            waits.set(w.runId, n);
            const row = rowOf(w.seatId);
            return (
              <div key={`${w.runId}#${n}`} className="lockq">
                <span className="muted num">{i + 1}</span>
                <span className="row">
                  <AgentTag id={w.seatId} index={row?.index ?? 0} sm />
                  <TicketChip row={row} />
                </span>
                <span className="num s warn-t">{mss(now - w.since)}</span>
              </div>
            );
          })}
        </>
      ) : (
        <div className="s muted">{LOCK_NOBODY_WAITING}</div>
      )}
    </div>
  );
}
