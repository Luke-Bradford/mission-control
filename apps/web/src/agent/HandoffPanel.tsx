import { type RunHandoff, seatCallSign } from "@mc/core";
import { ApiError } from "../api.ts";
import { RESOURCES, useResource } from "../data.ts";
import { TicketRef } from "../hud/RepoRef.tsx";
import "./handoff.css";

function Lines({ lines, empty }: { lines: string[]; empty: string }) {
  return lines.length ? (
    <ul>
      {[...new Set(lines)].map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  ) : (
    <p className="note">{empty}</p>
  );
}

export function HandoffPanel({ runId }: { runId: string }) {
  const res = useResource<RunHandoff | null>(RESOURCES.runHandoff(runId));
  const h = res.data;
  if (res.error && !(res.error instanceof ApiError && res.error.status === 404))
    return (
      <p className="pb err" role="alert">
        Could not load the saved handoff: {res.error.message}
      </p>
    );
  if (!h) return null;
  return (
    <details className="agent-handoff panel" id="agent-handoff">
      <summary>
        <strong>Handed off from {seatCallSign(h.fromSeat)}</strong>
        <span>
          {h.ticket} ·{" "}
          {h.acceptedBy ? `taken by ${seatCallSign(h.acceptedBy)}` : "ready for the next seat"}
        </span>
      </summary>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the bounded saved note. */}
      <section className="handoff-body" aria-label="Saved ticket handoff" tabIndex={0}>
        <p>
          <TicketRef ticket={h.ticket} /> · <strong>Goal:</strong> {h.goal}
        </p>
        <p>
          <strong>Next step:</strong> {h.next}
        </p>
        <dl>
          <div>
            <dt>Branch</dt>
            <dd>
              <code>{h.branch}</code>
            </dd>
          </div>
          <div>
            <dt>Preserved worktree</dt>
            <dd>
              <code>{h.worktree ?? "Not available"}</code>
            </dd>
          </div>
        </dl>
        <h3>Recorded progress</h3>
        <Lines lines={h.done} empty="No completed work was recorded." />
        <h3>Left to do</h3>
        <Lines lines={h.left} empty="Check the ticket's remaining criteria." />
        <h3>Git status · {h.gitState}</h3>
        <Lines
          lines={h.gitStatus}
          empty={
            h.gitState === "ready"
              ? "Clean when recorded."
              : "Git status was unavailable; inspect the preserved worktree."
          }
        />
        <h3>Open review findings</h3>
        <Lines lines={h.findings} empty="None recorded." />
        <h3>Recent messages</h3>
        <Lines lines={h.messages.map((m) => `${m.from}: ${m.text}`)} empty="None recorded." />
      </section>
    </details>
  );
}
