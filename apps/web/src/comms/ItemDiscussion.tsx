import {
  COMMS_CAPCOM,
  DISCUSSION_TEXT_MAX,
  type ItemDiscussion as Discussion,
  type ItemThread,
  type ItemThreadMessage,
} from "@mc/core";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { Markdown, OpenLinks } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { FlightStoppedNote } from "../flight/FlightStoppedNote.tsx";
import type { FlightSeat } from "../flight/flightTypes.ts";
import { hhmm } from "../fmt.ts";
import { askFlight } from "./answer.ts";
import { clearDraft, getDraft, setDraft } from "./drafts.ts";
import { BRIEF_FOLD_AFTER, BRIEF_LINES } from "./ItemBrief.tsx";

type Receipt = { id: string; text: string; note?: string };

type ItemDiscussionProps = {
  itemKey: string;
  /** Whether FLIGHT is running; undefined while that loads. The box takes focus only when it is. */
  live: boolean | undefined;
  /** FLIGHT's seat: undefined while it loads, null when none is configured. */
  seat?: FlightSeat | null;
  receipt?: Receipt;
  focus?: boolean;
  collapsed?: boolean;
  /** `page`: the whole conversation on the Needs you page, no fold, its log scrolling itself. */
  layout?: "panel" | "page";
};

/** A log this close to its end (px) follows new messages; further up it stays where it is read. */
export const FOLLOW_WITHIN = 40;

/** The text of an item reply without the `Re: <key> · <title>` line that tells FLIGHT the item. */
export function threadText(itemKey: string, text: string): string {
  if (!text.startsWith(`Re: ${itemKey}`)) return text;
  const cut = text.indexOf("\n\n");
  return cut === -1 ? "" : text.slice(cut + 2);
}

/** Who a thread message is from, in the operator's words. */
export function threadWho(m: Pick<ItemThreadMessage, "operator" | "from">): string {
  if (m.operator || m.from === COMMS_CAPCOM) return "You";
  return /^flight/i.test(m.from) ? "FLIGHT" : m.from.toUpperCase();
}

/** Whether the operator's message reached its reader, and whether anyone answered. */
export function threadState(m: ItemThreadMessage, tz: string | null): string | null {
  if (!m.operator || m.state === undefined) return null;
  const to = /^flight/i.test(m.to) ? "FLIGHT" : m.to.toUpperCase();
  if (m.state === "stored") return `Waiting for ${to} to pick it up`;
  const at = m.deliveredAt !== null && tz ? ` at ${hhmm(m.deliveredAt, tz)}` : "";
  return m.state === "answered" ? `${to} read it${at} and answered` : `${to} read it${at}`;
}

export function ItemDiscussion(p: ItemDiscussionProps) {
  if (p.layout === "page")
    return (
      <section className="item-conversation page" aria-label="Conversation with FLIGHT">
        <h3 className="bsec">Conversation with FLIGHT</h3>
        <DiscussionBody key={p.itemKey} {...p} focus={false} />
      </section>
    );
  return <Conversation key={p.itemKey} {...p} />;
}

function Conversation(p: ItemDiscussionProps) {
  const initialOpen = useRef(!p.collapsed || Boolean(p.receipt));
  const initialFocus = useRef(p.focus);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (p.receipt && details.current) details.current.open = true;
  }, [p.receipt]);
  return (
    <details ref={details} className="item-conversation" open={initialOpen.current}>
      <summary>Conversation with FLIGHT</summary>
      <DiscussionBody {...p} focus={initialFocus.current} />
    </details>
  );
}

function DiscussionBody({
  itemKey,
  live,
  seat,
  receipt,
  focus = false,
  layout = "panel",
}: {
  itemKey: string;
  live: boolean | undefined;
  seat?: FlightSeat | null;
  receipt?: Receipt;
  focus?: boolean;
  layout?: "panel" | "page";
}) {
  const page = layout === "page";
  // The panel's DOM ids stay; the page takes its own, so both can be mounted at once.
  const prefix = page ? "needs" : "ds";
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const initialFocus = useRef(focus && live !== false);
  useEffect(() => {
    let active = true;
    // Let the panel remember its opener before moving focus into the conversation.
    if (initialFocus.current && live)
      queueMicrotask(() => {
        if (active && input.current) {
          initialFocus.current = false;
          input.current.focus({ preventScroll: true });
          input.current.scrollIntoView?.({ block: "nearest" });
        }
      });
    return () => {
      active = false;
    };
  }, [live]);
  const tz = useTz();
  const thread = useResource<ItemThread>(RESOURCES.itemThread(itemKey));
  const sent = thread.data?.messages ?? [];
  const current = useResource<Discussion>(RESOURCES.discussion(itemKey));
  const resource = current.data ? RESOURCES.discussion(itemKey, current.data.id) : null;
  const history = useResource<Discussion>(resource);
  const discussion = history.data ?? current.data;
  const loadError = history.error ?? (!discussion ? current.error : null);
  const refresh = () => {
    hub.refetch(RESOURCES.itemThread(itemKey).path);
    hub.refetch(RESOURCES.discussion(itemKey).path);
    if (resource) hub.refetch(resource.path);
  };
  const [text, setTextState] = useState(() => getDraft("ask", itemKey));
  const setText = (value: string) => {
    setTextState(value);
    setDraft("ask", itemKey, value);
  };
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ text: string; version: string; id: string } | null>(null);
  const send = async () => {
    const body = text.trim();
    if (!body || !discussion || pending) return;
    const message =
      retry?.text === body && retry.version === discussion.version
        ? retry
        : { text: body, version: discussion.version, id: crypto.randomUUID() };
    setRetry(message);
    setPending(true);
    setError(null);
    try {
      await askFlight(itemKey, message.version, message.id, message.text);
      clearDraft("ask", itemKey);
      setTextState("");
      setRetry(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "server unreachable");
    } finally {
      setPending(false);
      if (resource) hub.refetch(resource.path);
    }
  };
  const count = (discussion?.messages.length ?? 0) + sent.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message is the cue to follow
  useLayoutEffect(() => {
    const el = log.current;
    if (page && el && following.current) el.scrollTop = el.scrollHeight;
  }, [page, count, receipt]);
  const onKey = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void send();
    }
  };
  return (
    <>
      <div
        ref={log}
        className={page ? "dmsgs needs-log" : "dmsgs"}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_WITHIN;
        }}
        id={`${prefix}Msgs`}
        role="log"
        aria-label="Item discussion"
        aria-busy={history.loading || pending}
      >
        {!discussion && !loadError && <p className="note">Loading discussion…</p>}
        {discussion?.messages.length === 0 && sent.length === 0 && !receipt && (
          <p className="note">No messages yet.</p>
        )}
        {[
          ...(discussion?.messages ?? [])
            .filter((m) => m.itemKey === itemKey && m.correlationId === discussion?.id)
            .map((m) => ({ ...m, state: null as string | null })),
          ...sent.map((m) => ({
            id: m.id,
            at: m.at,
            role: (m.operator ? "operator" : "flight") as "operator" | "flight",
            who: threadWho(m),
            text: threadText(itemKey, m.text),
            state: threadState(m, tz),
          })),
        ]
          .sort((a, b) => a.at - b.at)
          .map((m, i) => (
            <div className={`dmsg ${m.role === "operator" ? "you" : "flight"}`} key={m.id}>
              <span className="who">
                {"who" in m ? m.who : m.role === "operator" ? "You" : "FLIGHT"}
                {tz && <span className="when"> · {hhmm(m.at, tz)}</span>}
              </span>
              <div className="txt">
                {page ? (
                  m.role === "operator" ? (
                    m.text
                  ) : (
                    <OpenLinks>
                      <Markdown text={m.text} />
                    </OpenLinks>
                  )
                ) : (
                  <Expandable
                    lines={BRIEF_LINES}
                    foldAfter={BRIEF_FOLD_AFTER}
                    of={`${m.role === "operator" ? "Your" : "FLIGHT’s"} message ${i + 1}`}
                  >
                    {m.text}
                  </Expandable>
                )}
              </div>
              {m.state && (
                <p className="note" data-state>
                  {m.state}
                </p>
              )}
            </div>
          ))}
        {receipt &&
          !discussion?.messages.some(
            (m) =>
              m.id === receipt.id && m.itemKey === itemKey && m.correlationId === discussion.id,
          ) && (
            <div className="dmsg you">
              <span className="who">You</span>
              <div className="txt">
                <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER} of="Your answer">
                  {receipt.text}
                </Expandable>
              </div>
              {receipt.note && <p className="note">{receipt.note}</p>}
            </div>
          )}
        {loadError && (
          <p className="note err" role="alert">
            {loadError.message}
          </p>
        )}
        <button type="button" className="sm" onClick={refresh}>
          Refresh discussion
        </button>
      </div>
      <form
        className="composer"
        id={`${prefix}DiscussionForm`}
        onSubmit={(ev) => {
          ev.preventDefault();
          void send();
        }}
      >
        {page ? (
          <textarea
            ref={input}
            aria-label="Ask FLIGHT about this"
            placeholder="Ask FLIGHT about this… (Ctrl or ⌘ + Enter sends)"
            rows={3}
            maxLength={DISCUSSION_TEXT_MAX}
            value={text}
            disabled={pending}
            onKeyDown={onKey}
            onChange={(ev) => setText(ev.target.value)}
          />
        ) : (
          <input
            ref={input}
            aria-label="Ask FLIGHT about this"
            placeholder="Ask FLIGHT about this…"
            autoComplete="off"
            maxLength={DISCUSSION_TEXT_MAX}
            value={text}
            disabled={pending}
            onChange={(ev) => setText(ev.target.value)}
          />
        )}
        <button type="submit" className="primary" disabled={!discussion || pending || !text.trim()}>
          Ask FLIGHT
        </button>
        <FlightStoppedNote seat={seat} />
        {pending && (
          <span className="note" role="status">
            Sending…
          </span>
        )}
        {error && (
          <p className="note err" role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
