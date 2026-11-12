import { PRIORITIES } from "./board.ts";
import { isChatterNoteKey } from "./comms.ts";
import { FLIGHT_NOT_TRIAGING_KEY } from "./flight.ts";
import { GUARD_ACK_PREFIX } from "./guard.ts";
import { isHardRulesFlagKey } from "./loop.ts";
import { MC_TOOL_NAMES } from "./mcp.ts";
import type { AttentionItem } from "./types.ts";

/**
 * The entry check for Needs you (#1543). The rules are written once, in the Needs you design spec
 * (docs/superpowers/specs/2026-11-06-comms-needs-you-flight-design.md, "Entry rules"); this is
 * their code. An item counts in the operator's list only when it is a hub alert the operator alone
 * can act on, or FLIGHT's complete question. Anything else goes back to FLIGHT with these reasons.
 */

/** Item keys of the hub's own alerts. Their words are fixed in hub code, not written by an agent. */
const ALERT_KEYS = new Set([
  FLIGHT_NOT_TRIAGING_KEY,
  // apps/server/src/update.ts HUB_UPDATE_HELD_KEY; the server test pins the two together
  "note:hub-update-held",
]);

/** A hub alert: the operator alone can act on it, and hub code wrote its words. */
export function needsYouAlert(item: Pick<AttentionItem, "key" | "kind">): boolean {
  return (
    ALERT_KEYS.has(item.key) ||
    item.key.startsWith(`note:${GUARD_ACK_PREFIX}`) ||
    item.kind === "ratelimit" ||
    // the operator's own queue reorder, with its choices written by the hub
    // (apps/server/src/queue-reorder.ts; its test pins the prefix)
    (item.kind === "approval" && item.key.startsWith(QUEUE_REORDER_ITEM_PREFIX))
  );
}

/** Item key prefix of a queue-reorder approval (`note:` + queue-reorder.ts's key prefix). */
export const QUEUE_REORDER_ITEM_PREFIX = "note:queue-reorder:";

export const NEEDS_YOU_ASK_MAX = 300;

/** brief_item's refusal of an operator brief that fails the entry check; the faults follow. */
export const BRIEF_ENTRY_REFUSED =
  "Not briefed: Needs you takes only a complete question (docs/superpowers/specs/2026-11-06-comms-needs-you-flight-design.md, Entry rules). Fix: ";

/** Text that means an agent pasted machine output instead of writing for a person. */
const RAW_TEXT: readonly [RegExp, string][] = [
  [/https?:\/\//i, "a web address (put links in the ticket or PR, not the question)"],
  [/\b[\w-]+:[\w./#-]+:\d{10,}\b/, "a raw signal id such as kind:key:1793825335003"],
  [/\b\d{12,}\b/, "a raw timestamp"],
];
const TAG_PREFIX: readonly [RegExp, string] = [/^\s*\[[^\]]+\]/, "a [tag] prefix"];

/**
 * Ids a person cannot read (#1582): a question must make sense to someone who has never seen the
 * project, so ticket and PR numbers, commit codes, paths, seat ids and tool names stay in the links.
 * A brief has no title field yet: the title check joins this one with the Needs you page (#1583).
 */
const ID_TEXT: readonly [RegExp, string][] = [
  [/#\d+|\bPR\s*\d+/i, "a ticket or PR number"],
  // a hex run with both a digit and a letter, so words like "decade" pass
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, "a commit code"],
  [/\/[\w.-]+\.[a-z]\w{0,7}\b/i, "a file path"],
  [/@capcom\b/i, "the CAPCOM tag"],
  [/\bmcp__mc__\w+|\bmc\s+[a-z]+(?:_[a-z]+)*\b/i, "a tool name"],
];

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The seat ids (and so their call signs, which differ only in case) as one pattern, or null. */
const seatPattern = (seatIds: readonly string[]): RegExp | null => {
  const names = seatIds.filter((id) => id !== "");
  return names.length === 0
    ? null
    : new RegExp(`(?<![\\w-])(?:${names.map(escapeRe).join("|")})(?![\\w-])`, "i");
};

/** Every unreadable id in `text`, named; `seatIds` are the configured seats' ids. */
const idKinds = (text: string, seatIds: readonly string[]): string[] => {
  const seat = seatPattern(seatIds);
  return [
    ...ID_TEXT.filter(([re]) => re.test(text)).map(([, what]) => what),
    ...(seat?.test(text) ? ["a seat id"] : []),
  ];
};

/** Whether `text` holds an id a person cannot read (a ticket number, commit code, path and so on). */
export const hasUnreadableId = (text: string, seatIds: readonly string[] = []): boolean =>
  RAW_TEXT.some(([re]) => re.test(text)) || idKinds(text, seatIds).length > 0;

const plainFaults = (
  part: string,
  text: string,
  raw: readonly (readonly [RegExp, string])[],
  seatIds: readonly string[],
): string[] => [
  ...raw.filter(([re]) => re.test(text)).map(([, what]) => `the ${part} has ${what}`),
  ...idKinds(text, seatIds).map((what) => `the ${part} has ${what}: say it in words`),
];

/** A context is at least one sentence: four or more words, ending in . ? or !, markdown allowed. */
const isSentence = (text: string): boolean =>
  text.split(/\s+/).length >= 4 && /[.?!]["')*_`]*$/.test(text);

/**
 * Why an item may not count in Needs you, in words FLIGHT can act on in one try. Empty when it
 * passes. `at` is the item's raised time; 0 means the hub does not know it.
 */
export function needsYouEntryFaults(
  item: Pick<AttentionItem, "key" | "kind" | "at" | "ticket" | "url" | "brief">,
  seatIds: readonly string[] = [],
): string[] {
  if (needsYouAlert(item)) return [];
  const brief = item.brief;
  // a brief with no `for` predates triage routing and was written for the operator
  if (brief === undefined || brief.for === "flight")
    return ["no brief for the operator: FLIGHT writes one with brief_item, or keeps the item"];
  const faults: string[] = [];
  const ask = brief.ask?.trim() ?? "";
  if (ask === "") faults.push("no question: say in one sentence what the operator must decide");
  else {
    if (!/\?\s*$/.test(ask)) faults.push("the question does not end with ?: ask one question");
    if (ask.length > NEEDS_YOU_ASK_MAX)
      faults.push(`the question is over ${NEEDS_YOU_ASK_MAX} characters: one sentence`);
    faults.push(...plainFaults("question", ask, [...RAW_TEXT, TAG_PREFIX], seatIds));
  }
  const context = brief.context?.trim() ?? "";
  if (context === "")
    faults.push(
      "no context: write two or three sentences saying what this is and why it comes up now",
    );
  else if (!isSentence(context))
    faults.push("the context is not a full sentence: say what this is and why it comes up now");
  faults.push(...plainFaults("context", context, RAW_TEXT, seatIds));
  const replies = brief.person?.replies?.length ?? 0;
  const n = brief.options.length;
  if (replies === 0 && (n < 2 || n > 4))
    faults.push(`${n} options: give 2 to 4, each with what happens if chosen`);
  // stored briefs are read without validation: a legacy option may lack a field
  if (brief.options.some((o) => (o.label ?? "").trim() === "" || (o.answer ?? "").trim() === ""))
    faults.push("an option has no label or no answer");
  if (brief.recommendation.trim() === "")
    faults.push("no recommendation: say which option FLIGHT would pick, and why");
  if (item.ticket === null && item.url === null && !brief.ticket && !brief.noTicket)
    faults.push("no ticket or PR: name it with ticket in brief_item");
  if (item.at <= 0) faults.push("no time raised");
  return faults;
}

export const BRIEF_TITLE_MAX = 90;

/** What `briefPartFaults` reads: the parts rule 4 adds, as the hub resolved them. */
export interface BriefParts {
  title?: string | undefined;
  ask: string;
  /** The main ticket's board priority, else the one FLIGHT stated; null when neither exists. */
  priority: string | null;
  /** The item or `ticket` names a main ticket or PR. */
  hasTicket: boolean;
  noTicket?: { repo: string; reason: string } | undefined;
  looks: boolean;
  /** Every text of the question, where a picture may be written. */
  texts: readonly string[];
  /** A branch preview is published for the question's ticket. */
  hasPreview: boolean;
}

/** A picture written in a question's text: markdown image from a hub route. */
const HUB_PICTURE = /!\[[^\]\n]*\]\(\/api\/[^)\s]+\)/;

/**
 * Rule 4's added parts of a question (#1510), each named so FLIGHT fixes the brief in one try.
 * Empty when they all hold. The older parts are `needsYouEntryFaults`.
 */
export function briefPartFaults(p: BriefParts): string[] {
  const faults: string[] = [];
  if ((p.ask.match(/\?/g)?.length ?? 0) > 1)
    faults.push(
      "the question asks more than once: one decision per question, so two are two questions",
    );
  const title = p.title?.trim() ?? "";
  if (title === "")
    faults.push(`no title: give title, one line of at most ${BRIEF_TITLE_MAX} characters`);
  else {
    if (/[\r\n]/.test(title)) faults.push("the title is not one line");
    if (title.length > BRIEF_TITLE_MAX)
      faults.push(`the title is over ${BRIEF_TITLE_MAX} characters`);
    if (/https?:\/\//i.test(title)) faults.push("the title has a web address (links go in links)");
    if (/#\d+|\bPR\s*\d+/i.test(title))
      faults.push("the title has a bare ticket number: say it in words");
  }
  if (p.priority === null || !(PRIORITIES as readonly string[]).includes(p.priority))
    faults.push(
      `no priority: the ticket has none, so state priority as one of ${PRIORITIES.join(", ")}`,
    );
  if (!p.hasTicket && (p.noTicket === undefined || p.noTicket.reason.trim() === ""))
    faults.push(
      "no ticket: name the main one with ticket, or give noTicket with the repo and a reason",
    );
  if (p.looks && !p.hasPreview && !p.texts.some((t) => HUB_PICTURE.test(t)))
    faults.push(
      "the question is about how something looks but has no picture in its text and no branch preview for its ticket",
    );
  return faults;
}

/**
 * Each `#n` and `PR n` in `text` followed by its title, so a number never stands alone. A number
 * with a title, a repo before it, a link label or no known title stays as it is.
 */
export function withTicketTitles(
  text: string,
  titleOf: (n: number, kind: "ticket" | "pr") => string | null,
): string {
  return text.replace(
    /(?<![\w/-])(?:(#)|(PR\s*#?))(\d{1,10})(?![\d\]]|\s*\()/gi,
    (whole, hash: string | undefined, _pr: string | undefined, digits: string) => {
      const title = titleOf(Number(digits), hash ? "ticket" : "pr");
      return title === null ? whole : `${whole} (${title})`;
    },
  );
}

/** The FLIGHT tool that settles an item without the operator, when its words say so; else null. */
export function flightToolFor(item: Pick<AttentionItem, "key" | "kind" | "text">): string | null {
  const key = item.key.replace(/^note:/, "");
  if (isChatterNoteKey(key)) return MC_TOOL_NAMES.dismissItem;
  if (isHardRulesFlagKey(key)) return MC_TOOL_NAMES.mergePr;
  const text = item.text;
  if (/\b(?:merge|pull|bring)\s+(?:origin\/)?main\b|\bsync[_ ]?main\b/i.test(text))
    return MC_TOOL_NAMES.syncMain;
  if (/\bre-?run\b[^.?!]{0,30}\b(?:CI|checks?|tests?|jobs?)\b/i.test(text))
    return MC_TOOL_NAMES.rerunCi;
  if (/\bclear\b[^.?!]{0,30}\b(?:flag|note|chatter)\b/i.test(text))
    return MC_TOOL_NAMES.dismissItem;
  if (/\bmerge\b[^.?!]{0,20}\b(?:PR|pull request)\b/i.test(text)) return MC_TOOL_NAMES.mergePr;
  if (/\bclose\b[^.?!]{0,20}\b(?:ticket|issue)\b/i.test(text)) return MC_TOOL_NAMES.closeTicket;
  if (/\b(?:settle|resume|unpark)\b[^.?!]{0,20}\bpark/i.test(text)) return MC_TOOL_NAMES.settlePark;
  return null;
}
