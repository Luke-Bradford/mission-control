import { COMMS_NOTICE, type ConfigView, type FlightConversationMessage } from "@mc/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { apiPost, errorNote } from "../api.ts";
import { useNoticeResource } from "../comms/model.ts";
import { linkRefs } from "../comms/refLinks.ts";
import { Markdown, OpenLinks } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
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
const LONDON = "Europe/London";

const failNote = (e: unknown): string => {
  const error = e instanceof Error ? e : new Error(String(e));
  return errorNote(error) ?? error.message;
};

/**
 * The one FLIGHT conversation: the fly-out and Comms both mount this. It reads the stored thread
 * (`GET /api/comms/flight`) and sends with `POST /api/comms`, so a message sent from one place is
 * in the other as soon as the thread is fetched again. The seat is read only to address the
 * message and to offer Start FLIGHT.
 */
export function FlightThread({
  id = FLIGHT_THREAD_INPUT,
  hideNotices = false,
}: {
  id?: string;
  /** Comms' "Hide hub notices" switch: the page is read without them and they are filtered out. */
  hideNotices?: boolean;
} = {}) {
  const res = useNoticeResource<Page>(RESOURCES.commsFlight, hideNotices);
  const seat = useResource<FlightView>(RESOURCES.flight).data?.seat;
  const config = useResource<ConfigView>(RESOURCES.config).data;
  const repo = config?.repos.length === 1 ? config.repos[0]?.id : undefined;
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const all = res.data?.messages ?? [];
  const messages = hideNotices ? all.filter((m) => m.kind !== COMMS_NOTICE) : all;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new messages while the reader is at the bottom
  useEffect(() => {
    const el = log.current;
    if (stick.current && el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
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
      await apiPost("/api/comms", { to: seat.id, text: body });
      setText("");
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
        {res.loading && !res.data && <p role="status">Loading messages…</p>}
        {res.error && !res.data && <p role="alert">Could not load messages.</p>}
        {!res.loading && res.data && messages.length === 0 && (
          <p className="note">No messages yet.</p>
        )}
        {messages.map((message) => (
          <article
            className={
              message.operator ? "flight-thread-message operator" : "flight-thread-message"
            }
            key={message.id}
          >
            <b>
              {message.operator ? "You" : "FLIGHT"}
              <span className="at">
                {" "}
                · <time>{message.at === null ? "—" : hhmm(message.at, LONDON)}</time>
              </span>
            </b>
            <div>
              {message.choice ? (
                `You chose: ${message.choice.label}`
              ) : (
                <OpenLinks>
                  <Markdown text={linkRefs(message.text, message.ticket, repo, config)} />
                </OpenLinks>
              )}
            </div>
          </article>
        ))}
        {run?.live && (
          <p role="status">
            FLIGHT is working… since {run.since === null ? "—" : hhmm(run.since, LONDON)}
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
          id={id}
          className="flight-thread-input"
          aria-label="Message FLIGHT"
          placeholder="Ask FLIGHT to assign, reprioritise or report…"
          rows={2}
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
