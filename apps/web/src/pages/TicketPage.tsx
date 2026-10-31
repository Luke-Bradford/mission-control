import type { TicketEvent, TicketHistory } from "@mc/core";
import { useEffect, useMemo, useState } from "react";
import { ApiError, apiGet } from "../api.ts";
import { useTz } from "../clock.ts";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { hub, RESOURCES, useResource } from "../data.ts";
import { dayMonth, hhmm, plural } from "../fmt.ts";
import { Panel } from "../hud/Panel.tsx";
import { Pill } from "../hud/Pill.tsx";
import { boardPath, followLink } from "../router.ts";
import {
  eventLine,
  findingsOf,
  findingWord,
  KIND_WORD,
  mergeEvents,
  type PageEvent,
  prEvents,
} from "../ticket/ticketTimeline.ts";
import "../ticket/ticket.css";

const dash = "—";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="tk-field">
      <dt>{label}</dt>
      <dd>{value || dash}</dd>
    </div>
  );
}

function Entry({ e, t, tz }: { e: PageEvent; t: TicketHistory; tz: string | null }) {
  const findings = e.kind === "review" ? findingsOf(t, e.reviewId) : [];
  return (
    <li className="tk-event" data-kind={e.kind}>
      <span className="tk-when">{tz ? `${dayMonth(e.at, tz)} ${hhmm(e.at, tz)}` : dash}</span>
      <Pill tone="plain">{KIND_WORD[e.kind]}</Pill>
      <span className="tk-line">{eventLine(e)}</span>
      {(e.kind === "comms" || e.kind === "decision") && (
        <details className="tk-more">
          <summary>Full text</summary>
          <p className="tk-text">{e.kind === "comms" ? e.text : `${e.decision}\n${e.basis}`}</p>
        </details>
      )}
      {findings.length > 0 && (
        <details className="tk-findings">
          <summary>{plural(findings.length, "finding")}</summary>
          <ul>
            {findings.map((f) => (
              <li key={f.pos}>
                <Pill tone={f.severity === "Important" ? "warn" : "plain"}>{f.severity}</Pill>{" "}
                <span className="mono">{`${f.file}:${f.line}`}</span> {f.summary}
                <span className="muted">{` (${findingWord(f)})`}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * One ticket (`/tickets/:repo/:number`): what it asks for as a read-only form, and what the crew
 * has done on it. GitHub is a single link. Question: what does this ticket ask for, and what has
 * the crew done on it?
 */
export function TicketPage({ repoId, number }: { repoId: string; number: number }) {
  const res = useResource<TicketHistory>(RESOURCES.ticketHistory(repoId, number));
  const tz = useTz();
  const t = res.data;
  const [older, setOlder] = useState<{ events: TicketEvent[]; next: string | null } | null>(null);
  // every live event seen, so one that slides out of the newest page stays
  const [kept, setKept] = useState<TicketEvent[]>([]);
  const [paging, setPaging] = useState<"idle" | "loading" | "failed">("idle");
  // another ticket starts with no older pages of the last one
  // biome-ignore lint/correctness/useExhaustiveDependencies: repoId and number name the ticket
  useEffect(() => {
    setOlder(null);
    setKept([]);
    setPaging("idle");
  }, [repoId, number]);
  useEffect(() => {
    if (t) setKept((k) => mergeEvents(k, t.timeline));
  }, [t]);
  const next = older ? older.next : (t?.nextBefore ?? null);
  const events = useMemo(() => {
    const all: PageEvent[] = mergeEvents<TicketEvent>(t?.timeline ?? [], kept, older?.events ?? []);
    const oldest = all.length > 0 ? (all[all.length - 1] as PageEvent).at : 0;
    // while older pages remain, a PR event before the oldest loaded one would sit out of order
    const prs = prEvents(t ?? ({ prs: [] } as unknown as TicketHistory)).filter(
      (p) => next === null || p.at >= oldest,
    );
    return mergeEvents<PageEvent>(all, prs);
  }, [t, kept, older, next]);

  const loadOlder = async () => {
    if (next === null) return;
    setPaging("loading");
    try {
      const page = await apiGet<TicketHistory>(RESOURCES.ticketHistory(repoId, number, next).path);
      setOlder((o) => ({
        events: mergeEvents(o?.events ?? [], page.timeline),
        next: page.nextBefore,
      }));
      setPaging("idle");
    } catch {
      setPaging("failed");
    }
  };

  const back = boardPath(repoId);
  const head = (
    <p className="tk-back">
      <a href={back} onClick={(e) => followLink(e, back)}>
        <span aria-hidden="true">←</span> Board
      </a>
    </p>
  );

  if (!t) {
    const notFound = res.error instanceof ApiError && res.error.status === 404;
    return (
      <section id="page-ticket" className="ticket-page">
        {head}
        {notFound ? (
          <p>{`${repoId}#${number} is not a ticket Mission Control can find.`}</p>
        ) : res.error ? (
          <p className="crit-t" role="alert">
            Could not load the ticket: {res.error.message}{" "}
            <button
              type="button"
              onClick={() => hub.refetch(RESOURCES.ticketHistory(repoId, number).path)}
            >
              Retry
            </button>
          </p>
        ) : (
          <p className="muted">Loading ticket…</p>
        )}
      </section>
    );
  }

  return (
    <section id="page-ticket" className="ticket-page">
      {head}
      <header className="tk-head">
        <h1>{t.title}</h1>
        <p className="tk-ref">
          <span className="mono">{`${t.repoId}#${t.number}`}</span>
          <Pill tone="plain">{t.state === "closed" ? "Closed" : "Open"}</Pill>
          {res.error && <Pill tone="warn">Out of date: the last refresh failed</Pill>}
        </p>
      </header>
      <div className="tk-grid">
        <Panel id="ticketP" title="Ticket" className="tk-form">
          <div className="pb scroll">
            <dl className="tk-fields">
              <Field label="Status" value={t.status} />
              <Field label="Priority" value={t.priority} />
              <Field label="Size" value={t.size} />
              <Field label="Labels" value={t.labels.length > 0 ? t.labels.join(", ") : null} />
            </dl>
            {t.githubError && (
              <p className="warn-t s">{`GitHub could not be reached: ${t.githubError}`}</p>
            )}
            <h3>Outcome</h3>
            {t.outcome ? (
              <p className="tk-text">{t.outcome}</p>
            ) : (
              <p className="muted">
                {t.body === null
                  ? "The ticket body is not available."
                  : "The ticket has no outcome section."}
              </p>
            )}
            <h3>Done when</h3>
            {t.doneWhen.length > 0 ? (
              <ul className="tk-done" aria-label="Done when">
                {t.doneWhen.map((d) => (
                  <li key={d.text}>
                    <span aria-hidden="true">{d.checked ? "☑" : "☐"}</span>
                    <span className="tk-text">{d.text}</span>
                    <span className="muted">{d.checked ? "done" : "open"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">The ticket lists no done-when items.</p>
            )}
            {t.prs.length > 0 && (
              <>
                <h3>Pull requests</h3>
                <ul className="tk-prs" aria-label="Pull requests">
                  {t.prs.map((p) => (
                    <li key={p.number}>
                      <span className="mono">{`PR #${p.number}`}</span> {p.title}{" "}
                      <Pill tone="plain">{p.isDraft ? "Draft" : p.state}</Pill>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="tk-gh">
              <ExternalLink url={t.url} label={`View on GitHub: ${t.repoId}#${t.number}`}>
                View on GitHub ↗
              </ExternalLink>
            </p>
          </div>
        </Panel>
        <Panel id="timelineP" title="Timeline" sub="newest first" className="tk-timeline">
          <div className="pb scroll">
            {events.length === 0 ? (
              <p className="muted">The crew has not touched this ticket yet.</p>
            ) : (
              <ol className="tk-events" aria-label="Timeline events">
                {events.map((e) => (
                  <Entry key={e.key} e={e} t={t} tz={tz} />
                ))}
              </ol>
            )}
            {paging === "failed" && <p className="crit-t s">Could not load older events.</p>}
            {next !== null && (
              <button
                type="button"
                disabled={paging === "loading"}
                onClick={() => void loadOlder()}
              >
                {paging === "loading" ? "Loading…" : "Load older"}
              </button>
            )}
          </div>
        </Panel>
      </div>
    </section>
  );
}
