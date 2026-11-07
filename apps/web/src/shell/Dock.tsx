import {
  type AgentStream,
  type AttentionItem,
  COMMS_CAPCOM,
  type CommsMessagesResponse,
  type Crew,
  flightTurnText,
} from "@mc/core";
import {
  type FormEvent,
  type KeyboardEvent,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiPost, errorNote } from "../api.ts";
import { useNeedsYou } from "../attention.ts";
import { useNow, useTz } from "../clock.ts";
import type { ComposerPrefill } from "../comms/model.ts";
import { Markdown } from "../components/Markdown.tsx";
import { isSendKey, SEND_HINT } from "../components/sendKey.ts";
import { contextPct, doingLine } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource, useReviewPrs } from "../data.ts";
import {
  COMMS_INBOX_HEADING,
  chatRows,
  type DockRow,
  dockRows,
  isInboxDelivery,
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
import { usePath, useSearch } from "../router.ts";
import { BuildChips } from "./buildStatus.tsx";
import { DockSummary } from "./DockSummary.tsx";
import { flyoutContext, stripContext, withContext } from "./flyoutContext.ts";
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

/** Where the newest operator message stands: stored (sent), taken up by FLIGHT (delivered), or kept until FLIGHT starts. */
export type SendState = "sent" | "delivered" | "waiting";

/** The line under the box: what happened to the last message, and what Start FLIGHT does. */
function StateLine({
  seat,
  loaded,
  loadFailed,
  last,
  onStart,
  starting,
}: {
  seat: FlightSeat | null;
  loaded: boolean;
  loadFailed: boolean;
  last: SendState | null;
  onStart: () => void;
  starting: boolean;
}) {
  const live = seat?.live === true;
  let words: string;
  if (!loaded && loadFailed)
    return (
      <div className="dstate" id="dockState" aria-live="polite">
        <span className="warn-t">Could not check FLIGHT, so Send waits. Your text is kept.</span>
        <button type="button" className="sm" onClick={() => hub.refetch(RESOURCES.flight.path)}>
          Retry
        </button>
      </div>
    );
  if (!loaded) words = "Checking FLIGHT… your text is kept.";
  else if (!seat) words = FLIGHT_NO_SEAT;
  else if (!live)
    words =
      last === "waiting"
        ? "Waiting: FLIGHT is stopped. Your message is saved and goes to FLIGHT when it starts."
        : "FLIGHT is stopped. A message is saved and goes to FLIGHT when it starts.";
  else if (last === "delivered") words = "Delivered to FLIGHT.";
  else if (last === "sent") words = "Sent. Waiting for FLIGHT to pick it up.";
  else words = SEND_HINT;
  return (
    <div className="dstate" id="dockState" aria-live="polite">
      <span className={!live && seat ? "warn-t" : "fg2"}>{words}</span>
      {seat && !live && (
        <button type="button" className="primary sm" disabled={starting} onClick={onStart}>
          Start FLIGHT
        </button>
      )}
    </div>
  );
}

/** The message box keeps its own text, so a keystroke re-renders this and nothing else in the dock. */
function Composer({
  seat,
  loaded,
  loadFailed,
  busy,
  err,
  onSend,
  last,
  onStart,
  starting,
  prefill,
  onPrefillConsumed,
}: {
  seat: FlightSeat | null;
  /** FLIGHT's state has arrived; until then the box takes text but Send waits. */
  loaded: boolean;
  /** FLIGHT's state could not be read, and none has arrived. */
  loadFailed: boolean;
  busy: boolean;
  err: string | null;
  onSend: (body: string, context: string | null) => Promise<boolean>;
  last: SendState | null;
  onStart: () => void;
  starting: boolean;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const used = useRef<number | null>(null);
  const path = usePath();
  const search = useSearch();
  const where = flyoutContext(path, search);
  // The chip follows the page until the operator removes it; a removed chip stays removed.
  const [chip, setChip] = useState(true);
  const canSend = loaded && seat !== null;
  const send = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const body = text.trim();
    if (!canSend || busy || body === "") return;
    if (await onSend(body, chip ? where : null)) setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSendKey(e)) return;
    e.preventDefault();
    void send();
  };
  useEffect(() => {
    if (!prefill || used.current === prefill.token) return;
    used.current = prefill.token;
    setText(prefill.text);
    input.current?.focus();
    onPrefillConsumed?.(prefill.token);
  }, [onPrefillConsumed, prefill]);
  return (
    <form className="composer" id="dockForm" onSubmit={(e) => void send(e)}>
      {chip ? (
        <span className="dchip" data-testid="dock-chip">
          <span className="dchip-label">On: {where}</span>
          <button
            type="button"
            className="dchip-x"
            aria-label={`Remove “On: ${where}” from the message`}
            title="Do not send where I am with this message"
            onClick={() => setChip(false)}
          >
            ×
          </button>
        </span>
      ) : (
        <button type="button" className="sm dchip-back" onClick={() => setChip(true)}>
          Add where I am: {where}
        </button>
      )}
      <textarea
        id="dockInput"
        ref={input}
        rows={3}
        autoComplete="off"
        aria-label="Message FLIGHT"
        aria-describedby="dockState"
        placeholder="Ask FLIGHT to assign, reprioritise or report…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="dsend">
        <StateLine
          seat={seat}
          loaded={loaded}
          loadFailed={loadFailed}
          last={last}
          onStart={onStart}
          starting={starting}
        />
        <button type="submit" className="primary" disabled={!canSend || busy || text.trim() === ""}>
          Send
        </button>
      </div>
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

/** The newest-first order of two rows by time; a row with no time keeps its place. */
const byTime = (a: DockRow, b: DockRow) => (a.at ?? 0) - (b.at ?? 0);

/**
 * FLIGHT's conversation, the same thread Comms shows: the stored messages between the operator and
 * FLIGHT, with FLIGHT's own turn text from its stream. The box takes text whatever FLIGHT's state;
 * the hub stores a message at once and hands it to FLIGHT when it is running.
 */
export function FlightChat({
  active = true,
  prefill,
  onPrefillConsumed,
  onStart,
  starting,
}: {
  active?: boolean;
  prefill?: ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
  onStart: () => void;
  starting: boolean;
}) {
  const msgs = useRef<HTMLDivElement>(null);
  const flightRes = useResource<FlightView>(RESOURCES.flight);
  const flight = flightRes.data;
  const seat = flight?.seat ?? null;
  const streamRef = seat ? RESOURCES.stream(seat.id) : null;
  const newest = useResource<AgentStream>(streamRef).data;
  const olderEvents = useOlderEvents(streamRef?.path ?? null, newest);
  const stream = olderEvents.stream;
  const tz = useTz();
  const stored = useResource<CommsMessagesResponse>(RESOURCES.commsFlight).data;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const stick = useRef(true);
  const streamRows = useMemo(() => (seat ? dockRows(stream, NO_DECISIONS) : []), [seat, stream]);
  const all = useMemo(() => {
    const thread: DockRow[] = (stored?.messages ?? []).map((m) =>
      m.from === COMMS_CAPCOM
        ? { kind: "you", id: `c:${m.id}`, at: m.at, text: stripContext(m.text) }
        : { kind: "flight", id: `c:${m.id}`, at: m.at, text: m.text },
    );
    // The stored thread is the record; a stream copy of something stored shows once.
    // The hub's inbox delivery to FLIGHT is a stream line of JSON, not something the operator said.
    const own = streamRows.filter(
      (r) =>
        (r.kind === "you" || r.kind === "flight") &&
        !(r.kind === "you" && isInboxDelivery(r.text)) &&
        !(r.kind === "you" && thread.some((t) => t.kind === "you" && sameMessage(r.text, t.text))),
    );
    return [...thread, ...own].sort(byTime);
  }, [stored, streamRows]);
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const sent = useRef(0);
  const { rows, open } = useMemo(() => withPending(all, pending), [all, pending]);
  const shown = useMemo(() => chatRows(rows), [rows]);
  // Settled messages leave the list, so it does not grow for ever.
  useEffect(() => {
    if (open.length !== pending.length) setPending(open);
  }, [open, pending]);

  // The newest operator message: stored (sent), taken up (delivered) or kept for a stopped FLIGHT.
  const lastStored = [...(stored?.messages ?? [])].reverse().find((m) => m.from === COMMS_CAPCOM);
  // Taken up: FLIGHT has seen the message or answered it. The hub hands an unlabelled message over
  // inside a wake or the start brief (a 'hub' line), a labelled one as a bare inbox line ('you'); both
  // carry the stored message's id in the inbox JSON. A reply from FLIGHT after it counts as well.
  const taken =
    lastStored !== undefined &&
    (streamRows.some(
      (r) =>
        (r.kind === "you" || r.kind === "hub") &&
        r.at !== null &&
        r.at >= lastStored.at &&
        r.text.includes(COMMS_INBOX_HEADING) &&
        r.text.includes(`"id":"${lastStored.id}"`),
    ) ||
      all.some((r) => r.kind === "flight" && r.at !== null && r.at > lastStored.at));
  const [justSent, setJustSent] = useState(false);
  // Only a message sent here gets a state line; older history says nothing about itself.
  const last: SendState | null = !justSent
    ? null
    : seat?.live !== true
      ? "waiting"
      : taken
        ? "delivered"
        : "sent";

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

  const send = async (body: string, context: string | null): Promise<boolean> => {
    if (!seat) return false;
    const id = `p:${sent.current++}`;
    const seen = all.flatMap((r) => (r.kind === "you" && sameMessage(r.text, body) ? [r.id] : []));
    stick.current = true;
    setPending((p) => [...p, { id, text: body, at: Date.now(), seen }]);
    setBusy(true);
    setErr(null);
    try {
      await apiPost(ACTIONS.commsSend, { to: seat.id, text: withContext(context, body) });
      setJustSent(true);
      hub.refetchTopic("agents");
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
      <DockSummary />
      <div
        className="dmsgs"
        id="dockMsgs"
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
        {shown.length === 0 && (
          <p className="note">
            {stored === undefined && flight === undefined
              ? "Loading the conversation…"
              : "No messages with FLIGHT yet."}
          </p>
        )}
        {shown.map((r) => (
          <Msg key={r.id} row={r} tz={tz} />
        ))}
      </div>
      <Composer
        seat={seat}
        loaded={flight !== undefined}
        loadFailed={flight === undefined && Boolean(flightRes.error)}
        busy={busy}
        err={err}
        onSend={send}
        last={last}
        onStart={onStart}
        starting={starting}
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
  const waitingItems = useResource<AttentionItem[]>(RESOURCES.attention);
  const waiting = useNeedsYou().length;
  const fold = () => setDockCollapsed(!collapsed);
  useReturnFocus(drawer);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  const flight = useResource<FlightView>(RESOURCES.flight).data;
  const seat = flight?.seat ?? null;
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
              aria-label={`Expand FLIGHT: ${waitingItems.data === undefined ? (waitingItems.error ? "waiting items unavailable" : "waiting items loading") : `${waiting} waiting on you${waitingItems.error ? ", last received count" : ""}`}`}
              aria-expanded="false"
              aria-controls="dockBody"
              onClick={fold}
            >
              <span className="dockrail-name">FLIGHT</span>
              <span className={waiting ? "warn-t" : "fg2"} aria-hidden="true">
                {waitingItems.data === undefined ? "…" : `◆ ${waiting}`}
              </span>
              <span className="dockrail-caption">
                {waitingItems.error
                  ? "Error"
                  : waitingItems.data === undefined
                    ? "Loading"
                    : "waiting"}
              </span>
            </button>
          </div>
          <div className="dh" id="dockHead">
            <h2 id="dockHeading" ref={heading} tabIndex={-1}>
              <AgentTag id="FLIGHT" index="flight" showRole />
            </h2>
            <BuildChips panel="dock" />
            <span className="spacer" />
            {collapsed && waiting > 0 && <Pill tone="warn">{`Waiting on you · ${waiting}`}</Pill>}
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
          {err !== null && (
            <p className="note err" role="alert">
              {err}
            </p>
          )}
          <div className="dockbody" id="dockBody">
            <FlightChat active={looking} onStart={() => void start()} starting={busy} />
          </div>
        </div>
      </aside>
    </>
  );
}
