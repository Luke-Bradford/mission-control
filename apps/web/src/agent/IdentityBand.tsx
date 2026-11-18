import type { AgentDetailView, CrewRow } from "@mc/core";
import { useState } from "react";
import { useNow, useTz } from "../clock.ts";
import { callSign, modelLine, seatStatus, seatTurn } from "../crew.ts";
import { firstLine } from "../fmt.ts";
import { useRoleLabel } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { followLink, setupPath } from "../router.ts";
import { lastOutputText, silentFor, stoppedReason } from "./control.ts";
import { SeatMore } from "./Header.tsx";
import { Reason } from "./Reason.tsx";
import { shortAge } from "./roster.ts";
import { endConfirm, endSeat, interruptSeat, seatError } from "./seat.ts";

/** The most of the state reason the band shows before "read more". */
const REASON_MAX = 140;

/** A sent action's life: asked, taken by the hub, or refused with the hub's reason. */
type Outcome = { state: "sent" } | { state: "confirmed" } | { state: "failed"; reason: string };

/** Why a control cannot work, else null. */
export function actionBlock(
  row: CrewRow,
  action: "interrupt" | "stop" | "assign",
  connected: boolean,
): string | null {
  if (!connected) return "The hub is not connected.";
  if (row.kind !== "crew") return "An observed loop; Mission Control does not control it.";
  const turn = seatTurn(row);
  if (action === "interrupt" && turn !== "running") return "No turn is running to interrupt.";
  if (action === "stop" && turn === "none") return "There is no run to stop.";
  if (action === "assign" && turn === "running")
    return "Mid-turn: interrupt it, or wait for the turn to end.";
  return null;
}

const outcomeText = (name: string, o: Outcome | undefined): string | null =>
  !o
    ? null
    : o.state === "sent"
      ? `${name}: sent…`
      : o.state === "confirmed"
        ? `${name}: confirmed`
        : `${name} failed: ${o.reason}`;

function SeatActions({ row, connected }: { row: CrewRow; connected: boolean }) {
  const [outcome, setOutcome] = useState<{ name: string; o: Outcome } | undefined>();
  const run = async (name: string, fn: () => Promise<void>) => {
    setOutcome({ name, o: { state: "sent" } });
    try {
      await fn();
      setOutcome({ name, o: { state: "confirmed" } });
    } catch (e) {
      setOutcome({ name, o: { state: "failed", reason: seatError(e) } });
    }
  };
  const interruptBlock = actionBlock(row, "interrupt", connected);
  const stopBlock = actionBlock(row, "stop", connected);
  const assignBlock = actionBlock(row, "assign", connected);
  const text = outcome ? outcomeText(outcome.name, outcome.o) : null;
  return (
    <span className="idb-actions">
      {text && (
        <span
          className={`idb-outcome${outcome?.o.state === "failed" ? " crit-t" : ""}`}
          role={outcome?.o.state === "failed" ? "alert" : "status"}
        >
          {text}
        </span>
      )}
      <button
        type="button"
        className="sm"
        disabled={interruptBlock !== null}
        title={interruptBlock ?? "Stop the current turn"}
        onClick={() => void run("Interrupt", () => interruptSeat(row))}
      >
        Interrupt
      </button>
      {assignBlock ? (
        <button type="button" className="sm" disabled title={assignBlock}>
          Assign
        </button>
      ) : (
        <a
          className="btn sm"
          href={setupPath("sessions")}
          onClick={(e) => followLink(e, setupPath("sessions"))}
          title="Move this seat to another repo in Setup"
        >
          Assign
        </a>
      )}
      <SeatMore row={row} />
      <span className="idb-sep" aria-hidden="true" />
      <button
        type="button"
        className="sm warn"
        disabled={stopBlock !== null}
        title={stopBlock ?? "Stop this seat's run"}
        onClick={() => {
          if (window.confirm(endConfirm(row, true))) void run("Stop", () => endSeat(row, true));
        }}
      >
        Stop
      </button>
    </span>
  );
}

/** The chosen seat's identity: name and state, where it runs, its ticket, its own words, actions. */
export function IdentityBand({ view, connected }: { view: AgentDetailView; connected: boolean }) {
  const { row } = view;
  const now = useNow();
  const tz = useTz();
  const role = useRoleLabel(row.id);
  const status = seatStatus(row);
  const silent = silentFor(row, now);
  const stopped = stoppedReason(row, now, tz);
  const output = lastOutputText(row, now);
  const [more, setMore] = useState(false);
  const words = row.summary;
  const subagents = row.digest?.background.filter((b) => b.type === "local_agent").length ?? 0;
  return (
    <section className="panel idb" id="ahead" aria-label={`${row.id} details`}>
      <div className="idb-name">
        <i
          className="idb-dot"
          aria-hidden="true"
          style={{ background: `var(--seat-${(row.index % 7) + 1})` }}
        />
        <h2>{callSign(row)}</h2>
        {role.suffix !== null && <span className="idb-role">{role.suffix}</span>}
        {silent !== null ? (
          <Pill tone="warn" title={`No output for ${shortAge(silent)}`}>
            Silent · {shortAge(silent)}
          </Pill>
        ) : (
          <Pill tone={status.tone} title={status.reason}>
            {status.label} · {shortAge(Math.max(0, now - row.stateSince))}
          </Pill>
        )}
        {view.awaiting.reason && (
          <span className="idb-reason">
            <Reason
              line={firstLine(view.awaiting.reason).slice(0, REASON_MAX)}
              full={
                view.awaiting.reason === firstLine(view.awaiting.reason).slice(0, REASON_MAX)
                  ? null
                  : view.awaiting.reason
              }
            />
          </span>
        )}
        {output && <span className="idb-last">{output}</span>}
        {subagents > 0 && (
          <span className="idb-last">
            {subagents} helper {subagents === 1 ? "agent" : "agents"}
          </span>
        )}
        <SeatActions key={row.id} row={row} connected={connected} />
      </div>
      {stopped && (
        <p className="idb-stopped crit-t" role="status">
          Stopped: {stopped}
        </p>
      )}
      <p className="idb-strip">
        <span>{row.repoId}</span>
        <span>{modelLine(row)}</span>
        {row.cli.effort && <span>effort {row.cli.effort}</span>}
        {row.cli.version && <span>CLI {row.cli.version}</span>}
        <span>{row.accountId}</span>
        {row.run?.branch && <span className="mono">{row.run.branch}</span>}
      </p>
      <p className="idb-ticket">
        {row.ticket ? (
          <>
            {view.story.ticketHref ? (
              <a
                href={view.story.ticketHref}
                onClick={(e) => followLink(e, view.story.ticketHref ?? "/")}
              >
                {row.ticket}
              </a>
            ) : (
              <span>{row.ticket}</span>
            )}
            {row.prs[0] && <span className="mono"> PR #{row.prs[0].number}</span>}{" "}
            <b>{row.ticketTitle ?? ""}</b>
          </>
        ) : (
          <span className="muted">No ticket. Free to take the next Ready ticket in its area.</span>
        )}
      </p>
      {words && (
        <button
          type="button"
          className={`idb-words${more ? " open" : ""}`}
          aria-expanded={more}
          onClick={() => setMore(!more)}
          title={more ? "Show less" : "Show all"}
        >
          <span className="idb-words-h">In its words</span>
          {words}
        </button>
      )}
    </section>
  );
}
