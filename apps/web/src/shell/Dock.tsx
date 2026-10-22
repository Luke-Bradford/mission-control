import { type AgentStream, clockHm, FLIGHT_NOT_RUNNING } from "@mc/core";
import { type FormEvent, Fragment, useEffect, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useTz } from "../clock.ts";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import { type DockRow, dockRows, FLIGHT_KIND_LABEL } from "../flight/conversation.ts";
import type { FlightSeat, FlightView } from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { BuildChips } from "./buildStatus.tsx";
import { trapTab, useBuildStatus, useDock, useReturnFocus } from "./overlays.ts";

const CAPCOM = "@CAPCOM";

/** The seat's state in words. */
function stateWord(seat: FlightSeat): string {
  if (!seat.live) return "stopped";
  switch (seat.state) {
    case "idle":
      return "waiting for a wake";
    case "running":
    case "starting":
      return "working";
    case "parked":
      return "rate-limited";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

/** FLIGHT's words as text, with each @CAPCOM picked out. */
function FlightText({ text }: { text: string }) {
  const parts = text.split(CAPCOM);
  return (
    <>
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one string
        <Fragment key={i}>
          {i > 0 && <b className="capcom">{CAPCOM}</b>}
          {p}
        </Fragment>
      ))}
    </>
  );
}

function Msg({ row, tz }: { row: DockRow; tz: string | null }) {
  const at = row.at !== null && tz !== null ? clockHm(row.at, tz) : null;
  const sender =
    row.kind === "you"
      ? "You"
      : row.kind === "flight"
        ? "FLIGHT"
        : row.kind === "hub"
          ? "Mission Control"
          : `FLIGHT · ${FLIGHT_KIND_LABEL[row.d.kind]}`;
  return (
    <div className={`dmsg ${row.kind}`}>
      <div className="who">
        {sender}
        {at !== null && <span className="at"> · {at}</span>}
      </div>
      <div className="txt">
        {row.kind === "flight" ? (
          <FlightText text={row.text} />
        ) : row.kind === "decision" ? (
          `${row.d.about} → ${row.d.decision}`
        ) : (
          row.text
        )}
      </div>
    </div>
  );
}

/**
 * FLIGHT's dock (catalogue §1.4): a 380px column on wide screens, a drawer with a scrim below
 * 1200px. With no FLIGHT seat configured the conversation is empty and the input is switched off.
 */
export function Dock() {
  const { visible, wide, toggle } = useDock();
  const [buildOn] = useBuildStatus();
  const hide = useRef<HTMLButtonElement>(null);
  const msgs = useRef<HTMLDivElement>(null);
  const drawer = visible && !wide;
  useReturnFocus(drawer);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const tz = useTz();
  const rows = seat ? dockRows(stream, flight?.decisions ?? []) : [];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const count = rows.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when rows are added
  useEffect(() => {
    const el = msgs.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const fail = (e: unknown) => {
    const error = e instanceof Error ? e : new Error(String(e));
    setErr(errorNote(error) ?? error.message);
  };
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!seat?.live || body === "") return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatMessage(seat.id), { text: body });
      setText("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!seat) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatStart(seat.id), {});
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const live = seat?.live === true;
  return (
    <>
      {drawer && (
        <div className="dockscrim" data-testid="dock-scrim" onClick={toggle} aria-hidden="true" />
      )}
      <aside
        className="dock"
        id="dock"
        aria-label="FLIGHT"
        hidden={!visible}
        onKeyDown={drawer ? trapTab : undefined}
      >
        <div className="panel">
          <div className="dh" id="dockHead">
            <AgentTag id="FLIGHT" index="flight" />
            <Pill tone="neutral">Head agent</Pill>
            {!buildOn && <span className="phase">P2</span>}
            <BuildChips panel="dock" />
            <span className="spacer" />
            {seat && !live && (
              <button
                type="button"
                className="primary sm"
                disabled={busy}
                onClick={() => void start()}
              >
                Start FLIGHT
              </button>
            )}
            <button
              type="button"
              className="sm"
              ref={hide}
              title="Hide FLIGHT (f)"
              onClick={toggle}
            >
              Hide
            </button>
            <div className="meta">
              {seat ? `${seat.call} · ${seat.model} · ${stateWord(seat)}` : FLIGHT_NOT_RUNNING}
            </div>
          </div>
          <div
            className="dmsgs"
            id="dockMsgs"
            role="log"
            aria-label="Conversation with FLIGHT"
            ref={msgs}
          >
            {rows.map((r) => (
              <Msg key={r.id} row={r} tz={tz} />
            ))}
          </div>
          <form className="composer" id="dockForm" onSubmit={(e) => void send(e)}>
            <input
              id="dockInput"
              autoComplete="off"
              aria-label="Message FLIGHT"
              placeholder={
                !seat
                  ? "Ask FLIGHT to assign, reprioritise or report…"
                  : live
                    ? "Ask FLIGHT to assign, reprioritise or report…"
                    : "FLIGHT is stopped"
              }
              title={seat ? undefined : FLIGHT_NOT_RUNNING}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={!live}
            />
            <button
              type="submit"
              className="primary"
              title={seat ? undefined : FLIGHT_NOT_RUNNING}
              disabled={!live || busy}
            >
              Send
            </button>
            {err !== null && (
              <p className="note err" role="alert">
                {err}
              </p>
            )}
          </form>
        </div>
      </aside>
    </>
  );
}
