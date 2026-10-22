import { branchFor, type ConfigView, type Crew, ROLES } from "@mc/core";
import { useId, useState } from "react";
import { seatError } from "../agent/seat.ts";
import { apiPost } from "../api.ts";
import { callSign, hasActiveRun } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { agentPath, navigate } from "../router.ts";
import { toast } from "../shell/Toast.tsx";

const roleHere = (role: string): string => ROLES.find((r) => r.callSign === role)?.here ?? role;

/**
 * Start a seat on this ticket (Plan 5 Task 10): shown for an open issue in a repo that has a crew
 * session. The click is the approval; Mission Control makes the branch in its own clone and
 * pushes nothing.
 */
export function StartSeat({
  repoId,
  number,
  title,
}: {
  repoId: string;
  number: number;
  title: string;
}) {
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const label = useId();
  const [picked, setPicked] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const session = config?.crew?.sessions.find((s) => s.repoId === repoId);
  if (!session || !crew) return null;
  const free = session.seats.filter((seat) => {
    const row = crew.rows.find((r) => r.id === seat.id);
    return seat.mode !== "scratch" && (!row || !hasActiveRun(row));
  });
  const seat = free.find((s) => s.id === picked) ?? free[0];
  const call = seat ? callSign({ id: seat.id, kind: "crew" }) : "";

  const start = async () => {
    if (!seat) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.seatStart(seat.id), { issue: number });
      hub.refetch(RESOURCES.crew.path);
      toast(`${call} started on ${repoId}#${number}.`);
      navigate(agentPath(seat.id));
    } catch (e) {
      setError(seatError(e));
      setBusy(false);
    }
  };

  return (
    <section className="tsec" aria-labelledby={label}>
      <h3 id={label}>Start a seat</h3>
      {seat ? (
        <>
          <select
            aria-label="Seat"
            value={seat.id}
            onChange={(e) => setPicked(e.target.value)}
            disabled={busy}
          >
            {free.map((s) => (
              <option key={s.id} value={s.id}>
                {`${callSign({ id: s.id, kind: "crew" })} · ${roleHere(s.role)}`}
              </option>
            ))}
          </select>
          <p className="s">
            {`Mission Control makes branch ${branchFor(number, title)} in its own clone and starts ${call} on it. Nothing is pushed.`}
          </p>
          <p>
            <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
              {`Start ${call}`}
            </button>
          </p>
          {error && (
            <p className="crit-t s" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="s muted">{`Every seat in s/${session.id} is busy.`}</p>
      )}
    </section>
  );
}
