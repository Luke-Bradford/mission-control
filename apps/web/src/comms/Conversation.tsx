import {
  COMMS_CAPCOM,
  COMMS_CREW,
  type CommsAgentResponse,
  type CommsMention,
  type CommsMessage,
  type CommsMessagesResponse,
  type CommsPinsResponse,
  type CommsReactionKind,
  type CommsTicketResponse,
  type CrewRow,
  type FlightView,
} from "@mc/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiDelete, apiPost, apiPut } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import {
  commsAgentPath,
  commsContactPath,
  commsFlightPath,
  commsInboxPath,
  commsTicketPath,
  followLink,
  navigate,
  ticketPath,
} from "../router.ts";
import { CommsEnd, MentionText } from "./messages.tsx";
import { type CommsView, ticketForRef } from "./model.ts";

type OpenMessage = (view: CommsView, messageId: string) => void;

/** The mentions list keeps this much clear of the conversation panel's bottom edge. */
const MENTIONS_GAP_PX = 8;
/** However short the window, the mentions list keeps room for about two entries. */
const MENTIONS_MIN_PX = 120;

/** A message's time; one from an earlier day carries its date, so old traffic never reads as today's. */
const time = (at: number) => {
  const date = new Date(at);
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString()
    ? clock
    : `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}`;
};

function scopeFor(view: CommsView): string | null {
  if (view.kind === "crew") return "crew";
  if (view.kind === "flight") return "flight";
  if (view.kind === "agent") return `agent-all:${view.agentId}`;
  if (view.kind === "inbox") return `inbox:${view.agentId}`;
  if (view.kind === "contact") return `pair:${[view.agentId, view.contactId].sort().join(":")}`;
  return null;
}

function viewForMessage(message: CommsMessage, flightId: string | undefined): CommsView {
  if (message.from === COMMS_CREW || message.to === COMMS_CREW) return { kind: "crew" };
  if (
    flightId !== undefined &&
    [message.from, message.to].includes(COMMS_CAPCOM) &&
    [message.from, message.to].includes(flightId)
  )
    return { kind: "flight" };
  return {
    kind: "contact",
    agentId: message.from === COMMS_CAPCOM ? message.to : message.from,
    contactId: message.from === COMMS_CAPCOM ? message.from : message.to,
  };
}

function MessageRefs({ text, ticket }: { text: string; ticket: string | null }) {
  const parts = text.split(/(\bPR \d+\b|(?<!\w)#\d+\b)/g);
  const occurrences = new Map<string, number>();
  return (
    <>
      {parts.map((part) => {
        const n = occurrences.get(part) ?? 0;
        occurrences.set(part, n + 1);
        const key = `${part}:${n}`;
        return /^(?:PR \d+|#\d+)$/.test(part) ? (
          <button
            className="comms-ref"
            key={key}
            type="button"
            onClick={() => navigate(commsTicketPath(part, ticketForRef(part, ticket)))}
          >
            {part}
          </button>
        ) : (
          <MentionText key={key} text={part} />
        );
      })}
    </>
  );
}

function Breadcrumb({ view }: { view: CommsView }) {
  const parts =
    view.kind === "flight"
      ? ["Comms", "FLIGHT ↔ CAPCOM"]
      : view.kind === "crew"
        ? ["Comms", "#crew"]
        : view.kind === "ticket"
          ? ["Comms", view.ref]
          : view.kind === "contact"
            ? ["Comms", "Agents", view.agentId, view.contactId]
            : view.kind === "inbox"
              ? ["Comms", "Agents", view.agentId, "Inbox"]
              : ["Comms", "Agents", view.agentId];
  return (
    <nav className="comms-breadcrumb" aria-label="Breadcrumb">
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 && <i aria-hidden="true">›</i>}
          {index === 0 ? (
            <button type="button" onClick={() => navigate(commsFlightPath())}>
              {part}
            </button>
          ) : (
            part
          )}
        </span>
      ))}
    </nav>
  );
}

function conversationHint(view: CommsView): string {
  if (view.kind === "flight") return "FLIGHT reports and asks here; you direct it";
  if (view.kind === "crew") return "Crew messages and handoffs";
  if (view.kind === "ticket") return `Every message about ${view.ref}`;
  return "Direct messages and handoffs";
}

function MessageActions({ message, onReply }: { message: CommsMessage; onReply: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const react = (reaction: CommsReactionKind) => {
    const reason = reaction === "cant" ? window.prompt("Why can't you?")?.trim() : undefined;
    if (reaction === "cant" && !reason) return;
    void apiPost(`/api/comms/${encodeURIComponent(message.id)}/reactions`, { reaction, reason })
      .then(() => hub.refetchTopic("agents"))
      .catch(() => setError("Could not add reaction."));
  };
  const pin = () => {
    const call = message.pinned ? apiDelete : apiPut;
    void call(`/api/comms/${encodeURIComponent(message.id)}/pin`, {})
      .then(() => hub.refetchTopic("agents"))
      .catch(() => setError("Could not change pin."));
  };
  return (
    <span className="comms-actions">
      <button type="button" onClick={onReply} aria-label={`Reply to ${message.from}`}>
        Reply
      </button>
      <button type="button" onClick={() => react("seen")} aria-label={`Ack ${message.from}`}>
        Ack
      </button>
      <button type="button" onClick={pin}>
        {message.pinned ? "Unpin" : "Pin"}
      </button>
      <fieldset className="comms-react-set">
        <legend className="sr-only">React</legend>
        {(["seen", "on_it", "done", "cant"] as const).map((reaction) => (
          <button key={reaction} type="button" onClick={() => react(reaction)}>
            {reaction === "on_it" ? "on it" : reaction === "cant" ? "can't" : reaction}
          </button>
        ))}
      </fieldset>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

function MessagePane({
  messages,
  lookupMessages = messages,
  jumpId,
  onJumped,
  onOpenMessage,
  onReply,
  flightId,
  sent = 0,
}: {
  messages: CommsMessage[];
  lookupMessages?: CommsMessage[];
  jumpId: string | null;
  onJumped: () => void;
  onOpenMessage: OpenMessage;
  onReply: (message: CommsMessage) => void;
  flightId: string | undefined;
  /** Counts CAPCOM's sends: each one brings the pane back to the latest, wherever the reader was. */
  sent?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  useLayoutEffect(() => {
    if (sent === 0) return;
    // Follow the latest again, so the sent message is in view when the refetch brings it.
    followsLatest.current = true;
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [sent]);
  const onJumpedRef = useRef(onJumped);
  onJumpedRef.current = onJumped;
  const [highlightId, setHighlightId] = useState(jumpId);
  const latestId = messages.at(-1)?.id;
  useLayoutEffect(() => {
    if (jumpId) {
      const target = document.getElementById(`comms-message-${jumpId}`);
      if (target) {
        setHighlightId(jumpId);
        target.scrollIntoView?.({ block: "center" });
        followsLatest.current = jumpId === latestId;
        onJumpedRef.current();
      }
    } else if (box.current && followsLatest.current) {
      box.current.scrollTop = box.current.scrollHeight;
    }
  }, [jumpId, latestId]);
  const rememberScrollPosition = () => {
    const el = box.current;
    if (!el) return;
    followsLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
  };
  const byId = new Map(lookupMessages.map((message) => [message.id, message]));
  return (
    <div className="comms-messages scroll" id="convo" ref={box} onScroll={rememberScrollPosition}>
      <div className="comms-message-stack">
        {messages.length === 0 ? <p className="pb note">No messages yet.</p> : null}
        {messages.map((message) => {
          const quote = message.replyTo ? byId.get(message.replyTo) : undefined;
          return (
            <article
              className={`comms-bubble${message.from === COMMS_CAPCOM ? " capcom" : ""}${highlightId === message.id ? " highlighted" : ""}`}
              id={`comms-message-${message.id}`}
              key={message.id}
            >
              <div className="comms-message-meta">
                <span>{time(message.at)}</span>
                <CommsEnd id={message.from} />
                {message.label && (
                  <Pill tone={message.label === "blocker" ? "crit" : "neutral"}>
                    {message.label}
                  </Pill>
                )}
                {message.ref && (
                  <button
                    className="comms-ref"
                    type="button"
                    onClick={() =>
                      navigate(
                        commsTicketPath(
                          message.ref as string,
                          ticketForRef(message.ref as string, message.ticket),
                        ),
                      )
                    }
                  >
                    {message.ref}
                  </button>
                )}
                <MessageActions message={message} onReply={() => onReply(message)} />
              </div>
              {quote && (
                <button
                  className="comms-quote"
                  type="button"
                  onClick={() => onOpenMessage(viewForMessage(quote, flightId), quote.id)}
                >
                  <b>{quote.from}</b> · {time(quote.at)} · {quote.text}
                </button>
              )}
              <div className="comms-bubble-body">
                <MessageRefs text={message.text} ticket={message.ticket} />
              </div>
              {message.reactions.length > 0 && (
                <div className="comms-reactions">
                  {message.reactions.map((reaction) => (
                    <span key={`${reaction.actor}:${reaction.reaction}`}>
                      {reaction.reaction === "on_it"
                        ? "on it"
                        : reaction.reaction === "cant"
                          ? "can't"
                          : reaction.reaction}
                      {reaction.reason ? `: ${reaction.reason}` : ""} · {reaction.actor}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function Composer({
  to,
  reply,
  onCancelReply,
  label,
  placeholder,
  messageRef,
  prefill,
  onPrefillConsumed,
  onSent,
}: {
  to: string;
  reply: CommsMessage | null;
  onCancelReply: () => void;
  label: string;
  placeholder: string;
  messageRef?: string;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
  onSent?: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const consumedPrefills = useRef(new Set<number>());
  useEffect(() => {
    if (!prefill || consumedPrefills.current.has(prefill.token)) return;
    consumedPrefills.current.add(prefill.token);
    setText(prefill.text);
    onPrefillConsumed?.(prefill.token);
  }, [onPrefillConsumed, prefill]);
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    void apiPost<{ message: CommsMessage }>("/api/comms", {
      to,
      text: value,
      ...(reply ? { replyTo: reply.id } : {}),
      ...(messageRef ? { ref: messageRef } : {}),
    })
      .then(() => {
        setText("");
        onCancelReply();
        hub.refetchTopic("agents");
        onSent?.();
      })
      .catch(() => setError("Could not send message."));
  };
  return (
    <form className="comms-composer" onSubmit={send}>
      {reply && (
        <div className="comms-replying">
          Replying to {reply.from}: {reply.text}
          <button type="button" onClick={onCancelReply} aria-label="Cancel reply">
            ×
          </button>
        </div>
      )}
      <label htmlFor="comms-compose">{label}</label>
      <div>
        <input
          id="comms-compose"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={placeholder}
        />
        <button type="submit">Send</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function MentionsBell({
  onOpenMessage,
  flightId,
}: {
  onOpenMessage: OpenMessage;
  flightId: string | undefined;
}) {
  const resource = useResource<{ mentions: CommsMention[] }>(RESOURCES.commsMentions);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [markError, setMarkError] = useState<string[] | null>(null);
  const panel = useRef<HTMLElement>(null);
  // The conversation panel clips what overflows it: fit the list into the room below the bell.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!open || !el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top;
      const host = el.closest("#chatP")?.getBoundingClientRect().bottom ?? window.innerHeight;
      const room = Math.min(host, window.innerHeight) - top - MENTIONS_GAP_PX;
      el.style.setProperty("--mentions-room", `${Math.max(MENTIONS_MIN_PX, Math.floor(room))}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);
  const mentions = resource.data?.mentions ?? [];
  const unseen = mentions.filter((mention) => !mention.seen && !seen.has(mention.message.id));
  const mark = (ids: string[]) => {
    void apiPost("/api/comms/mentions/seen", { ids })
      .then(() => {
        setSeen((current) => new Set([...current, ...ids]));
        setMarkError(null);
        hub.refetch(RESOURCES.commsMentions.path);
      })
      .catch(() => setMarkError(ids));
  };
  const openMention = (mention: CommsMention) => {
    setOpen(false);
    mark([mention.message.id]);
    const message = mention.message;
    onOpenMessage(viewForMessage(message, flightId), message.id);
  };
  return (
    <div className="comms-mentions">
      <button
        type="button"
        className="comms-bell"
        aria-label={`Mentions, ${unseen.length} new`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unseen.length > 0 && <b>{unseen.length}</b>}
      </button>
      {open && (
        <section className="comms-mentions-panel" aria-label="Mentions" ref={panel}>
          <header>
            Mentions <span>{unseen.length} new</span>
            <button
              type="button"
              onClick={() => mark(mentions.map((mention) => mention.message.id))}
            >
              Mark all read
            </button>
          </header>
          {mentions.map((mention) => {
            const isSeen = mention.seen || seen.has(mention.message.id);
            return (
              <button
                className={isSeen ? "seen" : ""}
                key={mention.message.id}
                type="button"
                onClick={() => openMention(mention)}
              >
                <b>{mention.message.from}</b>
                <span>
                  {mention.message.to === COMMS_CREW ? "#crew" : "direct"} ·{" "}
                  {time(mention.message.at)}
                </span>
                <em>{mention.message.text}</em>
              </button>
            );
          })}
          {mentions.length === 0 && <p>Nobody has tagged you.</p>}
        </section>
      )}
      {markError && (
        <p role="alert">
          Could not mark mentions read.{" "}
          <button type="button" onClick={() => mark(markError)}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

function StoredContacts({
  agentId,
  data,
  view,
}: {
  agentId: string;
  data: CommsAgentResponse | undefined;
  view: CommsView;
}) {
  const active = view.kind === "contact" ? view.contactId : null;
  return (
    <aside className="comms-contacts" aria-label={`${agentId}'s contacts`}>
      <button
        type="button"
        className={view.kind === "inbox" ? "on" : ""}
        onClick={() => navigate(commsInboxPath(agentId))}
      >
        Inbox · what it reads <small>{data?.inboxUnread ?? 0} unread</small>
      </button>
      <button
        type="button"
        className={view.kind === "agent" ? "on" : ""}
        onClick={() => navigate(commsAgentPath(agentId))}
      >
        All messages <small>{data?.messages.length ?? 0}</small>
      </button>
      {(data?.contacts ?? []).map((contact) => (
        <button
          type="button"
          className={active === contact.id ? "on" : ""}
          key={contact.id}
          onClick={() => navigate(commsContactPath(agentId, contact.id))}
        >
          {contact.id} · {contact.count}
          <small>
            {contact.unread > 0 ? `${contact.unread} unread · ` : ""}
            {contact.lastMessage?.text ?? "No messages yet."}
          </small>
        </button>
      ))}
    </aside>
  );
}

function PinnedMessage({ message }: { message: CommsMessage }) {
  const [error, setError] = useState<string | null>(null);
  const unpin = () => {
    void apiDelete(`/api/comms/${encodeURIComponent(message.id)}/pin`)
      .then(() => hub.refetchTopic("agents"))
      .catch(() => setError("Could not unpin message."));
  };
  return (
    <span>
      {message.from}: {message.text}
      <button type="button" onClick={unpin}>
        Unpin
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

function ModernConversation({
  view,
  jumpId,
  onJumped,
  onOpenMessage,
  prefill,
  onPrefillConsumed,
}: {
  view: CommsView;
  jumpId: string | null;
  onJumped: () => void;
  onOpenMessage: OpenMessage;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const crew = useResource<CommsMessagesResponse>(
    view.kind === "crew" ? RESOURCES.commsCrew : null,
  );
  const flight = useResource<CommsMessagesResponse>(
    view.kind === "flight" ? RESOURCES.commsFlight : null,
  );
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat;
  const agent = useResource<CommsAgentResponse>(
    "agentId" in view ? RESOURCES.commsAgent(view.agentId) : null,
  );
  const contact = useResource<CommsMessagesResponse>(
    view.kind === "contact" ? RESOURCES.commsContact(view.agentId, view.contactId) : null,
  );
  const ticket = useResource<CommsTicketResponse>(
    view.kind === "ticket"
      ? {
          path: `/api/comms/tickets/${encodeURIComponent(view.ref)}${
            view.ticket ? `?ticket=${encodeURIComponent(view.ticket)}` : ""
          }`,
          topic: "agents",
        }
      : null,
  );
  const pins = useResource<CommsPinsResponse>(RESOURCES.commsPins).data?.messages ?? [];
  const messages =
    view.kind === "crew"
      ? (crew.data?.messages ?? [])
      : view.kind === "flight"
        ? (flight.data?.messages ?? [])
        : view.kind === "contact"
          ? (contact.data?.messages ?? [])
          : view.kind === "ticket"
            ? [...(ticket.data?.messages ?? [])].sort((a, b) => a.at - b.at)
            : view.kind === "inbox"
              ? (agent.data?.inbox ?? [])
              : (agent.data?.messages ?? []);
  const lookupMessages = [...(agent.data?.messages ?? []), ...messages];
  const [reply, setReply] = useState<CommsMessage | null>(null);
  const [sent, setSent] = useState(0);
  const replyInView = reply && messages.some((message) => message.id === reply.id) ? reply : null;
  const read = useRef(new Set<string>());
  const pendingRead = useRef(new Set<string>());
  const [readError, setReadError] = useState<string | null>(null);
  const [readRetry, setReadRetry] = useState(0);
  const scope = scopeFor(view);
  const conversationScope =
    view.kind === "ticket" ? `ticket:${view.ref}:${view.ticket ?? ""}` : scope;
  useEffect(() => {
    if (!scope || messages.length === 0) return;
    if (readRetry > 0) setReadError(null);
    const latest = messages.at(-1);
    const key = latest && `${scope}:${latest.id}`;
    if (!latest || !key || read.current.has(key) || pendingRead.current.has(key)) return;
    pendingRead.current.add(key);
    void apiPost("/api/comms/read", { scope, messageId: latest.id })
      .then(() => {
        read.current.add(key);
        setReadError(null);
        hub.refetchTopic("agents");
      })
      .catch(() => setReadError("Could not mark this conversation read."))
      .finally(() => pendingRead.current.delete(key));
  }, [scope, messages, readRetry]);
  const to =
    view.kind === "crew" || view.kind === "ticket"
      ? COMMS_CREW
      : view.kind === "flight"
        ? flightSeat?.id
        : view.agentId;
  const showPins = view.kind === "crew" || view.kind === "inbox";
  const ticketContext = ticket.data?.ticket;
  const ticketBoardPath =
    ticketContext?.repoId !== null &&
    ticketContext?.repoId !== undefined &&
    ticketContext.issueNumber !== null &&
    ticketContext.issueNumber !== undefined
      ? ticketPath(ticketContext.repoId, ticketContext.issueNumber)
      : null;
  const chat = (
    <Panel
      id="chatP"
      title={
        <div className="comms-chat-title">
          <Breadcrumb view={view} />
          <span className="comms-chat-hint" title={conversationHint(view)}>
            {conversationHint(view)}
          </span>
        </div>
      }
      actions={<MentionsBell onOpenMessage={onOpenMessage} flightId={flightSeat?.id} />}
    >
      {readError && (
        <p className="pb crit-t s">
          {readError}{" "}
          <button type="button" onClick={() => setReadRetry((attempt) => attempt + 1)}>
            Retry
          </button>
        </p>
      )}
      {view.kind === "ticket" && (
        <div className="comms-ticket-strip">
          <b>{ticketContext?.ref ?? view.ref}</b>
          <span>{ticketContext?.title ?? "Ticket details unavailable"}</span>
          <Pill tone="neutral">{ticketContext?.status ?? "Unknown"}</Pill>
          <span>{ticketContext?.owner ?? "Unassigned"}</span>
          {ticketBoardPath && (
            <a href={ticketBoardPath} onClick={(event) => followLink(event, ticketBoardPath)}>
              Open on Board
            </a>
          )}
        </div>
      )}
      {showPins && pins.length > 0 && (
        <div className="comms-pins">
          <b>Pinned</b>
          {pins.map((pin) => (
            <PinnedMessage key={pin.id} message={pin} />
          ))}
        </div>
      )}
      <MessagePane
        messages={messages}
        lookupMessages={lookupMessages}
        jumpId={jumpId}
        onJumped={onJumped}
        onOpenMessage={onOpenMessage}
        onReply={setReply}
        flightId={flightSeat?.id}
        sent={sent}
      />
      {to ? (
        <Composer
          key={conversationScope}
          to={to}
          reply={replyInView}
          onCancelReply={() => setReply(null)}
          label={
            view.kind === "crew"
              ? "Post to #crew as CAPCOM · @name pings one agent"
              : view.kind === "ticket"
                ? `Post to #crew as CAPCOM · tagged ${view.ref}`
                : view.kind === "flight"
                  ? "Message FLIGHT as CAPCOM"
                  : `Message ${to} as CAPCOM`
          }
          placeholder={
            view.kind === "flight" ? "Ask FLIGHT, or give it direction…" : "Write a message…"
          }
          messageRef={view.kind === "ticket" ? view.ref : undefined}
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
          onSent={() => {
            setSent((count) => count + 1);
            if (view.kind === "contact" && view.contactId !== COMMS_CAPCOM)
              navigate(commsContactPath(view.agentId, COMMS_CAPCOM));
          }}
        />
      ) : (
        <p className="pb note">{FLIGHT_NO_SEAT}</p>
      )}
    </Panel>
  );
  return "agentId" in view ? (
    <div className="comms-agent">
      <StoredContacts agentId={view.agentId} data={agent.data} view={view} />
      {chat}
    </div>
  ) : (
    chat
  );
}

/** The route-driven Comms view uses the stored Comms API rather than transcript-derived threads. */
export function CommsConversation({
  view,
  row,
  prefill,
  onPrefillConsumed,
  jumpId = null,
  onJumped = () => {},
  onOpenMessage = () => {},
}: {
  view: CommsView;
  row: CrewRow | null;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
  jumpId?: string | null;
  onJumped?: () => void;
  onOpenMessage?: OpenMessage;
}) {
  if ("agentId" in view && row?.kind !== "crew") {
    return (
      <Panel id="chatP" title="Comms">
        <p className="pb note">Stored Comms is available for crew seats only.</p>
      </Panel>
    );
  }
  const conversationScope =
    view.kind === "ticket" ? `ticket:${view.ref}:${view.ticket ?? ""}` : scopeFor(view);
  return (
    <ModernConversation
      key={conversationScope}
      view={view}
      jumpId={jumpId}
      onJumped={onJumped}
      onOpenMessage={onOpenMessage}
      prefill={prefill}
      onPrefillConsumed={onPrefillConsumed}
    />
  );
}

export function CommsBreadcrumb({ view }: { view: CommsView }) {
  return <span>{view.kind === "crew" ? "Comms › #crew" : "Comms"}</span>;
}
