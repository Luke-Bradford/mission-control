import {
  type AttentionItem,
  type BoardItem,
  type CrewRow,
  type PullRequestView,
  startOfLocalDay,
} from "@mc/core";
import { loopStepLabel } from "../crew.ts";
import {
  cardAgent,
  cardColumn,
  cardPr,
  cardYouWait,
  daysAgo,
  doneOutcome,
  firstBlocker,
  needsMe,
  sortCards,
  ticketRef,
} from "./cards.ts";

export type BriefCtx = {
  laneName: string;
  prs: PullRequestView[];
  crew: CrewRow[];
  attention: AttentionItem[];
};

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

const agoWords = (d: number): string =>
  d === 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;

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

const column = (items: BoardItem[], name: string): BoardItem[] =>
  sortCards(items.filter((i) => cardColumn(i) === name));

const outcome = (i: BoardItem, ctx: BriefCtx): string => doneOutcome(i, ctx.prs).toLowerCase();

const blockedBy = (i: BoardItem): string => {
  const b = firstBlocker(i);
  return b ? `blocked by ${b}` : "";
};

const join = (parts: string[]): string => parts.filter(Boolean).join("\n\n");

/** Plain text for Teams or email: no agent ids anywhere. */
export function standup(items: BoardItem[], ctx: BriefCtx, now: number, tz: string): string {
  const mine = (i: BoardItem) => needsMe(i, ctx.attention, ctx.crew);
  const today = startOfLocalDay(now, tz);
  const done = column(items, "Done").filter((i) => daysAgo(i.updatedAt, now, tz, today) <= 1);
  const held = new Set(["stalled", "blocked", "parked"]);
  const step = (i: BoardItem): string => {
    const a = cardAgent(i, ctx.crew);
    if (!a?.run) return "";
    const label = a.loop ? loopStepLabel(a.loop) : `run #${a.run.seq}`;
    return `${label}${held.has(a.hudState) ? ", held up" : ""}`;
  };
  const blocked = column(items, "Blocked");
  const waiting = sortCards(items.filter((i) => mine(i) && !blocked.includes(i)));
  return join([
    `Standup, ${longDate(now, tz)} (${ctx.laneName})`,
    section("Since yesterday", [...done, ...column(items, "Ready for QA")], ctx, (i) =>
      cardColumn(i) === "Done" ? outcome(i, ctx) : "merged, with QA",
    ),
    section(
      "Today",
      [...column(items, "In progress"), ...column(items, "Ready").slice(0, 2)],
      ctx,
      (i) => (cardColumn(i) === "In progress" ? step(i) : "up next"),
    ),
    section("Blocked or waiting on me", [...blocked, ...waiting], ctx, (i) => {
      if (cardColumn(i) === "Blocked") return blockedBy(i);
      const you = cardYouWait(i, ctx.prs, ctx.crew, now);
      return you ? `I need to ${you.action}` : "waiting on me";
    }),
    section(
      "In review",
      column(items, "In review").filter((i) => !mine(i)),
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
      column(items, "Done"),
      ctx,
      (i) => `${outcome(i, ctx)} ${agoWords(daysAgo(i.updatedAt, now, tz, today))}`,
    ),
    section("Ready for QA", column(items, "Ready for QA"), ctx),
    section("In review", column(items, "In review"), ctx, (i) => {
      const you = cardYouWait(i, ctx.prs, ctx.crew, now);
      return you ? `waiting for me to ${you.action}` : "PR open";
    }),
    section("In progress", column(items, "In progress"), ctx),
    section("Blocked", column(items, "Blocked"), ctx, blockedBy),
    section("Coming up next", column(items, "Ready"), ctx, (i) => i.priority ?? ""),
  ]);
}
