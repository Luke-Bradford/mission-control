import type { CrewChanges, CrewRow, LimitRow } from "@mc/core";
import { type CSSProperties, useState } from "react";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { PauseButton } from "../components/PauseButton.tsx";
import { callSign, modelLine, seatAreaText, seatStatus, seatTurn } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource, useReviewPrs } from "../data.ts";
import { agentColor, useRoleLabel } from "../hud/AgentTag.tsx";
import { DoingLine } from "../hud/DoingLine.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath } from "../router.ts";
import { BuildChips } from "../shell/buildStatus.tsx";
import { useIsPopout } from "../shell/popout.ts";
import { toast } from "../shell/Toast.tsx";
import { endConfirm, endSeat, interruptSeat, seatError } from "./seat.ts";
import { Tiles } from "./Tiles.tsx";

/** The agent in its own window (`?popout=1`: the Agent page alone), one window per agent. */
const popOut = (id: string): void => {
  window.open(`${agentPath(id)}?popout=1`, `mc-agent-${id}`, "popup,width=1200,height=820");
};

/**
 * Interrupt and End the run for a crew seat with a live session. `interrupt` false leaves Interrupt
 * out, where the row's need line already carries one.
 */
export function SeatControls({
  row,
  interrupt = true,
  hold = false,
}: {
  row: CrewRow;
  interrupt?: boolean;
  hold?: boolean;
}) {
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
      {interrupt && turn === "running" && (
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
            if (window.confirm(endConfirm(row, hold))) void run(() => endSeat(row, hold));
          }}
        >
          {hold ? "Stop" : "End the run"}
        </button>
      )}
    </>
  );
}

/** Removal uses config.yaml's seat list, including changes that have not applied yet. */
function SeatSettings({ row }: { row: CrewRow }) {
  const removable = row.hudState === "idle" || row.hudState === "stopped";
  const changes = useResource<CrewChanges>(removable ? RESOURCES.crewChanges : null);
  const base = changes.data?.sessions.find((s) => s.id === row.sessionId)?.seats;
  const inConfig = base?.some((s) => s.id === row.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    if (!base || row.sessionId === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(ACTIONS.crewSeats(row.sessionId), {
        base,
        seats: base.filter((s) => s.id !== row.id),
      });
      toast(
        `${callSign(row)} removed from s/${row.sessionId}. Its area is freed when its run ends.`,
      );
    } catch (e) {
      setError(seatError(e));
    } finally {
      hub.refetch(RESOURCES.crewChanges.path);
      hub.refetch(RESOURCES.config.path);
      hub.refetch(RESOURCES.crew.path);
      setBusy(false);
    }
  };
  return (
    <>
      {(error || changes.error) && (
        <span className="crit-t s" role="alert">
          {error ?? changes.error?.message}
        </span>
      )}
      {removable && (
        <button
          type="button"
          className="sm"
          disabled={busy || !inConfig}
          onClick={() => {
            if (
              window.confirm(
                `Remove ${callSign(row)} from s/${row.sessionId}? Its area will be freed when its run ends.`,
              )
            )
              void remove();
          }}
        >
          Remove
        </button>
      )}
      {removable && changes.data && !inConfig && (
        <span className="s muted">Not in config.yaml</span>
      )}
      <button
        type="button"
        className="sm ghost"
        onClick={() =>
          toast(
            `Rename ${callSign(row)}: call signs are fixed. In Setup › Sessions, remove this seat and use Add agent to choose a new call sign.`,
          )
        }
      >
        Rename
      </button>
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
          {row.kind === "crew" && (
            <>
              <SeatControls key={`controls:${row.id}`} row={row} hold />
              <SeatSettings key={`settings:${row.id}`} row={row} />
            </>
          )}
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
