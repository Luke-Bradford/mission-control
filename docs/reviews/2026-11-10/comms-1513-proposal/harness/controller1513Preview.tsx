// Preview-only page substitutions. No production source imports this module.
import type { CrewRow } from "@mc/core";
import { useEffect, useState } from "react";
import { callSign } from "../src/crew.ts";
import { Panel } from "../src/hud/Panel.tsx";
import { commsAgentPath, commsContactPath, commsCrewPath, commsFlightPath, commsTicketPath, followLink, navigate, ticketPath, type CommsView } from "../src/router.ts";
import { proposalEvents, proposalTickets, proposalWaiting } from "./controller1513Data.ts";
import "../src/ticket/ticket.css";
import "./controller1513Preview.css";

export function CommsNav({ rows, flightId, view, onNavigate }: { rows: CrewRow[]; flightId?: string; view: CommsView; onNavigate(path: string): void }) {
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const agent = "agentId" in view ? view.agentId : null;
  useEffect(() => {
    if (agent) setRead(old => old.has(agent) ? old : new Set([...old, agent]));
  }, [agent]);
  const seats = rows.filter(r => r.kind === "crew" && r.id !== flightId);
  return <nav className="comms-nav p1513-nav" aria-label="Comms">
    <div className="comms-section-head"><h2>Team</h2></div>
    <button type="button" className={`comms-nav-top${view.kind === "flight" ? " on" : ""}`} onClick={() => onNavigate(commsFlightPath())}><span className="comms-nav-agent"><b>FLIGHT and you</b><small>6 messages</small></span></button>
    <button type="button" className={`comms-nav-top${view.kind === "crew" ? " on" : ""}`} onClick={() => onNavigate(commsCrewPath())}><span className="comms-nav-agent"><b>#crew</b><small>Crew messages and handoffs</small></span></button>
    <button type="button" className="comms-nav-top p1513-controller" onClick={() => onNavigate(commsContactPath(flightId ?? "flight-1", "CONTROLLER"))}><span className="comms-nav-agent"><b>FLIGHT and the controller</b><small>5 messages</small></span></button>
    <div className="comms-section-head"><h2>Agents</h2><span>{seats.length} seats</span></div>
    <div className="p1513-agents">{seats.map(row => <button type="button" key={row.id} className={`comms-nav-row${agent === row.id ? " on" : ""}`} onClick={() => onNavigate(commsAgentPath(row.id))}>
      <span className="comms-nav-agent"><b>{callSign(row)}</b><small>{row.hudState === "running" ? "Working" : "Available"}</small></span><span className="comms-nav-counts"><small title="All recorded messages with this seat’s contacts">12 messages</small>{row.id === "guido-1" && !read.has(row.id) && <span className="p1513-unread" title="A reply to your message" aria-label="Unread reply to you" />}</span>
    </button>)}</div>
  </nav>;
}

export function TicketsList() {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = proposalTickets.filter(t => words.every(w => `${t.number} ${t.title} ${t.status}`.toLowerCase().includes(w)));
  return <section className="comms-tickets p1513-tickets" aria-label="Tickets">
    <div className="comms-section-head"><h2>Tickets</h2><span>{found.length} with messages</span></div>
    <label className="sr-only" htmlFor="p1513-search">Find a ticket</label><input id="p1513-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Number, title or status" />
    <ul>{found.map(t => <li key={t.number}><a className="comms-ticket-open" href={ticketPath("shop-app", t.number)} onClick={e => followLink(e, ticketPath("shop-app", t.number))}><b>#{t.number}</b> {t.title}<small>{t.count} messages · {t.status}</small></a><button type="button" title={`Filter the conversation to ${t.title}`} onClick={() => navigate(commsTicketPath(`#${t.number}`, `shop-app#${t.number}`))}>Filter chat</button></li>)}</ul>
    {found.length === 0 && <p className="note">No matching tickets with messages.</p>}
  </section>;
}

export function CommsGraph() {
  return <aside className="comms-right p1513-right" aria-label="Waiting on a reply">
    <Panel title="Waiting on a reply" sub="Who owes the next reply"><ul className="p1513-waiting">{proposalWaiting.map(w => <li key={w.seat}><button type="button" onClick={() => navigate(commsContactPath(w.agent, w.contact))}><b>{w.seat}</b><time>{w.age}</time><span>{w.text}</span></button></li>)}</ul></Panel>
    <p className="p1513-record-note">Questions are answered on <a href="/needs-you" onClick={e => followLink(e, "/needs-you")}>Needs you</a>. Comms keeps what was said.</p>
    <a className="p1513-graph-link" href="/comms/chart" onClick={e => followLink(e, "/comms/chart")}>Open the separate Comms graph ↗</a>
  </aside>;
}

export function TicketPage({ repoId, number }: { repoId: string; number: number }) {
  const [recordState, setRecordState] = useState(() => /p1513-state=(loading|empty|error)/.exec(document.cookie)?.[1] ?? "ready");
  const t = proposalTickets.find(t => t.number === number) ?? proposalTickets[0];
  return <section id="page-ticket" className="p1513-ticket">
    <p className="tk-back"><a href={commsCrewPath()} onClick={e => followLink(e, commsCrewPath())}>← Comms</a><span>{repoId} · #{number}</span></p>
    <header className="tk-head"><h1>{t.title}</h1><p>What this ticket asks for, and what was said and decided.</p></header>
    <div className="p1513-ticket-grid">
      <div className="p1513-ticket-summary">
        <Panel title="The work"><div className="pb"><dl className="tk-fields"><div className="tk-field"><dt>Status</dt><dd>{t.status}</dd></div><div className="tk-field"><dt>Owner</dt><dd><a href="/agent/guido-1" onClick={e => followLink(e, "/agent/guido-1")}>GUIDO-1</a></dd></div></dl><h3>Outcome</h3><p>Quotes load from the cache, with the eviction choice and its comparison retained.</p><h3>Done when</h3><ul><li>Cache hits meet the agreed response target.</li><li>Eviction is covered, and the comparison is recorded.</li></ul><a href={commsTicketPath(`#${number}`, `shop-app#${number}`)} onClick={e => followLink(e, commsTicketPath(`#${number}`, `shop-app#${number}`))}>Open this ticket’s conversation</a></div></Panel>
        <Panel title="Question and answer" sub="Kept together"><div className="pb p1513-question"><p className="p1513-byline">GUIDO-1 asked · 11:49</p><p>Which expiry should the cache use?</p><p className="p1513-answer"><b>YOU answered · 11:54</b><br />Keep the shorter expiry and include the comparison in the handoff.</p><details><summary>Conversation around this question</summary><p><b>FLIGHT:</b> The comparison is ready; this is the remaining choice.</p><p><b>GUIDO-1:</b> Both options meet the response target.</p></details></div></Panel>
      </div>
      <Panel title="Record" sub="Questions, answers, holds, handoffs and messages" className="p1513-record-panel"><div className="p1513-state" hidden={recordState === "ready"}><p>{recordState === "loading" ? "Loading this ticket’s record…" : recordState === "empty" ? "No conversation or decisions have been recorded for this ticket yet." : "This ticket’s record could not load. The work above is still available."}</p>{recordState === "error" && <button type="button" onClick={() => setRecordState("ready")}>Try again</button>}</div><ol className="p1513-events" hidden={recordState !== "ready"}>{proposalEvents.map(e => <li className="tk-event" data-kind={e.kind} key={e.id}><time className="tk-when">{e.at}</time><span className="p1513-kind">{e.kind}</span><div><p className="p1513-byline">{e.who}</p><p>{e.text}</p><details><summary>Context</summary><p>{e.detail}</p></details></div></li>)}</ol></Panel>
    </div>
  </section>;
}
