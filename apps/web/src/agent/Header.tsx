import type { CrewRow, LimitRow } from "@mc/core";
import { type CSSProperties, useState } from "react";
import { useTz } from "../clock.ts";
import { PauseButton } from "../components/PauseButton.tsx";
import { callSign, modelLine, seatAreaText, seatStatus, seatTurn } from "../crew.ts";
import { useReviewPrs } from "../data.ts";
import { agentColor, useRoleLabel } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath } from "../router.ts";
import { BuildChips } from "../shell/buildStatus.tsx";
import { useIsPopout } from "../shell/popout.ts";
import { endConfirm, endSeat, interruptSeat, seatError } from "./seat.ts";
import { Tiles } from "./Tiles.tsx";

/** The agent in its own window (`?popout=1`: the Agent page alone), one window per agent. */
const popOut = (id: string): void => {
  window.open(`${agentPath(id)}?popout=1`, `mc-agent-${id}`, "popup,width=1200,height=820");
};

/** Interrupt and End the run for a crew seat with a live session. */
function SeatControls({ row }: { row: CrewRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turn = seatTurn(row);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(seatError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error && (
        <span className="crit-t s" role="alert">
          {error}
        </span>
      )}
      {turn === "running" && (
        <button
          type="button"
          className={row.hudState === "stalled" ? "sm warn" : "sm"}
          disabled={busy}
          onClick={() => run(() => interruptSeat(row))}
        >
          Interrupt
        </button>
      )}
      {turn !== "none" && (
        <button
          type="button"
          className="sm warn"
          disabled={busy}
          onClick={() => {
            if (window.confirm(endConfirm(row))) void run(() => endSeat(row));
          }}
        >
          End the run
        </button>
      )}
    </>
  );
}

/**
 * The agent's header (catalogue 2.4.3): id with its colour, state, chips, Pause/Resume for a TA
 * loop only (the loop is observed, so there are no other loop controls) and Pop out. Then the tiles.
 */
export function Header({ row, limits, now }: { row: CrewRow; limits: LimitRow[]; now: number }) {
  const branch = row.run?.branch ?? null;
  const tz = useTz();
  const repoPrs = useReviewPrs(row);
  const popout = useIsPopout();
  const role = useRoleLabel(row.id);
  return (
    <section className="panel ahead" id="ahead" aria-label={`${row.id} details`}>
      <div className="idrow">
        <span
          className="big"
          style={{ "--c": agentColor(row.index) } as CSSProperties}
          title={role.title}
        >
          <i aria-hidden="true" />
          {callSign(row)}
          {role.suffix !== null && <span className="rt">{` · ${role.suffix}`}</span>}
        </span>
        <Pill tone={seatStatus(row).tone}>{seatStatus(row).label}</Pill>
        <span className="chips">
          {row.kind === "crew" ? (
            <>
              <span>{row.role}</span>
              <span>{row.mode}</span>
              <span>s/{row.sessionId}</span>
            </>
          ) : (
            <>
              <span>observed loop · {row.loopKind}</span>
              <span>s/{row.repoId}</span>
            </>
          )}
          <span>
            {row.accountId} · {modelLine(row)}
          </span>
          {row.kind === "crew" && <span className="mono">area: {seatAreaText(row)}</span>}
          {branch !== null && <span className="mono">{branch}</span>}
        </span>
        <BuildChips panel="ahead" />
        <span className="ctl">
          {row.kind === "crew" && <SeatControls row={row} />}
          {row.loopKind === "ta-loop" && <PauseButton row={row} />}
          {!popout && (
            <button type="button" className="sm ghost" onClick={() => popOut(row.id)}>
              Pop out
            </button>
          )}
        </span>
      </div>
      <p className="s fg2 doing">
        <DoingLine row={row} now={now} tz={tz} repoPrs={repoPrs} />
      </p>
      {row.kind === "loop" && (
        <p className="s muted">Observed loop: Mission Control reads it and never drives it.</p>
      )}
      <Tiles row={row} limits={limits} now={now} />
    </section>
  );
}
