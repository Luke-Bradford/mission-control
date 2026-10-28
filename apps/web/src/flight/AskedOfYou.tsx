import { ATTENTION_LABEL, type AttentionItem, FLIGHT_TRIAGE_LABEL } from "@mc/core";
import { needsYouItems, sortNeeds } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { MentionText } from "../comms/messages.tsx";
import { NEED_TEXT_MAX, needText } from "../comms/NeedsList.tsx";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { MarkdownInline } from "../components/Markdown.tsx";
import { RESOURCES, useResource } from "../data.ts";
import { rel } from "../fmt.ts";
import { Pill } from "../hud/Pill.tsx";
import {
  CATCH_UP_LABEL,
  handledLine,
  type NotificationsView,
  whereOf,
  whoOf,
} from "../notifications.ts";
import { openItem } from "../shell/overlays.ts";
import { useSessionScope } from "../shell/session.ts";

const DASH = "—";
export const NOBODY_WAITING = "Nobody is waiting on you.";

/**
 * Asked of you (catalogue §2.2.2): the whole Needs-you set, as the header counts it (never narrowed
 * by the session filter). A GitHub thread waiting on the operator is a card; the other items are
 * rows, with FLIGHT's take where it briefed one. Until #766 builds FLIGHT › Needs you, this is
 * Needs you's home.
 */
export function AskedOfYou() {
  const attention = useResource<AttentionItem[]>(RESOURCES.attention).data;
  const notes = useResource<NotificationsView>(RESOURCES.notifications);
  const now = useSecond();
  const tz = useTz();
  const { inRepo } = useSessionScope();
  // A failed load counts as no threads, so the rest of the list still shows.
  if (attention === undefined || (notes.data === undefined && notes.error === null))
    return <p className="pb note">{DASH}</p>;
  const needsYou = sortNeeds(needsYouItems(attention));
  const open = new Map((notes.data?.open ?? []).map((t) => [t.key, t]));
  // A person item whose thread the notifications view holds is a card; any other item is a row.
  const threads = needsYou.flatMap((i) => {
    const t = i.kind === "person" ? open.get(i.key) : undefined;
    return t ? [t] : [];
  });
  const items = needsYou.filter((i) => !(i.kind === "person" && open.has(i.key)));
  const handled = (notes.data?.handledToday ?? []).filter((h) => inRepo(h.repoId));
  const footer = handled.length > 0 && (
    <p className="s note" data-testid="handled-today">
      {handledLine(handled)}
    </p>
  );
  if (threads.length === 0 && items.length === 0)
    return (
      <>
        <p className="pb note">{NOBODY_WAITING}</p>
        {footer}
      </>
    );
  return (
    <div>
      <div className="askcards">
        {threads.map((t) => {
          const item = attention.find((i) => i.key === t.key);
          const take = item?.brief;
          return (
            <div className="askcard" key={t.key} data-testid="person-card">
              <div className="row">
                <b>{whoOf(t)}</b>
                <span className="chip">{whereOf(t)}</span>
                <span className="s">{tz === null ? DASH : rel(t.updatedAt, now, tz)}</span>
              </div>
              <div className="row">
                <Pill tone={t.catchUp === "new" ? "plain" : "warn"}>
                  {CATCH_UP_LABEL[t.catchUp]}
                </Pill>
                <span className="min0">
                  {t.reasonText}: {t.title}
                </span>
              </div>
              {t.snippet !== null && (
                <blockquote className="s qtext">
                  <MentionText text={t.snippet} />
                </blockquote>
              )}
              {item?.flightTriage === "missed" && (
                <p className="s note">{FLIGHT_TRIAGE_LABEL.missed}</p>
              )}
              {take && (
                <div className="s">
                  <span className="bsec">FLIGHT'S TAKE</span>{" "}
                  <MarkdownInline text={take.recommendation} />
                </div>
              )}
              <div className="row">
                <ExternalLink url={t.url}>Open in GitHub ↗</ExternalLink>
                <button type="button" className="sm primary" onClick={() => openItem(t.key)}>
                  Read the brief and reply
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {items.map((i) => (
        <div className="drow" key={i.key} data-testid="ask-row">
          <div className="row">
            <Pill tone={i.kind === "decision" ? "warn" : "plain"}>{ATTENTION_LABEL[i.kind]}</Pill>
            <span className="min0">
              <MarkdownInline text={needText(i, now)} max={NEED_TEXT_MAX} />
            </span>
            <span className="spacer" />
            <button type="button" className="sm" onClick={() => openItem(i.key)}>
              Open
            </button>
          </div>
          {i.flightTriage === "missed" && <p className="s note">{FLIGHT_TRIAGE_LABEL.missed}</p>}
          {i.brief && (
            <div className="s">
              <b>FLIGHT's take:</b> <MarkdownInline text={i.brief.recommendation} />
            </div>
          )}
        </div>
      ))}
      {footer}
    </div>
  );
}
