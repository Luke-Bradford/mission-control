import {
  type BoardItem,
  type ConfigView,
  type CrewRow,
  HUD_STATE_LABEL,
  HUD_STATE_LAMP,
  prPill,
  STATUS_OUT_OF_DATE,
  statusOutOfDate,
  type TicketView,
} from "@mc/core";
import { type ReactNode, useId } from "react";
import { ApiError } from "../api.ts";
import { statusOutOfDateTitle } from "../board/cards.ts";
import { RESOURCES, useResource } from "../data.ts";
import { Lamp } from "../hud/Lamp.tsx";
import { Pill } from "../hud/Pill.tsx";
import { RepoRef } from "../hud/RepoRef.tsx";
import { githubHref, githubRepoOfUrl } from "../links.ts";
import { agentPath, boardPath, followLink } from "../router.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { Markdown } from "./Markdown.tsx";
import { StartSeat } from "./StartSeat.tsx";
import "./TicketDetail.css";

/** Open or Closed, as a word: a closed ticket is never green. */
const OpenClosed = ({ closed }: { closed: boolean }) => (
  <Pill tone="plain">{closed ? "Closed" : "Open"}</Pill>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  const head = useId();
  return (
    <section className="tsec" aria-labelledby={head}>
      <h3 id={head}>{title}</h3>
      {children}
    </section>
  );
}

/** The agent working the ticket: its state as a lamp and a word, and a link to its page. */
function AgentOnIt({ agent }: { agent: CrewRow }) {
  const s = agent.hudState;
  const to = agentPath(agent.id);
  return (
    <Section title="Agent on it">
      <p className="row">
        <Lamp {...HUD_STATE_LAMP[s]} label={HUD_STATE_LABEL[s]} decorative />
        <a href={to} onClick={(e) => followLink(e, to)}>
          {agent.id}
        </a>
        <span className="s fg2">{HUD_STATE_LABEL[s]}</span>
      </p>
    </Section>
  );
}

/**
 * A PR linked to the ticket. One in the ticket's own repo goes through RepoRef (linked from the
 * config); one GitHub reports from another repo links to its own URL, with that repo's name as the
 * chip, because the ticket's repo would give a wrong link.
 */
function PullRequestRef({ repoId, number, url }: { repoId: string; number: number; url: string }) {
  const { data: config, error } = useResource<ConfigView>(RESOURCES.config);
  if (config === undefined) {
    // a failed config cannot say which repo is the ticket's own: link the server's URL, as RepoRef does
    if (error) return <RepoRef repoId={repoId} number={number} kind="pr" bare url={url} />;
    // while it loads, show the plain form, not a guess
    return <RepoRef repoId={repoId} number={number} kind="pr" bare />;
  }
  const own = config.repos.find((r) => r.id === repoId)?.github;
  const from = githubRepoOfUrl(url);
  if (own === undefined || from === null || from.toLowerCase() === own.toLowerCase()) {
    return <RepoRef repoId={repoId} number={number} kind="pr" bare url={url} />;
  }
  const name = from.split("/")[1] as string;
  return (
    <span className="rref">
      <span className="rchip" title={name}>
        {name}
      </span>{" "}
      <ExternalLink url={url} label={`${name} PR #${number}`}>
        {`PR #${number}`}
      </ExternalLink>
    </span>
  );
}

/**
 * One ticket beside the board: the card's own facts at once, the issue's body, sub-issues and
 * pull requests once GitHub answers. A section with nothing to show is omitted. The body is plain
 * text, never Markdown or HTML.
 */
export function TicketDetail({
  repoId,
  number,
  item,
  agent,
}: {
  repoId: string;
  number: number;
  /** The board's card for this ticket, when the board has loaded it. */
  item: BoardItem | undefined;
  /** The agent running on this ticket, else null. */
  agent: CrewRow | null;
}) {
  const res = useResource<TicketView>(RESOURCES.ticket(repoId, number));
  const t = res.data;
  const back = boardPath(repoId);
  const notFound = res.error instanceof ApiError && res.error.status === 404;
  const title = t?.title ?? item?.title;
  const milestone = t ? t.milestone : (item?.milestone ?? null);
  const url = t?.url ?? item?.url ?? "";
  const outOfDate = item !== undefined && statusOutOfDate(item);
  const closed = t ? t.state === "closed" : item?.closed === true;
  // the fetched labels once they arrive, the card's until then
  const labels = t ? t.labels : (item?.labels ?? []);

  const head = (
    <div className="ph">
      <a href={back} onClick={(e) => followLink(e, back)}>
        <span aria-hidden="true">←</span> Board
      </a>
    </div>
  );
  if (notFound) {
    return (
      <aside className="panel tdetail" aria-label="ticket">
        {head}
        <div className="pb scroll">
          <p className="muted">Ticket {`${repoId}#${number}`} not found.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel tdetail" aria-label="ticket">
      {head}
      <div className="pb scroll">
        {(title !== undefined || res.error) && (
          <article className="tart">
            {title !== undefined && (
              <header className="thead">
                <div className="row">
                  {(t || item) && <OpenClosed closed={closed} />}
                  <RepoRef repoId={repoId} number={number} bare url={url} />
                </div>
                <h2 className="btitle">{title}</h2>
                {(item || milestone || labels.length > 0) && (
                  <p className="labels">
                    {item && outOfDate && (
                      <span className="lb warn-t" title={statusOutOfDateTitle(item)}>
                        {STATUS_OUT_OF_DATE}
                      </span>
                    )}
                    {item && !outOfDate && item.status !== "" && (
                      <span className="lb">{item.status}</span>
                    )}
                    {item?.stage && <span className="lb">{item.stage}</span>}
                    {item?.owner && <span className="lb">{item.owner}</span>}
                    {milestone && <span className="lb">{milestone}</span>}
                    {labels.map((l) => (
                      <span key={l} className="lb">
                        {l}
                      </span>
                    ))}
                  </p>
                )}
              </header>
            )}
            {res.error && (
              <p className="crit-t s">Could not load the ticket: {res.error.message}</p>
            )}
            {agent && <AgentOnIt agent={agent} />}
            {title !== undefined && (t || item) && !closed && (
              <StartSeat repoId={repoId} number={number} title={title} />
            )}
            {t && t.body.trim() !== "" && (
              <Section title="Description">
                <div className="tbody">
                  <Markdown text={t.body} />
                </div>
                {t.bodyTruncated && (
                  <p className="s">
                    <ExternalLink url={t.url}>Continue on GitHub ↗</ExternalLink>
                  </p>
                )}
              </Section>
            )}
            {t && t.subIssues.length > 0 && (
              <Section title="Sub-issues">
                <ul className="tlist" aria-label="Sub-issues">
                  {t.subIssues.map((s, i) => (
                    // an unconfigured repo (null) has no id and a sub-issue no URL: position tells them apart
                    <li key={`${s.repoId ?? `?${i}`}#${s.number}`} className="row">
                      <OpenClosed closed={s.state === "closed"} />
                      {s.repoId === null ? (
                        <span className="rref">
                          <span>{`#${s.number}`}</span>
                        </span>
                      ) : (
                        <RepoRef repoId={s.repoId} number={s.number} bare={s.repoId === repoId} />
                      )}
                      <span>{s.title}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {t && t.pullRequests.length > 0 && (
              <Section title="Pull requests">
                <ul className="tlist" aria-label="Pull requests">
                  {t.pullRequests.map((p) => {
                    const pill = prPill({ state: p.state });
                    return (
                      <li key={`${p.repoId ?? p.url}#${p.number}`} className="row">
                        <Pill tone={pill.tone}>{pill.label}</Pill>
                        {p.repoId && p.repoId !== repoId ? (
                          <RepoRef repoId={p.repoId} number={p.number} kind="pr" url={p.url} />
                        ) : (
                          <PullRequestRef repoId={repoId} number={p.number} url={p.url} />
                        )}
                        <span>{p.title}</span>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}
            {githubHref(url) && (
              <p className="s">
                <ExternalLink url={url}>Open on GitHub ↗</ExternalLink>
              </p>
            )}
          </article>
        )}
      </div>
    </aside>
  );
}
