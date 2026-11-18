import type { AgentDetailView, Crew } from "@mc/core";
import { useEffect } from "react";
import { HandoffPanel } from "../agent/HandoffPanel.tsx";
import { IdentityBand } from "../agent/IdentityBand.tsx";
import { Instruments } from "../agent/Instruments.tsx";
import { RightColumn } from "../agent/RightColumn.tsx";
import { Roster } from "../agent/Roster.tsx";
import { RunTracePanel } from "../agent/RunTrace.tsx";
import { StreamPanel } from "../agent/StreamPanel.tsx";
import { interruptSeat, seatError } from "../agent/seat.ts";
import { useTz } from "../clock.ts";
import { hub, RESOURCES, streamStatus, useResource } from "../data.ts";
import { followLink, setupPath, useSearch } from "../router.ts";
import { setPageKey } from "../shell/keys.ts";
import { getSelectedAgent, setSelectedAgent, useSelectedAgent } from "../shell/selection.ts";
import { useSessionScope } from "../shell/session.ts";
import { useStore } from "../shell/store.ts";
import { toast } from "../shell/Toast.tsx";
import "../agent/agent.css";
import "../agent/control.css";

/**
 * One agent in detail (catalogue §2.4): identity, ask/result and next decision before the
 * conversation, alongside current review and run context. History stays lazy. `/agent` with no id
 * shows the selected agent, else the first running crew seat,
 * else the first crew seat, else the first in view.
 */
export function Agent({ id }: { id: string | null }) {
  const crew = useResource<Crew>(RESOURCES.crew);
  const tz = useTz();
  const { inView: matchesSession } = useSessionScope();
  const [selected] = useSelectedAgent();
  const params = new URLSearchParams(useSearch());
  const traceRun = params.get("trace");
  const handoffRun = params.get("handoff");

  const all = crew.data ? [...crew.data.rows].sort((a, b) => a.index - b.index) : null;
  const inView = all?.filter((r) => matchesSession(r)) ?? [];
  const crewSeats = inView.filter((r) => r.kind === "crew");
  const requested = id !== null && all ? (all.find((r) => r.id === id) ?? null) : null;
  // A seat removed while chosen: say so and choose the first seat.
  const removed = all !== null && id !== null && requested === null;
  const listed =
    all === null
      ? null
      : ((id !== null && !removed
          ? requested
          : (inView.find((r) => r.id === selected) ??
            crewSeats.find((r) => r.hudState === "running") ??
            crewSeats[0] ??
            inView[0])) ?? null);
  const shownId = listed?.id ?? null;
  // The list is summary rows; the page itself shows the seat in full (events, digest), one row.
  const detail = useResource<AgentDetailView>(
    shownId !== null ? RESOURCES.agentDetail(shownId) : null,
  );
  const row = detail.data?.row ?? null;

  // The selection follows the agent on screen, so j/k step from it.
  useEffect(() => {
    if (shownId !== null && shownId !== getSelectedAgent()) setSelectedAgent(shownId);
  }, [shownId]);

  // `i` interrupts a crew seat; an observed loop is never interrupted, so it says so.
  const shownKind = listed?.kind ?? null;
  useEffect(() => {
    if (shownId === null) return;
    setPageKey("i", () => {
      if (shownKind === "crew") {
        interruptSeat({ id: shownId }).catch((e) => toast(seatError(e)));
      } else {
        toast(`${shownId} is an observed loop; Mission Control does not interrupt it.`);
      }
    });
    return () => setPageKey("i", null);
  }, [shownId, shownKind]);

  const link = useStore(streamStatus);
  // Down means the hub was reachable and is not now; the first connect is not a disconnection.
  const down = !link.connected && link.reconnecting;
  const lastAge = link.lastMessageAt;

  let missing: string | null = null;
  if (crew.error && !crew.data) missing = "Could not load the crew.";
  else if (!crew.data) missing = "Loading…";
  else if (!listed) missing = null;
  else if (!row) missing = detail.error ? "Could not load this agent." : "Loading…";
  const noSeats = crew.data !== undefined && !listed;
  const loading = !crew.data && !crew.error;

  return (
    <section id="page-agent" className="agent-v2 control-room">
      <h1 className="sr-only">Agents</h1>
      {down && (
        <div className="pb s crit-t control-banner" role="status">
          Hub disconnected.{" "}
          {lastAge !== null ? `Showing data from ${new Date(lastAge).toLocaleTimeString()}. ` : ""}
          Actions are off until it reconnects.
        </div>
      )}
      {removed && (
        <div className="pb s control-banner" role="status">
          {id} is no longer a seat. Showing the first one.
        </div>
      )}
      <div className="agent-v2-shell control-shell">
        <Roster
          rows={crew.data ? inView : null}
          current={shownId}
          error={!!crew.error && !crew.data}
        />
        {handoffRun && <HandoffPanel runId={handoffRun} />}
        {traceRun && id !== null ? (
          <div className="control-main trace">
            <RunTracePanel agentId={id} runId={traceRun} />
          </div>
        ) : row && detail.data ? (
          <>
            <div className="control-main">
              {detail.error && (
                <div className="pb s crit-t" role="status">
                  Showing the last saved agent view. Could not refresh: {detail.error.message}{" "}
                  <button
                    type="button"
                    className="sm"
                    onClick={() => shownId && hub.refetch(RESOURCES.agentDetail(shownId).path)}
                  >
                    Retry agent
                  </button>
                </div>
              )}
              <IdentityBand view={detail.data} connected={!down} />
              <Instruments key={`i:${row.id}`} row={row} />
              <StreamPanel key={`s:${row.id}`} row={row} tz={tz} />
            </div>
            <RightColumn key={`r:${row.id}`} view={detail.data} />
          </>
        ) : (
          <div className="control-main">
            {noSeats ? (
              <p className="pb">
                No seats yet.{" "}
                <a
                  href={setupPath("sessions")}
                  onClick={(e) => followLink(e, setupPath("sessions"))}
                >
                  Add one in Setup
                </a>
              </p>
            ) : (
              <p
                className={
                  (crew.error && !crew.data) || (detail.error && !row) ? "pb crit-t" : "pb muted"
                }
                aria-busy={loading || undefined}
              >
                {missing}
                {detail.error && shownId && (
                  <button
                    type="button"
                    className="sm"
                    onClick={() => hub.refetch(RESOURCES.agentDetail(shownId).path)}
                  >
                    Retry agent
                  </button>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
