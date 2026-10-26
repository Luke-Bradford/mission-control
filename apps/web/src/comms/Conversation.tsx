import {
  ATTENTION_LABEL,
  COMMS_CAPCOM,
  COMMS_MC,
  type CommsThreadMessage,
  type CrewRow,
  type FlightView,
} from "@mc/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SeatComposer } from "../agent/StreamPanel.tsx";
import { apiPost } from "../api.ts";
import { useTz } from "../clock.ts";
import { Expandable } from "../components/Expandable.tsx";
import { callSign, seatStatus, seatTurn } from "../crew.ts";
import { ACTIONS, hub, RESOURCES, useResource } from "../data.ts";
import { FLIGHT_NO_SEAT } from "../flight/flightTypes.ts";
import { hhmm } from "../fmt.ts";
import { AgentTag } from "../hud/AgentTag.tsx";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { agentPath, commsAgentPath, commsFlightPath, followLink, navigate } from "../router.ts";
import { FlightChat } from "../shell/Dock.tsx";
import { AgentContacts } from "./AgentContacts.tsx";
import { BRIEF_FOLD_AFTER, BRIEF_LINES } from "./ItemBrief.tsx";
import { CommsEnd, MentionText } from "./messages.tsx";
import { type CommsView, messagesForView } from "./model.ts";

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

function useCommsRead(id: string | undefined, messages: CommsThreadMessage[]) {
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Set<string>());
  const completed = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the selected agent
  useEffect(() => {
    setError(null);
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const unread = messages.filter(
      (message) =>
        !message.seen &&
        !pending.current.has(`${id}:${message.id}`) &&
        !completed.current.has(`${id}:${message.id}`),
    );
    if (unread.length === 0) return;
    const keys = unread.map((message) => `${id}:${message.id}`);
    keys.forEach((key) => {
      pending.current.add(key);
    });
    void apiPost(ACTIONS.commsRead(id), { messageIds: unread.map((message) => message.id) })
      .then(() => {
        keys.forEach((key) => {
          completed.current.add(key);
        });
        setError(null);
        hub.refetch(RESOURCES.attention.path);
        hub.refetch(RESOURCES.comms(id).path);
      })
      .catch(() => setError("Could not mark thread read."))
      .finally(() => {
        keys.forEach((key) => {
          pending.current.delete(key);
        });
      });
  }, [id, messages]);
  return error;
}

function AgentConversation({
  row,
  view,
  prefill,
  onPrefillConsumed,
}: {
  row: CrewRow;
  view: CommsView;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  const activity = useResource<{ messages: CommsThreadMessage[] }>(RESOURCES.comms(row.id));
  const all = activity.data?.messages ?? [];
  const messages = view.kind === "inbox" ? [] : messagesForView(view, all);
  const selected = view.kind === "contact" ? view.contactId : null;
  const readError = useCommsRead(row.id, all);
  const box = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const route = `${view.kind}:${row.id}:${view.kind === "contact" ? view.contactId : ""}`;
  const shownRoute = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: route and message count drive bottom following
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    if (shownRoute.current !== route) {
      shownRoute.current = route;
      nearBottom.current = true;
      element.scrollTop = element.scrollHeight;
    } else if (nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [route, messages.length]);
  return (
    <div className="comms-agent">
      <AgentContacts
        agentId={row.id}
        messages={all}
        selected={selected}
        inbox={view.kind === "inbox"}
        onNavigate={navigate}
      />
      <Panel id="chatP" title={<CommsBreadcrumb view={view} />}>
        {readError && <p className="pb crit-t s">{readError}</p>}
        <div
          className="scroll comms-messages"
          id="convo"
          ref={box}
          onScroll={() => {
            const element = box.current;
            if (element)
              nearBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          <div className="comms-message-stack">
            {messages.length === 0 ? (
              <p className="pb note">
                {view.kind === "inbox" ? "Not available yet." : "No messages yet."}
              </p>
            ) : (
              messages.map((message) => (
                <div
                  className={`msg${message.from === COMMS_CAPCOM ? " mine" : ""}`}
                  key={message.id}
                >
                  <div className="from">
                    <CommsEnd id={message.from} /> → <CommsEnd id={message.to} />
                    {message.from === COMMS_CAPCOM && <Pill tone="neutral">operator</Pill>}
                  </div>
                  <div className="body">
                    <MentionText text={message.text} />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <p className="s muted">{`Message ${row.id} directly as CAPCOM · marked operator`}</p>
        <SeatComposer row={row} prefill={prefill} onPrefillConsumed={onPrefillConsumed} />
      </Panel>
    </div>
  );
}

/** The route-driven Comms content; unavailable main resources have explicit empty states. */
export function CommsConversation({
  view,
  row,
  prefill,
  onPrefillConsumed,
}: {
  view: CommsView;
  row: CrewRow | null;
  prefill?: import("./model.ts").ComposerPrefill;
  onPrefillConsumed?: (token: number) => void;
}) {
  if (view.kind === "flight")
    return <Conversation row={null} prefill={prefill} onPrefillConsumed={onPrefillConsumed} />;
  if (view.kind === "crew") {
    return (
      <Panel id="chatP" title="#crew">
        <p className="pb note">Not available yet.</p>
      </Panel>
    );
  }
  if (row === null) {
    return (
      <Panel id="chatP" title="Comms">
        <p className="pb note">This agent is no longer in the crew.</p>
      </Panel>
    );
  }
  return (
    <AgentConversation
      row={row}
      view={view}
      prefill={prefill}
      onPrefillConsumed={onPrefillConsumed}
    />
  );
}

export function CommsBreadcrumb({ view }: { view: CommsView }) {
  if (view.kind === "flight") return <span>Comms</span>;
  return (
    <nav className="comms-breadcrumb" aria-label="Breadcrumb">
      <button type="button" onClick={() => navigate(commsFlightPath())}>
        Comms
      </button>
      {view.kind !== "crew" && (
        <>
          <span>›</span>
          <span>Agents</span>
          <span>›</span>
          <button type="button" onClick={() => navigate(commsAgentPath(view.agentId))}>
            {view.agentId}
          </button>
          {view.kind === "contact" && (
            <>
              <span>›</span>
              <span>{view.contactId}</span>
            </>
          )}
          {view.kind === "inbox" && (
            <>
              <span>›</span>
              <span>Inbox</span>
            </>
          )}
        </>
      )}
    </nav>
  );
}
