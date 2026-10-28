import {
  type AgentStream,
  ATTENTION_LABEL,
  type AttentionItem,
  type Crew,
  clockHm,
  flightTurnText,
} from "@mc/core";
import { type FormEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { needsYouItems, openNeedsYou, sortNeeds } from "../attention.ts";
import { useNow, useTz } from "../clock.ts";
import type { ComposerPrefill } from "../comms/model.ts";
import { Markdown } from "../components/Markdown.tsx";
import { contextPct, doingLine } from "../crew.ts";
import { ACTIONS, RESOURCES, useResource, useReviewPrs } from "../data.ts";
import {
  chatRows,
  type DockRow,
  dockRows,
  kindLabel,
  type PendingMsg,
  sameMessage,
  withPending,
} from "../flight/conversation.ts";
import {
  FLIGHT_NO_SEAT,
  type FlightDecision,
  type FlightSeat,
  type FlightView,
  flightOffText,
} from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Pill } from "../hud/Pill.tsx";
import { BuildChips } from "./buildStatus.tsx";
import { openItem, setFlightUnread, trapTab, useDock, useReturnFocus } from "./overlays.ts";

const CAPCOM = "@CAPCOM";

/** The dock shows no decisions: they are in the working log on the FLIGHT page. */
const NO_DECISIONS: FlightDecision[] = [];

/** The seat's state in words. */
export function stateWord(seat: FlightSeat): string {
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
  where,
  seat,
  busy,
  err,
  onSend,
  prefill,
  onPrefillConsumed,
}: {
  where: ChatPlace;
  seat: FlightSeat | null;
  busy: boolean;
  err: string | null;
  onSend: (body: string) => Promise<boolean>;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const used = useRef<number | null>(null);
  const live = seat?.live === true;
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!live || body === "") return;
    if (await onSend(body)) setText("");
  };
  useEffect(() => {
    if (!prefill || used.current === prefill.token) return;
    used.current = prefill.token;
    setText(prefill.text);
    input.current?.focus();
    onPrefillConsumed?.(prefill.token);
  }, [onPrefillConsumed, prefill]);
  return (
    <form className="composer" id={`${ID_PREFIX[where]}Form`} onSubmit={(e) => void send(e)}>
      <input
        id={`${ID_PREFIX[where]}Input`}
        ref={input}
        autoComplete="off"
        aria-label="Message FLIGHT"
        placeholder={
          !seat || live ? "Ask FLIGHT to assign, reprioritise or report…" : "FLIGHT is stopped"
        }
        title={live ? undefined : flightOffText(seat)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!live}
      />
      <button
        type="submit"
        className="primary"
        title={live ? undefined : flightOffText(seat)}
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

/** Where a FLIGHT conversation sits, which keeps its DOM ids unique: the dock, or Comms. */
export type ChatPlace = "dock" | "comms";

const ID_PREFIX: Record<ChatPlace, string> = { dock: "dock", comms: "chat" };

/**
 * FLIGHT's conversation: what is waiting on the operator (the whole Needs-you set, as the header
 * counts it), the message log and the message box. With no FLIGHT seat the log is empty and the
 * input is switched off; what waits on the operator still shows.
 */
export function FlightChat({
  where,
  prefill,
  onPrefillConsumed,
}: {
  where: ChatPlace;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const msgs = useRef<HTMLDivElement>(null);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const tz = useTz();
  const all = useMemo(() => (seat ? dockRows(stream, NO_DECISIONS) : []), [seat, stream]);
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const asks = useMemo(() => sortNeeds(needsYouItems(attention)), [attention]);
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sent = useRef(0);
  const stick = useRef(true);
  const { rows, open } = useMemo(() => withPending(all, pending), [all, pending]);
  const shown = useMemo(() => chatRows(rows), [rows]);
  // Settled messages leave the list, so it does not grow for ever.
  useEffect(() => {
    if (open.length !== pending.length) setPending(open);
  }, [open, pending]);

  const count = shown.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new rows and changes to the space available for them
  useEffect(() => {
    const el = msgs.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, asks.length]);
  const onScroll = () => {
    const el = msgs.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  };

  const send = async (body: string): Promise<boolean> => {
    if (!seat?.live) return false;
    const id = `p:${sent.current++}`;
    const seen = all.flatMap((r) => (r.kind === "you" && sameMessage(r.text, body) ? [r.id] : []));
    stick.current = true;
    setPending((p) => [...p, { id, text: body, at: Date.now(), seen }]);
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatMessage(seat.id), { text: body });
      return true;
    } catch (e) {
      setPending((p) => p.filter((m) => m.id !== id));
      setErr(failNote(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {asks.length > 0 && (
        <div className="dwait" id={`${ID_PREFIX[where]}Waiting`}>
          <div className="dwh">Waiting on you · {asks.length}</div>
          {asks.map((i) => {
            const agent = crew?.rows.find((r) => r.id === i.agentId);
            return (
              <div className="dask" key={i.key} data-testid="waiting-ask">
                <Pill tone={i.kind === "decision" ? "warn" : "plain"}>
                  {ATTENTION_LABEL[i.kind]}
                </Pill>
                <span className="min0 ellip" title={i.text}>
                  {i.text}
                </span>
                {agent ? <AgentTag bare sm id={agent.id} index={agent.index} /> : i.agentId}
                <span className="spacer" />
                <button
                  type="button"
                  className="sm"
                  // "FLIGHT is not triaging" lists its items on Needs you's home
                  onClick={() => (i.notTriaging ? openNeedsYou() : openItem(i.key))}
                >
                  {i.notTriaging ? "Show them" : "Open"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div
        className="dmsgs"
        id={`${ID_PREFIX[where]}Msgs`}
        role="log"
        aria-label="Conversation with FLIGHT"
        ref={msgs}
        onScroll={onScroll}
      >
        {shown.map((r) => (
          <Msg key={r.id} row={r} tz={tz} />
        ))}
      </div>
      <Composer
        where={where}
        seat={seat}
        busy={busy}
        err={err}
        onSend={send}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />
    </>
  );
}

const failNote = (e: unknown): string => {
  const error = e instanceof Error ? e : new Error(String(e));
  return errorNote(error) ?? error.message;
};

/**
 * FLIGHT's dock (catalogue §1.4): a 380px column on wide screens, a drawer with a scrim below
 * 1200px. With no FLIGHT seat configured the conversation is empty and the input is switched off.
 */
export function Dock() {
  const { visible, wide, toggle } = useDock();
  const hide = useRef<HTMLButtonElement>(null);
  const drawer = visible && !wide;
  useReturnFocus(drawer);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const row = crew?.rows.find((r) => r.id === seat?.id);
  const repoPrs = useReviewPrs(row);
  const ctx = row ? contextPct(row) : null;
  const now = useNow();
  const tz = useTz();
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const all = useMemo(() => (seat ? dockRows(stream, NO_DECISIONS) : []), [seat, stream]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The reply last seen with the dock shown; undefined until the stream first loads, so history is not "new".
  const replyIds = useMemo(
    () => chatRows(all).flatMap((r) => (r.kind === "flight" ? [r.id] : [])),
    [all],
  );
  const lastReply = replyIds.at(-1) ?? null;
  const [seenReply, setSeenReply] = useState<string | null | undefined>(undefined);
  const looking = visible;
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

  const start = async () => {
    if (!seat) return;
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.seatStart(seat.id), {});
    } catch (e) {
      setErr(failNote(e));
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
            <AgentTag id="FLIGHT" index="flight" showRole />
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
              {flight === undefined
                ? "Loading…"
                : seat
                  ? [
                      row?.accountId,
                      seat.model,
                      seat.turns && flightTurnText(seat.turns.n, seat.turns.max),
                      ctx !== null && `context ${Math.round(ctx)}%`,
                      row ? doingLine(row, now, tz, repoPrs) : stateWord(seat),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : FLIGHT_NO_SEAT}
            </div>
          </div>
          {err !== null && (
            <p className="note err" role="alert">
              {err}
            </p>
          )}
          <FlightChat where="dock" />
        </div>
      </aside>
    </>
  );
}
