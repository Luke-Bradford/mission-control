import {
  COMMS_MC,
  COMMS_MESSAGE_MAX,
  COMMS_NOTICE,
  type ConfigView,
  type FlightConversationMessage,
} from "@mc/core";
import { type KeyboardEvent, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useLocale, useTz } from "../clock.ts";
import { clearDraft, getDraft, setDraft } from "../comms/drafts.ts";
import { useNoticeResource } from "../comms/model.ts";
import type { OlderMessages } from "../comms/older.ts";
import { linkRefs } from "../comms/refLinks.ts";
import { Markdown, OpenLinks } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import { githubRepoOfUrl } from "../links.ts";
import { FlightStoppedNote } from "./FlightStoppedNote.tsx";
import type { FlightView } from "./flightTypes.ts";
import "./FlightThread.css";

/** What `GET /api/comms/flight` returns; `flight` is the run state, when the server sends it. */
type Page = {
  messages: FlightConversationMessage[];
  flight?: { live: boolean; since: number | null; runId: string | null };
};

/** The id the message box carries, so `f` can find it where the thread is on screen. */
export const FLIGHT_THREAD_INPUT = "flightThreadInput";
/** Within this many pixels of the bottom the log follows new messages; further up it stays put. */
const STICK_PX = 40;

/** Who a line is from: the operator, the hub's own notices, or FLIGHT. */
const senderWord = (m: FlightConversationMessage): string =>
  m.operator
    ? "You"
    : m.from === COMMS_MC || m.kind === COMMS_NOTICE
      ? "Mission Control"
      : "FLIGHT";

const failNote = (e: unknown): string => {
  const error = e instanceof Error ? e : new Error(String(e));
  return errorNote(error) ?? error.message;
};

/** Only a pull request in a configured repo shows as its text alone; any other link keeps its host. */
const repoPullUrl =
  (config: ConfigView | undefined) =>
  (url: string): boolean => {
    const repoOf = githubRepoOfUrl(url);
    return (
      repoOf !== null &&
      /\/pull\/\d+$/.test(url) &&
      (config?.repos.some((r) => r.github.toLowerCase() === repoOf.toLowerCase()) ?? false)
    );
  };

/**
 * One line of the thread. Memoised: typing in the composer re-renders the thread, and every
 * message would otherwise be parsed as Markdown again on each keystroke.
 */
const ThreadMessage = memo(function ThreadMessage({
  message,
  highlighted,
  repo,
  config,
  tz,
  locale,
}: {
  message: FlightConversationMessage;
  highlighted: boolean;
  repo: string | undefined;
  config: ConfigView | undefined;
  tz: string | null;
  locale: string;
}) {
  return (
    <article
      className={`flight-thread-message${message.operator ? " operator" : ""}${highlighted ? " highlighted" : ""}`}
      data-message-id={message.id}
    >
      <b>
        {senderWord(message)}
        <span className="at">
          {" "}
          · <time>{message.at === null || !tz ? "—" : hhmm(message.at, tz, locale)}</time>
        </span>
      </b>
      <div>
        {message.choice ? (
          `You chose: ${message.choice.label}`
        ) : (
          <OpenLinks hostHidden={repoPullUrl(config)}>
            <Markdown text={linkRefs(message.text, message.ticket, repo, config)} />
          </OpenLinks>
        )}
      </div>
    </article>
  );
});

/**
 * The one FLIGHT conversation: the fly-out and Comms both mount this. It reads the stored thread
 * (`GET /api/comms/flight`) and sends with `POST /api/comms`, so a message sent from one place is
 * in the other as soon as the thread is fetched again. The seat is read only to address the
 * message and to offer Start FLIGHT.
 */
export function FlightThread({
  id = FLIGHT_THREAD_INPUT,
  hideNotices = false,
  older,
  jumpId = null,
  onJumped,
  itemKey,
  about,
  openRequest = 0,
}: {
  id?: string;
  /** The Needs-you question this thread sits beside: sends carry it, so FLIGHT knows what they are about. */
  itemKey?: string;
  /** That question's title, shown as the `About:` heading. */
  about?: string;
  /** Bumped by an item's Discuss control: moves focus to this conversation's composer. */
  openRequest?: number;
  /** Comms' "Hide hub notices" switch: the page is read without them and they are filtered out. */
  hideNotices?: boolean;
  /** Older pages the route has not sent: Comms passes them in, with a "Load older" control. */
  older?: OlderMessages;
  /** A message to scroll to and highlight (from the mentions bell), cleared through `onJumped`. */
  jumpId?: string | null;
  onJumped?: () => void;
} = {}) {
  const res = useNoticeResource<Page>(RESOURCES.commsFlight, hideNotices);
  const seat = useResource<FlightView>(RESOURCES.flight).data?.seat;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const tz = useTz();
  const locale = useLocale();
  const repo = config?.repos.length === 1 ? config.repos[0]?.id : undefined;
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Beside a question the unsent text is kept per item, so opening another question does not lose it.
  const [text, setTextState] = useState(() =>
    itemKey === undefined ? "" : getDraft("ask", itemKey),
  );
  const setText = (value: string) => {
    setTextState(value);
    if (itemKey !== undefined) setDraft("ask", itemKey, value);
  };
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (openRequest > 0) input.current?.focus();
  }, [openRequest]);
  const all = older?.messages ?? res.data?.messages ?? [];
  const messages = hideNotices ? all.filter((m) => m.kind !== COMMS_NOTICE) : all;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new messages while the reader is at the bottom
  useEffect(() => {
    const el = log.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  const [highlightId, setHighlightId] = useState(jumpId);
  const onJumpedRef = useRef(onJumped);
  onJumpedRef.current = onJumped;
  const loaded = res.data !== undefined;
  useLayoutEffect(() => {
    if (!jumpId || !loaded) return;
    const target = Array.from(
      log.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [],
    ).find((el) => el.dataset.messageId === jumpId);
    if (target) {
      setHighlightId(jumpId);
      target.scrollIntoView?.({ block: "center" });
      stick.current = jumpId === messages.at(-1)?.id;
    }
    // Found or not, the jump is spent: a stale one must not reach another view.
    onJumpedRef.current?.();
  }, [jumpId, loaded, messages]);
  // Older messages arrive above the reader: keep the message they were reading where it was.
  const firstId = messages[0]?.id;
  const before = useRef<{ firstId: string | undefined; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = log.current;
    const prev = before.current;
    before.current = { firstId, height: el?.scrollHeight ?? 0 };
    if (el && prev && prev.firstId !== undefined && prev.firstId !== firstId && !stick.current)
      el.scrollTop += el.scrollHeight - prev.height;
  }, [firstId]);
  // A thread that was hidden (a folded fly-out) opens at the newest message, as one that is open does.
  useEffect(() => {
    const el = log.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const run = res.data?.flight;

  const send = async () => {
    const body = text.trim();
    if (body === "" || !seat || busy) return;
    stick.current = true;
    setBusy(true);
    setErr(null);
    try {
      await apiPost("/api/comms", {
        to: seat.id,
        text: body,
        ...(itemKey === undefined ? {} : { itemKey }),
      });
      if (itemKey !== undefined) clearDraft("ask", itemKey);
      setTextState("");
      hub.refetchTopic("agents");
    } catch (e) {
      setErr(failNote(e));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.nativeEvent.isComposing) return;
    ev.preventDefault();
    void send();
  };

  return (
    <section className="flight-thread" aria-label="Conversation with FLIGHT">
      {itemKey !== undefined && (
        <h3 className="bsec flight-thread-about">
          About: {about === undefined || about.trim() === "" ? itemKey : about}
        </h3>
      )}
      <div
        className="flight-thread-log"
        role="log"
        aria-label="Messages with FLIGHT"
        ref={log}
        onScroll={() => {
          const el = log.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
        }}
      >
        {older?.hasMore && (
          <button
            type="button"
            className="sm flight-thread-older"
            disabled={older.loading}
            onClick={older.load}
          >
            {older.loading ? "Loading older…" : "Load older"}
          </button>
        )}
        {older?.error && (
          <p className="crit-t s" role="alert">
            {older.error}
          </p>
        )}
        {res.loading && !res.data && <p role="status">Loading messages…</p>}
        {res.error && !res.data && <p role="alert">Could not load messages.</p>}
        {!res.loading && res.data && messages.length === 0 && (
          <p className="note">No messages yet.</p>
        )}
        {messages.map((message) => (
          <ThreadMessage
            key={message.id}
            message={message}
            highlighted={highlightId === message.id}
            repo={repo}
            config={config}
            tz={tz}
            locale={locale}
          />
        ))}
        {run?.live && (
          <p role="status">
            {/* The hub sends the session's start, not the current turn's, so it says so. */}
            FLIGHT's session is running · started{" "}
            {run.since === null || !tz ? "—" : hhmm(run.since, tz, locale)}
          </p>
        )}
      </div>
      <form
        className="flight-thread-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          id={id}
          className="flight-thread-input"
          aria-label="Message FLIGHT"
          placeholder="Ask FLIGHT to assign, reprioritise or report…"
          rows={2}
          maxLength={COMMS_MESSAGE_MAX}
          value={text}
          disabled={!seat}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className="primary" disabled={!seat || busy || text.trim() === ""}>
          Send
        </button>
        <FlightStoppedNote seat={seat} />
        {err !== null && (
          <p className="note err" role="alert">
            {err}{" "}
            <button type="button" className="sm" onClick={() => void send()}>
              Retry
            </button>
          </p>
        )}
      </form>
    </section>
  );
}
