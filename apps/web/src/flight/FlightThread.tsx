import type { FlightConversationMessage } from "@mc/core";
import { useEffect, useRef } from "react";
import { Markdown } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { hhmm } from "../fmt.ts";
import "./FlightThread.css";

type Page = { messages: FlightConversationMessage[]; flight?: { live: boolean; since: number | null; runId: string | null } };

/** The stored FLIGHT conversation: every surface reads this one endpoint. */
export function FlightThread() {
  const res = useResource<Page>(RESOURCES.commsFlight);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const messages = res.data?.messages ?? [];
  useEffect(() => { if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages.length]);
  const flight = res.data?.flight;
  return <section className="flight-thread" aria-label="Conversation with FLIGHT">
    <div className="flight-thread-log" role="log" ref={log} onScroll={() => { const el = log.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      {res.loading && !res.data && <p role="status">Loading messages…</p>}
      {res.error && !res.data && <p role="alert">Could not load messages.</p>}
      {!res.loading && res.data && messages.length === 0 && <p className="note">No messages yet.</p>}
      {messages.map((message) => <article className={message.operator ? "flight-thread-message operator" : "flight-thread-message"} key={message.id}><b>{message.operator ? "You" : "FLIGHT"}</b><div><Markdown text={message.text} /></div></article>)}
      {flight?.live && <p role="status">FLIGHT is working… since {flight.since === null ? "—" : hhmm(flight.since, "Europe/London")}</p>}
      {flight && !flight.live && <p role="status">FLIGHT is stopped</p>}
    </div>
  </section>;
}
