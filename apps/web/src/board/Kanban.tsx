import {
  type AttentionItem,
  type BoardItem,
  type CrewRow,
  HUD_COLUMNS,
  type HudColumn,
  type PullRequestView,
  statusOutOfDate,
} from "@mc/core";
import { useId, useMemo, useState } from "react";
import { agoDays } from "../fmt.ts";
import { Card, type CardProps } from "./Card.tsx";
import {
  cardAgent,
  cardColumn,
  cardPr,
  cardYouWait,
  daysAgo,
  doneOutcome,
  needsMe,
  sortCards,
  statusOutOfDateTitle,
  ticketRef,
} from "./cards.ts";
import { usePhone } from "./phone.ts";

const NO_PRS: PullRequestView[] = [];

/** What every card on this render shares. */
interface CardCtx {
  showRepo: boolean;
  /** The PRs per ticket ref, grouped once per PR fetch. */
  prsByTicket: Map<string, PullRequestView[]>;
  crew: CrewRow[];
  attention: AttentionItem[];
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
  return {
    item,
    showRepo: ctx.showRepo,
    agent: cardAgent(item, ctx.crew),
    pr: cardPr(item, prs),
    mine: needsMe(item, ctx.attention, ctx.crew),
    outcome: doneOutcome(item, prs),
    when,
    statusOutOfDate: statusOutOfDate(item) ? statusOutOfDateTitle(item) : null,
    youWait: cardYouWait(item, prs, ctx.crew, ctx.now),
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
  attention,
  now,
  tz,
  todayStart,
  columns = HUD_COLUMNS,
  notIn,
  id = "kanban",
}: {
  items: BoardItem[];
  showRepo: boolean;
  prs: PullRequestView[];
  crew: CrewRow[];
  attention: AttentionItem[];
  now: number;
  tz: string | null;
  todayStart: number | null;
  /** The columns to draw, in order; default all eight. */
  columns?: readonly HudColumn[];
  /** Per column, the repo ids that lack it (Together layout): shown as `not in {ids}`. */
  notIn?: ReadonlyMap<HudColumn, string[]>;
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
  const ctx: CardCtx = { showRepo, prsByTicket, crew, attention, now, tz, todayStart };
  const phone = usePhone();
  const uid = useId();
  const [picked, setPicked] = useState<HudColumn | null>(null);
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
        const lacking = notIn?.get(col);
        const note = lacking?.length ? (
          <div className="xs muted knot">not in {lacking.join(", ")}</div>
        ) : null;
        const list = lists.get(col) ?? [];
        if (phone && list.length > 0) {
          const on = col === openCol;
          return (
            <div key={col} className="kcol">
              <button
                type="button"
                className="kh"
                aria-expanded={on}
                aria-controls={panelId(col)}
                onClick={() => setPicked(col)}
              >
                {col} <span className="n">{list.length}</span>
              </button>
              {note}
              {on && (
                <div className="kb" id={panelId(col)}>
                  {list.map((i) => (
                    <Card key={ticketRef(i)} {...cardProps(i, col, ctx)} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        if (list.length === 0) {
          return (
            <div key={col} className="kcol empty" title={`${col}: nothing here`}>
              <div className="kh">
                {col} <span className="n">0</span>
              </div>
              {note}
            </div>
          );
        }
        return (
          <div key={col} className="kcol">
            <div className="kh">
              {col} <span className="n">{list.length}</span>
            </div>
            {note}
            <div className="kb">
              {list.map((i) => (
                <Card key={ticketRef(i)} {...cardProps(i, col, ctx)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
