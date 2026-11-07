import { DISCUSSION_TEXT_MAX, type ItemDiscussion as Discussion } from "@mc/core";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Expandable } from "../components/Expandable.tsx";
import { Markdown, OpenLinks } from "../components/Markdown.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { askFlight } from "./answer.ts";
import { clearDraft, getDraft, setDraft } from "./drafts.ts";
import { BRIEF_FOLD_AFTER, BRIEF_LINES } from "./ItemBrief.tsx";

type Receipt = { id: string; text: string; note?: string };

type ItemDiscussionProps = {
  itemKey: string;
  live: boolean | undefined;
  title?: string;
  receipt?: Receipt;
  focus?: boolean;
  collapsed?: boolean;
  /** `page`: the whole conversation on the Needs you page, no fold, its log scrolling itself. */
  layout?: "panel" | "page";
};

/** A log this close to its end (px) follows new messages; further up it stays where it is read. */
export const FOLLOW_WITHIN = 40;

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
  title,
  receipt,
  focus = false,
  layout = "panel",
}: {
  itemKey: string;
  live: boolean | undefined;
  title?: string;
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
  const current = useResource<Discussion>(RESOURCES.discussion(itemKey));
  const resource = current.data ? RESOURCES.discussion(itemKey, current.data.id) : null;
  const history = useResource<Discussion>(resource);
  const discussion = history.data ?? current.data;
  const loadError = history.error ?? (!discussion ? current.error : null);
  const refresh = () => {
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
    if (!body || !discussion || !live || pending) return;
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
  const count = discussion?.messages.length ?? 0;
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
        {discussion?.messages.length === 0 && !receipt && <p className="note">No messages yet.</p>}
        {discussion?.messages
          .filter((m) => m.itemKey === itemKey && m.correlationId === discussion?.id)
          .map((m, i) => (
            <div className={`dmsg ${m.role === "operator" ? "you" : "flight"}`} key={m.id}>
              <span className="who">{m.role === "operator" ? "You" : "FLIGHT"}</span>
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
            disabled={!live || pending}
            title={title}
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
            disabled={!live || pending}
            title={title}
            onChange={(ev) => setText(ev.target.value)}
          />
        )}
        <button
          type="submit"
          className="primary"
          disabled={!live || !discussion || pending || !text.trim()}
          title={title}
        >
          Ask FLIGHT
        </button>
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
