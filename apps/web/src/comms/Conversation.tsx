import {
  ATTENTION_LABEL,
  COMMS_CAPCOM,
  COMMS_CREW,
  COMMS_MC,
  type CommsAgentResponse,
  type CommsMention,
  type CommsMessage,
  type CommsMessagesResponse,
  type CommsPinsResponse,
  type CommsReactionKind,
  type CommsThreadMessage,
  type CommsTicketResponse,
  type CrewRow,
  type FlightView,
} from "@mc/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SeatComposer } from "../agent/StreamPanel.tsx";
import { apiDelete, apiPost, apiPut } from "../api.ts";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { callSign, seatStatus, seatTurn } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import {
  agentPath,
  commsAgentPath,
  commsContactPath,
  commsFlightPath,
  commsInboxPath,
  commsTicketPath,
  followLink,
  navigate,
} from "../router.ts";
import { FlightChat } from "../shell/Dock.tsx";
import { BRIEF_FOLD_AFTER, BRIEF_LINES } from "./ItemBrief.tsx";
import { CommsEnd, MentionText } from "./messages.tsx";
import type { CommsView } from "./model.ts";

/** Comms › Conversation (catalogue 2.5.3): FLIGHT's chat, or the selected agent's thread. */
export function Conversation({
  row,
  prefill,
  onPrefillConsumed,
}: {
  row: CrewRow | null;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const flightSeat = useResource<FlightView>(RESOURCES.flight).data?.seat ?? null;
  const activity = useResource<{ messages: CommsThreadMessage[] }>(
    row ? RESOURCES.comms(row.id) : null,
  );
  const [readError, setReadError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  const tz = useTz();
  const box = useRef<HTMLDivElement>(null);
  const msgs = activity.data?.messages ?? [];
  const id = row?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear a previous thread's read error on selection
  useEffect(() => {
    setReadError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const unread = msgs.filter(
      (m) =>
        !m.seen && !pending.current.has(`${id}:${m.id}`) && !completed.current.has(`${id}:${m.id}`),
    );
    if (unread.length === 0) return;
    const keys = unread.map((m) => `${id}:${m.id}`);
    for (const key of keys) pending.current.add(key);
    let active = true;
    void apiPost(ACTIONS.commsRead(id), { messageIds: unread.map((m) => m.id) })
      .then(() => {
        for (const key of keys) completed.current.add(key);
        if (active) setReadError(null);
        hub.refetch(RESOURCES.attention.path);
      })
      .catch(() => {
        if (active) setReadError("Could not mark thread read.");
      })
      .finally(() => {
        for (const key of keys) pending.current.delete(key);
      });
    return () => {
      active = false;
    };
  }, [id, msgs]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message when the thread or its length changes
  useLayoutEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [id, msgs.length]);

  if (row === null) {
    return (
      <Panel
        id="chatP"
        title="FLIGHT"
        sub="decisions and questions come to you here, tagged @CAPCOM"
      >
        {flightSeat === null ? (
          <p className="pb note">{FLIGHT_NO_SEAT}</p>
        ) : (
          <FlightChat where="comms" prefill={prefill} onPrefillConsumed={onPrefillConsumed} />
        )}
      </Panel>
    );
  }
  const empty =
    activity.error && !activity.data
      ? "Could not load activity."
      : !activity.data
        ? "Loading…"
        : "No messages yet.";
  const status = seatStatus(row);

  return (
    <Panel
      id="chatP"
      sub={`everything ${row.id} sent or received: you, FLIGHT and other agents`}
      title={
        <>
          Thread · <AgentTag id={row.id} index={row.index} sm /> ·{" "}
          <span title={status.reason ?? status.label}>
            <Pill tone={status.tone}>{status.label}</Pill>
          </span>
        </>
      }
      actions={
        <a href={agentPath(row.id)} onClick={(e) => followLink(e, agentPath(row.id))}>
          See its activity
        </a>
      }
    >
      {readError && <p className="pb crit-t s">{readError}</p>}
      {msgs.length === 0 ? (
        <p className="pb note">{empty}</p>
      ) : (
        <div className="scroll" id="convo" ref={box}>
          {msgs.map((m) => {
            const tagged = m.tagged;
            const cls = [
              "msg",
              m.from === COMMS_CAPCOM && "mine",
              m.from === COMMS_MC && "sys",
              m.from !== COMMS_CAPCOM && m.from !== COMMS_MC && "peer",
              tagged && "tagged",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={m.id} className={cls}>
                <div className="from">
                  <span className="num">{tz && m.at !== null ? hhmm(m.at, tz) : "—"}</span>
                  <CommsEnd id={m.from} />
                  <span>→</span>
                  <CommsEnd id={m.to} />
                  {tagged && <Pill tone="warn">{ATTENTION_LABEL.tag}</Pill>}
                </div>
                <div className="body">
                  <Expandable lines={BRIEF_LINES} foldAfter={BRIEF_FOLD_AFTER}>
                    <MentionText text={m.text} />
                  </Expandable>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {row.kind === "crew" && (
        <SeatComposer
          key={row.id}
          row={row}
          placeholder={
            seatTurn(row) === "running"
              ? `Message ${callSign(row)} (reaches it mid-turn)…`
              : `Message ${callSign(row)} (queued until its next turn)…`
          }
          onSent={() => {
            hub.refetch(RESOURCES.activity.path);
            hub.refetch(RESOURCES.comms(row.id).path);
          }}
        />
      )}
    </Panel>
  );
}

type OpenMessage = (view: CommsView, messageId: string) => void;

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function scopeFor(view: CommsView): string | null {
  if (view.kind === "crew") return "crew";
  if (view.kind === "flight") return "flight";
  if (view.kind === "agent") return `agent-all:${view.agentId}`;
  if (view.kind === "inbox") return `inbox:${view.agentId}`;
  if (view.kind === "contact") return `pair:${[view.agentId, view.contactId].sort().join(":")}`;
  return null;
}

function MessageRefs({ text }: { text: string }) {
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
            onClick={() => navigate(commsTicketPath(part))}
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
      <button
        type="button"
        onClick={() => react("seen")}
        aria-label={`Acknowledge ${message.from}`}
      >
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
}: {
  messages: CommsMessage[];
  lookupMessages?: CommsMessage[];
  jumpId: string | null;
  onJumped: () => void;
  onOpenMessage: OpenMessage;
  onReply: (message: CommsMessage) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [highlightId, setHighlightId] = useState(jumpId);
  const latestId = messages.at(-1)?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest rendered message.
  useLayoutEffect(() => {
    if (jumpId) {
      setHighlightId(jumpId);
      document.getElementById(`comms-message-${jumpId}`)?.scrollIntoView?.({ block: "center" });
      onJumped();
    } else if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [jumpId, latestId, onJumped]);
  const byId = new Map(lookupMessages.map((message) => [message.id, message]));
  const targetFor = (message: CommsMessage): CommsView => {
    if (message.to === COMMS_CREW) return { kind: "crew" };
    const agentId = message.from === COMMS_CAPCOM ? message.to : message.from;
    return { kind: "contact", agentId, contactId: COMMS_CAPCOM };
  };
  return (
    <div className="comms-messages scroll" id="convo" ref={box}>
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
                {message.from === COMMS_CAPCOM && <Pill tone="warn">operator</Pill>}
                {message.label && (
                  <Pill tone={message.label === "blocker" ? "crit" : "neutral"}>
                    {message.label}
                  </Pill>
                )}
                {message.ref && (
                  <button
                    className="comms-ref"
                    type="button"
                    onClick={() => navigate(commsTicketPath(message.ref as string))}
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
                  onClick={() => onOpenMessage(targetFor(quote), quote.id)}
                >
                  <b>{quote.from}</b> · {time(quote.at)} · {quote.text}
                </button>
              )}
              <div className="comms-bubble-body">
                <MessageRefs text={message.text} />
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
}: {
  to: string;
  reply: CommsMessage | null;
  onCancelReply: () => void;
  label: string;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    void apiPost<{ message: CommsMessage }>("/api/comms", {
      to,
      text: value,
      ...(reply ? { replyTo: reply.id } : {}),
    })
      .then(() => {
        setText("");
        onCancelReply();
        hub.refetchTopic("agents");
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

function MentionsBell({ onOpenMessage }: { onOpenMessage: OpenMessage }) {
  const resource = useResource<{ mentions: CommsMention[] }>(RESOURCES.commsMentions);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const mentions = resource.data?.mentions ?? [];
  const unseen = mentions.filter((mention) => !mention.seen && !seen.has(mention.message.id));
  const mark = (ids: string[]) => {
    setSeen((current) => new Set([...current, ...ids]));
    void apiPost("/api/comms/mentions/seen", { ids }).then(() =>
      hub.refetch(RESOURCES.commsMentions.path),
    );
  };
  const openMention = (mention: CommsMention) => {
    mark([mention.message.id]);
    const message = mention.message;
    onOpenMessage(
      message.to === COMMS_CREW
        ? { kind: "crew" }
        : { kind: "contact", agentId: message.from, contactId: COMMS_CAPCOM },
      message.id,
    );
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
        <section className="comms-mentions-panel" aria-label="Mentions">
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
          <small>{contact.lastMessage?.text ?? "No messages yet."}</small>
        </button>
      ))}
    </aside>
  );
}

function ModernConversation({
  view,
  jumpId,
  onJumped,
  onOpenMessage,
}: {
  view: CommsView;
  jumpId: string | null;
  onJumped: () => void;
  onOpenMessage: OpenMessage;
}) {
  const crew = useResource<CommsMessagesResponse>(
    view.kind === "crew" ? RESOURCES.commsCrew : null,
  );
  const flight = useResource<CommsMessagesResponse>(
    view.kind === "flight" ? RESOURCES.commsFlight : null,
  );
  const flightSeat = useResource<FlightView>(view.kind === "flight" ? RESOURCES.flight : null).data
    ?.seat;
  const agent = useResource<CommsAgentResponse>(
    "agentId" in view ? RESOURCES.commsAgent(view.agentId) : null,
  );
  const contact = useResource<CommsMessagesResponse>(
    view.kind === "contact" ? RESOURCES.commsContact(view.agentId, view.contactId) : null,
  );
  const ticket = useResource<CommsTicketResponse>(
    view.kind === "ticket"
      ? { path: `/api/comms/tickets/${encodeURIComponent(view.ref)}`, topic: "agents" }
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
            ? (ticket.data?.messages ?? [])
            : view.kind === "inbox"
              ? (agent.data?.inbox ?? [])
              : (agent.data?.messages ?? []);
  const lookupMessages = [...(agent.data?.messages ?? []), ...messages];
  const [reply, setReply] = useState<CommsMessage | null>(null);
  const replyInView = reply && messages.some((message) => message.id === reply.id) ? reply : null;
  const read = useRef(new Set<string>());
  const scope = scopeFor(view);
  useEffect(() => {
    if (!scope || messages.length === 0) return;
    const latest = messages.at(-1);
    if (!latest || read.current.has(`${scope}:${latest.id}`)) return;
    read.current.add(`${scope}:${latest.id}`);
    void apiPost("/api/comms/read", { scope, messageId: latest.id }).then(() =>
      hub.refetchTopic("agents"),
    );
  }, [scope, messages]);
  const to =
    view.kind === "crew" || view.kind === "ticket"
      ? COMMS_CREW
      : view.kind === "flight"
        ? (flightSeat?.id ??
          messages.find((message) => message.from !== COMMS_CAPCOM)?.from ??
          "FLIGHT")
        : view.agentId;
  const showPins = view.kind === "crew" || view.kind === "inbox";
  const chat = (
    <Panel
      id="chatP"
      title={
        <div className="comms-chat-title">
          <Breadcrumb view={view} />
          <span className="comms-chat-hint" title={conversationHint(view)}>
            {conversationHint(view)}
          </span>
          <MentionsBell onOpenMessage={onOpenMessage} />
        </div>
      }
    >
      {view.kind === "ticket" && (
        <div className="comms-ticket-strip">Every message about {view.ref}</div>
      )}
      {showPins && pins.length > 0 && (
        <div className="comms-pins">
          <b>Pinned</b>
          {pins.map((pin) => (
            <span key={pin.id}>
              {pin.from}: {pin.text}
            </span>
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
      />
      <Composer
        to={to}
        reply={replyInView}
        onCancelReply={() => setReply(null)}
        label={
          view.kind === "crew"
            ? "Post to #crew as CAPCOM · @name pings one agent"
            : view.kind === "flight"
              ? "Message FLIGHT as CAPCOM"
              : `Message ${to} as CAPCOM`
        }
        placeholder={
          view.kind === "flight" ? "Ask FLIGHT, or give it direction…" : "Write a message…"
        }
      />
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
  return (
    <ModernConversation
      view={view}
      jumpId={jumpId}
      onJumped={onJumped}
      onOpenMessage={onOpenMessage}
    />
  );
}

export function CommsBreadcrumb({ view }: { view: CommsView }) {
  return <span>{view.kind === "crew" ? "Comms › #crew" : "Comms"}</span>;
}
