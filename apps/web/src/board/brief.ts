import { type BoardItem, type CrewRow, type PullRequestView, startOfLocalDay } from "@mc/core";
import { type NeedsYou, prAction } from "../attention.ts";
import { loopStepLabel } from "../crew.ts";
import { agoWords } from "../fmt.ts";
import {
  cardAgent,
  cardColumn,
  cardNeeds,
  cardPr,
  type DependencyIndex,
  daysAgo,
  doneOutcome,
  firstBlocker,
  needsMe,
  sortCards,
  ticketRef,
  WAITING_COLUMN,
  waitsOf,
} from "./cards.ts";

export type BriefCtx = {
  laneName: string;
  prs: PullRequestView[];
  crew: CrewRow[];
  /** The Needs-you set (`needsYouItems`): what waits on me comes only from it. */
  needsYou: NeedsYou;
  /** The dependency read (`dependencyIndex`), so a ticket held by `Depends on` sorts as Blocked. */
  deps?: DependencyIndex | null;
};

/** What a card's PR waits on me to do, from its Needs-you item; null when none asks. */
function prWait(i: BoardItem, ctx: BriefCtx): string | null {
  for (const a of cardNeeds(i, ctx.needsYou, ctx.crew)) {
    const action = prAction(a);
    if (action !== null) return action;
  }
  return null;
}

/** `Saturday 17 October`, built from parts so ICU's comma never appears. */
function longDate(ms: number, tz: string): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** Sections of a brief share one line shape: `- {ref}{ (PR #n)}: {title}{ ({extra})}`. */
function section(
  title: string,
  list: BoardItem[],
  ctx: BriefCtx,
  extra: (i: BoardItem) => string = () => "",
): string {
  if (list.length === 0) return "";
  const lines = list.map((i) => {
    const pr = cardPr(i, ctx.prs);
    const e = extra(i);
    return `- ${ticketRef(i)}${pr ? ` (PR #${pr.number})` : ""}: ${i.title}${e ? ` (${e})` : ""}`;
  });
  return `${title}\n${lines.join("\n")}`;
}

const column = (items: BoardItem[], name: string, ctx: BriefCtx): BoardItem[] =>
  sortCards(items.filter((i) => cardColumn(i, ctx.deps) === name));

const outcome = (i: BoardItem, ctx: BriefCtx): string => doneOutcome(i, ctx.prs).toLowerCase();

/** What a held ticket says in a brief: why the hub holds it and what frees it. */
const waitingNote = (i: BoardItem): string =>
  i.waiting ? `waiting: ${i.waiting.reason}; frees when ${i.waiting.freesWhen}` : "";

const blockedBy =
  (ctx: BriefCtx) =>
  (i: BoardItem): string => {
    const b = firstBlocker(i) ?? waitsOf(i, ctx.deps)[0]?.ref;
    return b ? `blocked by ${b}` : "";
  };

const join = (parts: string[]): string => parts.filter(Boolean).join("\n\n");

/** Plain text for Teams or email: no agent ids anywhere. */
export function standup(items: BoardItem[], ctx: BriefCtx, now: number, tz: string): string {
  const mine = (i: BoardItem) => needsMe(i, ctx.needsYou, ctx.crew);
  const today = startOfLocalDay(now, tz);
  const done = column(items, "Done", ctx).filter((i) => daysAgo(i.updatedAt, now, tz, today) <= 1);
  const held = new Set(["stalled", "blocked", "parked"]);
  const step = (i: BoardItem): string => {
    const a = cardAgent(i, ctx.crew);
    if (!a?.run) return "";
    const label = a.loop ? loopStepLabel(a.loop) : `run #${a.run.seq}`;
    return `${label}${held.has(a.hudState) ? ", held up" : ""}`;
  };
  const blocked = column(items, "Blocked", ctx);
  const heldBack = column(items, WAITING_COLUMN, ctx);
  const waiting = sortCards(
    items.filter((i) => mine(i) && !blocked.includes(i) && !heldBack.includes(i)),
  );
  return join([
    `Standup, ${longDate(now, tz)} (${ctx.laneName})`,
    section("Since yesterday", [...done, ...column(items, "Ready for QA", ctx)], ctx, (i) =>
      cardColumn(i, ctx.deps) === "Done" ? outcome(i, ctx) : "merged, with QA",
    ),
    section(
      "Today",
      [...column(items, "In progress", ctx), ...column(items, "Ready", ctx).slice(0, 2)],
      ctx,
      (i) => (cardColumn(i, ctx.deps) === "In progress" ? step(i) : "up next"),
    ),
    section("Blocked or waiting on me", [...blocked, ...heldBack, ...waiting], ctx, (i) => {
      if (cardColumn(i, ctx.deps) === "Blocked") return blockedBy(ctx)(i);
      if (cardColumn(i, ctx.deps) === WAITING_COLUMN) return waitingNote(i);
      const action = prWait(i, ctx);
      return action ? `I need to ${action}` : "waiting on me";
    }),
    section(
      "In review",
      column(items, "In review", ctx).filter((i) => !mine(i)),
      ctx,
      () => "PR open",
    ),
  ]);
}

export function weekly(
  items: BoardItem[],
  ctx: BriefCtx,
  days: number,
  now: number,
  tz: string,
): string {
  const today = startOfLocalDay(now, tz);
  return join([
    `Update: ${ctx.laneName}, last ${days} days`,
    section(
      "Done",
      column(items, "Done", ctx),
      ctx,
      (i) => `${outcome(i, ctx)} ${agoWords(daysAgo(i.updatedAt, now, tz, today))}`,
    ),
    section("Ready for QA", column(items, "Ready for QA", ctx), ctx),
    section("In review", column(items, "In review", ctx), ctx, (i) => {
      const action = prWait(i, ctx);
      return action ? `waiting for me to ${action}` : "PR open";
    }),
    section("In progress", column(items, "In progress", ctx), ctx),
    section("Blocked", column(items, "Blocked", ctx), ctx, blockedBy(ctx)),
    section("Waiting", column(items, WAITING_COLUMN, ctx), ctx, waitingNote),
    section("Coming up next", column(items, "Ready", ctx), ctx, (i) => i.priority ?? ""),
  ]);
}
