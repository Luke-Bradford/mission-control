import type { AgentDetailView, AttentionItem, Crew } from "@mc/core";
import { useEffect } from "react";
import { HandoffPanel } from "../agent/HandoffPanel.tsx";
import { AgentIdentity } from "../agent/Overview.tsx";
import { compareRosterSeats, Picker } from "../agent/Picker.tsx";
import { RunTracePanel } from "../agent/RunTrace.tsx";
import { StreamPanel } from "../agent/StreamPanel.tsx";
import { interruptSeat, seatError } from "../agent/seat.ts";
import { useTz } from "../clock.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { agentPath, navigate, useSearch } from "../router.ts";
import { setPageKey } from "../shell/keys.ts";
import { getSelectedAgent, setSelectedAgent, useSelectedAgent } from "../shell/selection.ts";
import { useSessionScope } from "../shell/session.ts";
import { toast } from "../shell/Toast.tsx";
import "../agent/agent.css";

/**
 * One agent in detail (catalogue §2.4): identity, ask/result and next decision before the
 * conversation, alongside current review and run context. History stays lazy. `/agent` with no id
 * shows the selected agent, else the first running crew seat,
 * else the first crew seat, else the first in view.
 */
export function Agent({ id }: { id: string | null }) {
  const crew = useResource<Crew>(RESOURCES.crew);
  const items = useResource<AttentionItem[]>(RESOURCES.attention).data ?? [];
  const tz = useTz();
  const { inView: matchesSession } = useSessionScope();
  const [selected] = useSelectedAgent();
  const params = new URLSearchParams(useSearch());
  const traceRun = params.get("trace");
  // Compatibility for Board's saved handoff links and Overview's older run links.
  const handoffRun = params.get("handoff");
  const legacyRun = params.get("run");
  const detailRun = traceRun ?? legacyRun;

  const all = crew.data ? [...crew.data.rows].sort(compareRosterSeats) : null;
  const inView = all?.filter((r) => matchesSession(r)) ?? [];
  const crewSeats = inView.filter((r) => r.kind === "crew");
  const listed =
    all === null
      ? null
      : ((id !== null
          ? all.find((r) => r.id === id)
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

  useEffect(() => {
    if (!shownId || !all?.length) return;
    const move = (direction: 1 | -1) => {
      const at = all.findIndex((seat) => seat.id === shownId);
      const next = all[(at + direction + all.length) % all.length];
      if (next) navigate(agentPath(next.id));
    };
    setPageKey("j", () => move(1));
    setPageKey("k", () => move(-1));
    return () => {
      setPageKey("j", null);
      setPageKey("k", null);
    };
  }, [all, shownId]);

  let missing: string | null = null;
  if (crew.error && !crew.data) missing = "Could not load the crew.";
  else if (!crew.data) missing = "Loading…";
  else if (id !== null && !listed) missing = `No agent called ${id}.`;
  else if (!listed) missing = "No agents in this session.";
  else if (!row) missing = detail.error ? "Could not load this agent." : "Loading…";

  return (
    <section
      id="page-agent"
      className={`agent-v2${detailRun || handoffRun ? " agent-trace-page" : ""}`}
    >
      <h1 className="sr-only">Agents</h1>
      {handoffRun ? (
        <HandoffPanel runId={handoffRun} />
      ) : detailRun && id !== null ? (
        <RunTracePanel agentId={id} runId={detailRun} />
      ) : row ? (
        <div className="agent-control-room">
          <Picker rows={all ?? []} items={items} current={shownId} />
          <main className="agent-seat-workspace">
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
            <AgentIdentity view={detail.data as AgentDetailView} />
            <section
              className="panel agent-reserved-instruments"
              aria-label="Reserved instruments"
            />
            <StreamPanel key={`s:${row.id}`} row={row} tz={tz} />
          </main>
          <aside className="panel agent-reserved-right" aria-label="Reserved right column" />
        </div>
      ) : (
        <p
          className={
            (crew.error && !crew.data) || (detail.error && !row) ? "pb crit-t" : "pb muted"
          }
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
    </section>
  );
}
