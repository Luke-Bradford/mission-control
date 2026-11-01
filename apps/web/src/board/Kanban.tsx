import {
  type BoardItem,
  type CrewRow,
  HUD_COLUMNS,
  type HudColumn,
  type PullRequestView,
  reviewCheckPill,
  statusOutOfDate,
} from "@mc/core";
import { useId, useMemo, useState } from "react";
import type { NeedsYou } from "../attention.ts";
import { agoDays, plural } from "../fmt.ts";
import { Card, type CardProps } from "./Card.tsx";
import {
  cardAgent,
  cardColumn,
  cardNeeds,
  cardPr,
  cardQueue,
  cardReviewer,
  cardStep,
  cardYou,
  daysAgo,
  doneOutcome,
  sortCards,
  statusOutOfDateTitle,
  ticketRef,
} from "./cards.ts";
import { usePhone } from "./phone.ts";

const NO_PRS: PullRequestView[] = [];
export interface KanbanColumnMetric {
  label: string;
  count: string;
  title: string;
}
/** Keep the Board's historical Done column light until the operator asks for its full history. */
export const DONE_CARD_WINDOW = 10;

/** What every card on this render shares. */
interface CardCtx {
  showRepo: boolean;
  /** The PRs per ticket ref, grouped once per PR fetch. */
  prsByTicket: Map<string, PullRequestView[]>;
  crew: CrewRow[];
  /** The Needs-you set: a card waits on you only for one of these. */
  needsYou: NeedsYou;
  now: number;
  tz: string | null;
  todayStart: number | null;
}

/**
 * Everything one card shows, in one place: `Card` takes only these values and is memoised on them,
 * so the 5 s clock re-renders only a card whose shown value changed (#26 A1).
 */
function cardProps(item: BoardItem, col: HudColumn, ctx: CardCtx): CardProps {
  const prs = ctx.prsByTicket.get(ticketRef(item)) ?? NO_PRS;
  let when = "";
  if (col === "Done") {
    when =
      ctx.tz === null ? "—" : agoDays(daysAgo(item.updatedAt, ctx.now, ctx.tz, ctx.todayStart));
  }
  const agent = cardAgent(item, ctx.crew);
  const pr = cardPr(item, prs);
  const needs = cardNeeds(item, ctx.needsYou, ctx.crew);
  return {
    item,
    showRepo: ctx.showRepo,
    agent,
    step: agent ? cardStep(agent) : null,
    queued: agent ? null : cardQueue(item, ctx.crew),
    reviewer: col === "Done" ? null : cardReviewer(item, pr, ctx.crew),
    pr,
    checkPill: pr?.check ? reviewCheckPill(pr.check, ctx.now) : null,
    mine: needs.length > 0,
    unacked: needs.some((a) => !a.acked),
    outcome: doneOutcome(item, prs),
    when,
    statusOutOfDate: statusOutOfDate(item) ? statusOutOfDateTitle(item) : null,
    you: cardYou(needs, ctx.now),
  };
}

/**
 * The eight Status columns; a column with nothing in it collapses to its name. `todayStart` is
 * `startOfLocalDay(now, tz)` (null while `tz` is), worked out once per Board render.
 */
export function Kanban({
  items,
  showRepo,
  prs,
  crew,
  needsYou,
  now,
  tz,
  todayStart,
  columns = HUD_COLUMNS,
  notIn,
  metrics = {},
  id = "kanban",
}: {
  items: BoardItem[];
  showRepo: boolean;
  prs: PullRequestView[];
  crew: CrewRow[];
  /** The Needs-you set (`needsYouItems`). */
  needsYou: NeedsYou;
  now: number;
  tz: string | null;
  todayStart: number | null;
  /** The columns to draw, in order; default all eight. */
  columns?: readonly HudColumn[];
  /** Per column, the repo ids that lack it (Together layout): shown as `not in {ids}`. */
  notIn?: ReadonlyMap<HudColumn, string[]>;
  /** Registry figures shown in place of a Status-column's local card count. */
  metrics?: Partial<Record<HudColumn, KanbanColumnMetric>>;
  id?: string;
}) {
  const prsByTicket = useMemo(() => {
    const m = new Map<string, PullRequestView[]>();
    for (const p of prs) {
      if (p.ticket === null) continue;
      const list = m.get(p.ticket);
      if (list) list.push(p);
      else m.set(p.ticket, [p]);
    }
    return m;
  }, [prs]);
  const ctx: CardCtx = {
    showRepo,
    prsByTicket,
    crew,
    needsYou,
    now,
    tz,
    todayStart,
  };
  const phone = usePhone();
  const uid = useId();
  const [picked, setPicked] = useState<HudColumn | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const lists = new Map(
    columns.map((col) => [col, sortCards(items.filter((i) => cardColumn(i) === col))]),
  );
  // At phone width one column is open: the one tapped, else the first with cards.
  const filled = columns.filter((c) => (lists.get(c)?.length ?? 0) > 0);
  // A picked column that has emptied is forgotten, so a refill does not silently reopen it.
  if (picked !== null && !filled.includes(picked)) setPicked(null);
  const openCol = picked !== null && filled.includes(picked) ? picked : (filled[0] ?? null);
  const panelId = (col: HudColumn) => `${uid}-${col.replace(/\W+/g, "-")}`;
  return (
    <div className="kanban" id={id}>
      {columns.map((col) => {
        const metric = metrics[col];
        const lacking = notIn?.get(col);
        const note = lacking?.length ? (
          <div className="xs muted knot">not in {lacking.join(", ")}</div>
        ) : null;
        const list = lists.get(col) ?? [];
        const label = metric?.label ?? col;
        const count = metric?.count ?? String(list.length);
        const title = metric?.title;
        const cards = col === "Done" && !doneExpanded ? list.slice(0, DONE_CARD_WINDOW) : list;
        const hiddenDone = col === "Done" ? list.length - cards.length : 0;
        const moreDone =
          hiddenDone > 0 ? (
            <button type="button" className="done-more" onClick={() => setDoneExpanded(true)}>
              Show {plural(hiddenDone, "more completed card")}
            </button>
          ) : null;
        if (phone && list.length > 0) {
          const on = col === openCol;
          return (
            <div key={col} className="kcol">
              <h2 className="kh">
                <button
                  type="button"
                  aria-expanded={on}
                  aria-controls={panelId(col)}
                  onClick={() => setPicked(col)}
                >
                  <span title={title}>
                    {label} <span className="n">{count}</span>
                  </span>
                </button>
              </h2>
              {note}
              {on && (
                <div className="kb" id={panelId(col)}>
                  {cards.map((i) => (
                    <Card key={ticketRef(i)} {...cardProps(i, col, ctx)} />
                  ))}
                  {moreDone}
                </div>
              )}
            </div>
          );
        }
        if (list.length === 0) {
          return (
            <div key={col} className="kcol empty" title={title ?? `${col}: nothing here`}>
              <h2 className="kh">
                <span title={title}>
                  {label} <span className="n">{count}</span>
                </span>
              </h2>
              {note}
            </div>
          );
        }
        return (
          <div key={col} className="kcol">
            <h2 className="kh">
              <span title={title}>
                {label} <span className="n">{count}</span>
              </span>
            </h2>
            {note}
            <div className="kb">
              {cards.map((i) => (
                <Card key={ticketRef(i)} {...cardProps(i, col, ctx)} />
              ))}
              {moreDone}
            </div>
          </div>
        );
      })}
    </div>
  );
}
