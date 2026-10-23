import { type AgentStream, clockHm, FLIGHT_NOT_RUNNING } from "@mc/core";
import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useTz } from "../clock.ts";
import { Markdown } from "../components/Markdown.tsx";
import { ACTIONS, RESOURCES, useResource } from "../data.ts";
import {
  chatRows,
  type DockRow,
  dockRows,
  feedRows,
  kindLabel,
  type PendingMsg,
  sameMessage,
  withPending,
} from "../flight/conversation.ts";
import type { FlightSeat, FlightView } from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { BuildChips } from "./buildStatus.tsx";
import {
  setDockTab,
  setFlightUnread,
  trapTab,
  useBuildStatus,
  useDock,
  useDockTab,
  useReturnFocus,
} from "./overlays.ts";

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

/** FLIGHT's words as Markdown, with each @CAPCOM made bold. */
const flightMarkdown = (text: string): string => text.split(CAPCOM).join(`**${CAPCOM}**`);

const Msg = memo(function Msg({ row, tz }: { row: DockRow; tz: string | null }) {
  const at = row.at !== null && tz !== null ? clockHm(row.at, tz) : null;
  const pending = row.kind === "you" && row.pending === true;
  const sender =
    row.kind === "you"
      ? "You"
      : row.kind === "flight"
        ? "FLIGHT"
        : row.kind === "hub"
          ? "Mission Control"
          : `FLIGHT · ${kindLabel(row.d.kind)}`;
  return (
    <div className={`dmsg ${row.kind}${pending ? " pending" : ""}`}>
      <div className="who">
        {sender}
        {pending ? (
          <span className="at"> · pending</span>
        ) : (
          at !== null && <span className="at"> · {at}</span>
        )}
      </div>
      {row.kind === "flight" ? (
        <div className="txt md-txt">
          <Markdown text={flightMarkdown(row.text)} />
        </div>
      ) : (
        <div className="txt">
          {row.kind === "decision" ? `${row.d.about} → ${row.d.decision}` : row.text}
        </div>
      )}
    </div>
  );
});

/** The message box keeps its own text, so a keystroke re-renders this and nothing else in the dock. */
function Composer({
  seat,
  busy,
  err,
  onSend,
}: {
  seat: FlightSeat | null;
  busy: boolean;
  err: string | null;
  onSend: (body: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const live = seat?.live === true;
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!live || body === "") return;
    if (await onSend(body)) setText("");
  };
  return (
    <form className="composer" id="dockForm" onSubmit={(e) => void send(e)}>
      <input
        id="dockInput"
        autoComplete="off"
        aria-label="Message FLIGHT"
        placeholder={
          !seat || live ? "Ask FLIGHT to assign, reprioritise or report…" : "FLIGHT is stopped"
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
  );
}

/** Within this many pixels of the bottom the log follows new messages; further up it stays put. */
const STICK_PX = 40;

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
  const decisions = flight?.decisions;
  const all = useMemo(
    () => (seat ? dockRows(stream, decisions ?? []) : []),
    [seat, stream, decisions],
  );
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const tab = useDockTab();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sent = useRef(0);
  const stick = useRef(true);
  const { rows, open } = useMemo(() => withPending(all, pending), [all, pending]);
  const shown = useMemo(() => (tab === "chat" ? chatRows(rows) : feedRows(rows)), [rows, tab]);
  // Settled messages leave the list, so it does not grow for ever.
  useEffect(() => {
    if (open.length !== pending.length) setPending(open);
  }, [open, pending]);

  // The reply last seen on Chat; undefined until the stream first loads, so history is not "new".
  const replyIds = useMemo(
    () => chatRows(all).flatMap((r) => (r.kind === "flight" ? [r.id] : [])),
    [all],
  );
  const lastReply = replyIds.at(-1) ?? null;
  const [seenReply, setSeenReply] = useState<string | null | undefined>(undefined);
  const looking = visible && tab === "chat";
  useEffect(() => {
    if (stream === undefined) return;
    if (seenReply === undefined || looking) setSeenReply(lastReply);
  }, [stream, seenReply, looking, lastReply]);
  const unread =
    seenReply === undefined
      ? 0
      : seenReply === null || !replyIds.includes(seenReply)
        ? replyIds.length
        : replyIds.length - 1 - replyIds.indexOf(seenReply);
  useEffect(() => {
    setFlightUnread(unread);
    return () => setFlightUnread(0);
  }, [unread]);

  const count = shown.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new rows, and a tab change
  useEffect(() => {
    const el = msgs.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, tab]);
  const onScroll = () => {
    const el = msgs.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  const fail = (e: unknown) => {
    const error = e instanceof Error ? e : new Error(String(e));
    setErr(errorNote(error) ?? error.message);
  };
  const send = async (body: string): Promise<boolean> => {
    if (!seat?.live) return false;
    const id = `p:${sent.current++}`;
    const seen = all.filter((r) => r.kind === "you" && sameMessage(r.text, body)).length;
    stick.current = true;
    setPending((p) => [...p, { id, text: body, at: Date.now(), seen }]);
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatMessage(seat.id), { text: body });
      return true;
    } catch (e) {
      setPending((p) => p.filter((m) => m.id !== id));
      fail(e);
      return false;
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
          <div className="dtabs" role="tablist" aria-label="FLIGHT dock">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "chat"}
              className={tab === "chat" ? "on" : undefined}
              onClick={() => setDockTab("chat")}
            >
              Chat
              {unread > 0 && (
                <span className="dock-unread" data-testid="chat-unread">
                  {unread}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "feed"}
              className={tab === "feed" ? "on" : undefined}
              onClick={() => setDockTab("feed")}
            >
              Feed
            </button>
          </div>
          <div
            className="dmsgs"
            id="dockMsgs"
            role="log"
            aria-label="Conversation with FLIGHT"
            ref={msgs}
            onScroll={onScroll}
          >
            {shown.map((r) => (
              <Msg key={r.id} row={r} tz={tz} />
            ))}
          </div>
          <Composer seat={seat} busy={busy} err={err} onSend={send} />
        </div>
      </aside>
    </>
  );
}
