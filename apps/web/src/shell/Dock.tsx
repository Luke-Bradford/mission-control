import { type AgentStream, type CommsMessagesResponse, type CommsSendState, type Crew, flightTurnText } from "@mc/core";
import { type FormEvent, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useNow, useTz } from "../clock.ts";
import type { ComposerPrefill } from "../comms/model.ts";
import { Markdown } from "../components/Markdown.tsx";
import { contextPct, doingLine } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource, useReviewPrs } from "../data.ts";
import {
  chatRows,
  type DockRow,
  dockRows,
  kindLabel,
  messageStateLine,
  type PendingMsg,
  sameMessage,
  sendStateLine,
  withPending,
} from "../flight/conversation.ts";
import { FlightStoppedNote } from "../flight/FlightStoppedNote.tsx";
import {
  FLIGHT_NO_SEAT,
  type FlightDecision,
  type FlightSeat,
  type FlightView,
  flightOffText,
} from "../flight/flightTypes.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { BuildChips } from "./buildStatus.tsx";
import { DockSummary } from "./DockSummary.tsx";
import { useOlderEvents } from "./olderEvents.ts";
import {
  setDockCollapsed,
  setFlightUnread,
  toggleDock,
  trapTab,
  useDock,
  useOverlay,
  useReturnFocus,
} from "./overlays.ts";
import "./Dock.css";
import { hhmm, percent } from "../fmt.ts";

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
  const at = row.at !== null && tz !== null ? hhmm(row.at, tz) : null;
  const line = row.kind === "you" ? row.line : undefined;
  // A message still on its way says so until the hub answers; after that its state line takes over.
  const pending = row.kind === "you" && row.pending === true && line === undefined;
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
      {line !== undefined && (
        <div className="note" data-testid="message-state">
          {line}
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
  /** FLIGHT's seat: undefined while it loads, null when none is configured. */
  seat: FlightSeat | null | undefined;
  busy: boolean;
  err: string | null;
  onSend: (body: string) => Promise<boolean>;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const used = useRef<number | null>(null);
  // FLIGHT being stopped never blocks the operator: the hub keeps the message for its next start.
  const canSend = Boolean(seat);
  const send = async (ev: FormEvent) => {
    ev.preventDefault();
    const body = text.trim();
    if (!canSend || body === "") return;
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
        placeholder="Ask FLIGHT to assign, reprioritise or report…"
        title={canSend ? undefined : flightOffText(seat ?? null)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canSend}
      />
      <button
        type="submit"
        className="primary"
        title={canSend ? undefined : flightOffText(seat ?? null)}
        disabled={!canSend || busy}
      >
        Send
      </button>
      <FlightStoppedNote seat={seat} />
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
/** Scrolled this close to the top, the dock asks for the next older events. */
const LOAD_OLDER_PX = 40;

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
  active = true,
  prefill,
  onPrefillConsumed,
}: {
  where: ChatPlace;
  active?: boolean;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const msgs = useRef<HTMLDivElement>(null);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const streamRef = seat ? RESOURCES.stream(seat.id) : null;
  const newest = useResource<AgentStream>(streamRef).data;
  const olderEvents = useOlderEvents(streamRef?.path ?? null, newest);
  const stream = olderEvents.stream;
  const tz = useTz();
  const all = useMemo(() => (seat ? dockRows(stream, NO_DECISIONS) : []), [seat, stream]);
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const sent = useRef(0);
  const stick = useRef(true);
  const { rows, open } = useMemo(() => withPending(all, pending), [all, pending]);
  const flightComms = useResource<CommsMessagesResponse>(RESOURCES.commsFlight).data?.messages;
  const shown = useMemo(() => {
    const operator = flightComms?.filter((m) => m.operator) ?? [];
    return chatRows(rows).map((r): DockRow => {
      if (r.kind !== "you" || r.line !== undefined || tz === null) return r;
      // the newest message of the operator's with these words is the one this row shows
      const sent = operator.findLast((m) => sameMessage(r.text, m.text));
      return sent ? { ...r, line: messageStateLine(sent, flightComms ?? [], tz) } : r;
    });
  }, [rows, flightComms, tz]);
  // Settled messages leave the list, so it does not grow for ever.
  useEffect(() => {
    if (open.length !== pending.length) setPending(open);
  }, [open, pending]);

  const count = shown.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new rows and changes to the space available for them
  useEffect(() => {
    const el = msgs.current;
    if (active && el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count, active]);
  // Older events arrive above the reader: keep what they were reading where it was.
  const firstRow = shown[0]?.id;
  const heightBefore = useRef<{ first: string | undefined; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = msgs.current;
    const prev = heightBefore.current;
    heightBefore.current = { first: firstRow, height: el?.scrollHeight ?? 0 };
    if (el && prev && prev.first !== undefined && prev.first !== firstRow && !stick.current)
      el.scrollTop += el.scrollHeight - prev.height;
  }, [firstRow]);
  const { hasMore, loading, load } = olderEvents;
  const onScroll = () => {
    const el = msgs.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    if (el.scrollTop <= LOAD_OLDER_PX && hasMore && !loading) load();
  };

  const send = async (body: string): Promise<boolean> => {
    if (!seat) return false;
    const id = `p:${sent.current++}`;
    const seen = all.flatMap((r) => (r.kind === "you" && sameMessage(r.text, body) ? [r.id] : []));
    stick.current = true;
    setPending((p) => [...p, { id, text: body, at: Date.now(), seen }]);
    setBusy(true);
    setErr(null);
    try {
      const result = await apiPost<CommsSendState | undefined>(ACTIONS.seatMessage(seat.id), {
        text: body,
      });
      if (result?.state !== undefined && tz !== null) {
        const line = sendStateLine(result, tz);
        setPending((p) => p.map((m) => (m.id === id ? { ...m, line } : m)));
      }
      hub.refetch(RESOURCES.commsFlight.path);
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
      {where === "dock" && <DockSummary canMessage={seat !== null} />}
      <div
        className="dmsgs"
        id={`${ID_PREFIX[where]}Msgs`}
        role="log"
        aria-label="Conversation with FLIGHT"
        ref={msgs}
        onScroll={onScroll}
      >
        {hasMore && (
          <button type="button" className="sm dolder" disabled={loading} onClick={load}>
            {loading ? "Loading older…" : "Load older"}
          </button>
        )}
        {olderEvents.error && <p className="crit-t s">{olderEvents.error}</p>}
        {shown.map((r) => (
          <Msg key={r.id} row={r} tz={tz} />
        ))}
      </div>
      <Composer
        where={where}
        seat={flight === undefined ? undefined : seat}
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

/** Clock-dependent metadata stays separate from the summary, rail and mounted composer. */
function DockMeta({ flight }: { flight: FlightView | undefined }) {
  const seat = flight?.seat ?? null;
  const crew = useResource<Crew>(RESOURCES.crew).data;
  const row = crew?.rows.find((r) => r.id === seat?.id);
  const repoPrs = useReviewPrs(row);
  const ctx = row ? contextPct(row) : null;
  const now = useNow();
  const tz = useTz();
  return (
    <div className="meta">
      {flight === undefined
        ? "Loading…"
        : seat
          ? [
              row?.accountId,
              seat.model,
              seat.turns && flightTurnText(seat.turns.n, seat.turns.max),
              ctx !== null && `context ${percent(ctx)}`,
              row ? doingLine(row, now, tz, repoPrs) : stateWord(seat),
            ]
              .filter(Boolean)
              .join(" · ")
          : FLIGHT_NO_SEAT}
    </div>
  );
}

/**
 * FLIGHT's dock (catalogue §1.4): a 380px column on wide screens, a drawer with a scrim below
 * 1200px. With no FLIGHT seat configured the conversation is empty and the input is switched off.
 */
/** The widths with two columns and no room for FLIGHT beside them. Below, the Overview stacks. */
const OVERVIEW_COVER_QUERY = "(min-width: 1500px) and (max-width: 2199px)";

/** At those widths, FLIGHT on the Overview covers the side column so Crew keeps its width. */
export function useOverviewDockOverlay(overview: boolean, dock: ReturnType<typeof useDock>) {
  const [covers, setCovers] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(OVERVIEW_COVER_QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia(OVERVIEW_COVER_QUERY),
      update = () => setCovers(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return overview && dock.wide && dock.visible && !dock.collapsed && covers;
}

export function Dock({ coversPage = false }: { coversPage?: boolean } = {}) {
  const { visible, wide, collapsed, toggle } = useDock();
  // Esc folds the cover from anywhere on the page, and the page behind stays usable.
  useOverlay("overview-flight", coversPage, () => setDockCollapsed(true));
  const hide = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const drawer = visible && !wide;
  const fold = () => setDockCollapsed(!collapsed);
  useReturnFocus(drawer);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
  const stream = useResource<AgentStream>(seat ? RESOURCES.stream(seat.id) : null).data;
  const all = useMemo(() => (seat ? dockRows(stream, NO_DECISIONS) : []), [seat, stream]);

  // The reply last seen with the dock shown; undefined until the stream first loads, so history is not "new".
  const replyIds = useMemo(
    () => chatRows(all).flatMap((r) => (r.kind === "flight" ? [r.id] : [])),
    [all],
  );
  const lastReply = replyIds.at(-1) ?? null;
  const [seenReply, setSeenReply] = useState<string | null | undefined>(undefined);
  // A folded dock hides its replies, so they stay unread until it is expanded.
  const looking = visible && !collapsed;
  const wasLooking = useRef(looking);
  useLayoutEffect(() => {
    if (wide && looking && !wasLooking.current) heading.current?.focus();
    if (wide && visible && collapsed && wasLooking.current) rail.current?.focus();
    wasLooking.current = looking;
  }, [wide, visible, collapsed, looking]);
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

  return (
    <>
      {drawer && (
        <div className="dockscrim" data-testid="dock-scrim" onClick={toggle} aria-hidden="true" />
      )}
      <aside
        className={collapsed ? "dock collapsed" : "dock"}
        id="dock"
        aria-label="FLIGHT"
        hidden={!visible}
        onKeyDown={drawer ? trapTab : undefined}
      >
        <div className="panel">
          <div className="dockrail" hidden={!collapsed}>
            <button
              type="button"
              ref={rail}
              aria-label="Expand FLIGHT"
              aria-expanded="false"
              aria-controls="dockBody"
              onClick={fold}
            >
              <span className="dockrail-name">FLIGHT</span>
            </button>
          </div>
          <div className="dh" id="dockHead">
            <h2 id="dockHeading" ref={heading} tabIndex={-1}>
              <AgentTag id="FLIGHT" index="flight" showRole />
            </h2>
            <BuildChips panel="dock" />
            <span className="spacer" />
            {wide && !collapsed && (
              <button
                type="button"
                className="sm"
                aria-expanded={!collapsed}
                aria-controls="dockBody"
                title="Collapse FLIGHT to its rail"
                onClick={fold}
              >
                Collapse
              </button>
            )}
            <button
              type="button"
              className="sm"
              ref={hide}
              title="Hide FLIGHT (f)"
              onClick={() => toggleDock(false)}
            >
              Hide
            </button>
            <DockMeta flight={flight} />
          </div>
          <div className="dockbody" id="dockBody">
            <FlightChat where="dock" active={looking} />
          </div>
        </div>
      </aside>
    </>
  );
}
