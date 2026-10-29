import { ATTENTION_LABEL, type AttentionItem, FLIGHT_TRIAGE_LABEL } from "@mc/core";
import { useState } from "react";
import { needsYouItems, sortNeeds } from "../attention.ts";
import { useSecond, useTz } from "../clock.ts";
import { ItemBrief } from "../comms/ItemBrief.tsx";
import { MentionText } from "../comms/messages.tsx";
import { NEED_TEXT_MAX, needText } from "../comms/needText.ts";
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
import { HeldNeeds } from "./HeldNeeds.tsx";
import { isNotTriaging, NotTriagingRow } from "./NotTriaging.tsx";
import { Pending } from "./Pending.tsx";

const DASH = "—";

/** An ask's full brief, open so the operator can decide from the page; Hide folds it. */
function FullBrief({ item }: { item: AttentionItem }) {
  const [open, setOpen] = useState(true);
  if (!item.brief) return null;
  return (
    <>
      <button
        type="button"
        className="sm ghost fullbrief"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide brief" : "Full brief"}
      </button>
      {open && <ItemBrief brief={item.brief} approval={item.kind === "approval"} />}
    </>
  );
}
export const NOBODY_WAITING = "Nobody is waiting on you.";

/**
 * Asked of you (catalogue §2.2.2): the whole Needs-you set, as the header counts it (never narrowed
 * by the session filter). A GitHub thread waiting on the operator is a card; the other items are
 * rows, with FLIGHT's take and its full brief where it briefed one. It is the first panel of the
 * FLIGHT page's Needs you tab, Needs you's home.
 */
export function AskedOfYou({
  withDefaults = true,
  withHeld = true,
}: {
  /** False leaves out the asks FLIGHT will settle by default (the Needs you tab groups them). */
  withDefaults?: boolean;
  /** False leaves out the Held group (the Needs you tab places it itself). */
  withHeld?: boolean;
} = {}) {
  const attentionRes = useResource<AttentionItem[]>(RESOURCES.attention);
  const attention = attentionRes.data;
  const notes = useResource<NotificationsView>(RESOURCES.notifications);
  const now = useSecond();
  const tz = useTz();
  const { inRepo } = useSessionScope();
  // A failed load counts as no threads, so the rest of the list still shows.
  if (attention === undefined)
    return (
      <Pending what="what needs you" error={attentionRes.error} resource={RESOURCES.attention} />
    );
  if (notes.data === undefined && notes.error === null)
    return <Pending what="your GitHub threads" error={null} resource={RESOURCES.notifications} />;
  const needsYou = sortNeeds(needsYouItems(attention)).filter(
    (i) => withDefaults || i.defaultDueAt === undefined,
  );
  const open = new Map((notes.data?.open ?? []).map((t) => [t.key, t]));
  // A person item whose thread the notifications view holds is a card; any other item is a row.
  const threads = needsYou.flatMap((item) => {
    const t = item.kind === "person" ? open.get(item.key) : undefined;
    return t ? [{ t, item }] : [];
  });
  const items = needsYou.filter(
    (i) => !(i.kind === "person" && open.has(i.key)) && !isNotTriaging(i),
  );
  // "FLIGHT is not triaging": one item for what waits on FLIGHT, shown open here (Show them)
  const notTriaging = needsYou.find(isNotTriaging);
  const handled = (notes.data?.handledToday ?? []).filter((h) => inRepo(h.repoId));
  const footer = handled.length > 0 && (
    <p className="s note" data-testid="handled-today">
      {handledLine(handled)}
    </p>
  );
  if (threads.length === 0 && items.length === 0 && notTriaging === undefined)
    return (
      <>
        <p className="pb note">{NOBODY_WAITING}</p>
        {withHeld && <HeldNeeds />}
        {footer}
      </>
    );
  return (
    <div>
      {notTriaging && <NotTriagingRow item={notTriaging} items={attention} open />}
      <div className="askcards">
        {threads.map(({ t, item }) => {
          const take = item.brief;
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
              {item.flightTriage === "missed" && (
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
          <FullBrief item={i} />
        </div>
      ))}
      {withHeld && <HeldNeeds />}
      {footer}
    </div>
  );
}
