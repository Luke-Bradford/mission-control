import {
  type AttentionItem,
  type BoardItem,
  COMMS_CAPCOM,
  type CommsAgentResponse,
  type CrewRow,
  HUD_PAGE_PATHS,
  type PullRequestView,
} from "@mc/core";
import { seatError } from "../agent/seat.ts";
import { ApiError, apiPost } from "../api.ts";
import { ticketForRef } from "../comms/model.ts";
import { callSign, seatName } from "../crew.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";
import { checkedHead, markChecked, undoChecked } from "../qa/checked.ts";
import {
  agentPath,
  commsAgentPath,
  commsContactPath,
  commsCrewPath,
  commsFlightPath,
  commsTicketPath,
  itemPath,
  navigate,
  type Page,
  ticketPath,
} from "../router.ts";
import { toast } from "../shell/Toast.tsx";

/** How many recent picks the palette lists first. */
export const RECENT_LIMIT = 5;

/** The order groups sort in when two entries score the same. */
export const GROUPS = ["Page", "Action", "Seat", "Ticket", "PR", "Thread", "Needs you"] as const;
export type Group = (typeof GROUPS)[number];

export interface PaletteEntry {
  /** Stable across renders, so a recent pick can be found again (`ticket:shop-app#3349`). */
  id: string;
  group: Group;
  title: string;
  /** A quieter second line (the repo, the state). */
  hint?: string;
  /** What gets matched against; the title and hint when absent. */
  haystack?: string;
  run: () => void | Promise<void>;
}

const PAGE_TITLES: Record<Page, string> = {
  overview: "Overview",
  flight: "FLIGHT",
  board: "Board",
  agent: "Agent",
  map: "Map",
  comms: "Comms",
  telemetry: "Telemetry",
  audit: "Audit",
  setup: "Setup",
};

/** Sources the palette reads; `undefined` lists are still loading and add no entries. */
export interface PaletteSources {
  rows?: readonly CrewRow[];
  tickets?: readonly BoardItem[];
  prs?: readonly PullRequestView[];
  /** Needs-you items (attention), which open the Item panel. */
  threads?: readonly AttentionItem[];
  /** Each crew seat's stored Comms (`/api/comms/agents/:id`), for conversations and ticket threads. */
  comms?: readonly { agentId: string; data: CommsAgentResponse }[];
  /** A seat in this repo that is free to start a ticket; null when there is none. */
  freeSeatFor?: (repoId: string) => string | null;
}

const refText = (repoId: string, n: number): string => `${repoId}#${n}`;

/** The error text an operator action's failure shows: the server's own words, else a fixed one. */
const actionError = (e: unknown): string =>
  e instanceof ApiError ? e.message : "server unreachable";

async function setPaused(row: CrewRow): Promise<void> {
  const name = callSign(row);
  try {
    await apiPost(row.paused ? ACTIONS.resume(row.id) : ACTIONS.pause(row.id));
    toast(row.paused ? `${name} resumed.` : `${name} paused.`);
  } catch (e) {
    toast(actionError(e));
  } finally {
    hub.refetch(RESOURCES.crew.path);
  }
}

async function startSeat(seatId: string, t: BoardItem): Promise<void> {
  try {
    await apiPost(ACTIONS.seatStart(seatId), { issue: t.issueNumber });
    hub.refetch(RESOURCES.crew.path);
    toast(
      `${callSign({ id: seatId, kind: "crew" })} started on ${refText(t.repoId, t.issueNumber)}.`,
    );
    navigate(agentPath(seatId));
  } catch (e) {
    toast(seatError(e));
  }
}

function openPr(pr: PullRequestView): void {
  const m = pr.ticket ? /^(.+)#([1-9]\d*)$/.exec(pr.ticket) : null;
  if (m?.[1] && m[2]) navigate(ticketPath(m[1], Number(m[2])));
  else window.open(pr.url, "_blank", "noopener,noreferrer");
}

const TICKET_REF = /^(?:PR \d+|#\d+)$/;

/** The Comms conversations: FLIGHT's, the crew channel, each seat's, its contacts' and ticket threads. */
function commsEntries(src: PaletteSources): PaletteEntry[] {
  const out: PaletteEntry[] = [
    {
      id: "comms:flight",
      group: "Thread",
      title: "Comms · FLIGHT",
      hint: "with CAPCOM",
      run: () => navigate(commsFlightPath()),
    },
    {
      id: "comms:crew",
      group: "Thread",
      title: "Comms · Crew channel",
      run: () => navigate(commsCrewPath()),
    },
  ];
  const seenPairs = new Set<string>();
  const seenTickets = new Set<string>();
  const name = (id: string) => (id === COMMS_CAPCOM ? "CAPCOM" : seatName(id, src.rows));
  for (const { agentId, data } of src.comms ?? []) {
    out.push({
      id: `comms:agent:${agentId}`,
      group: "Thread",
      title: `Comms · ${name(agentId)}`,
      hint: "all messages",
      haystack: `comms ${name(agentId)} ${agentId}`,
      run: () => navigate(commsAgentPath(agentId)),
    });
    for (const c of data.contacts) {
      const pair = [agentId, c.id].sort().join("|");
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      out.push({
        id: `comms:contact:${agentId}:${c.id}`,
        group: "Thread",
        title: `${name(agentId)} ↔ ${name(c.id)}`,
        hint: c.lastMessage?.text,
        haystack: `${name(agentId)} ${agentId} ${name(c.id)} ${c.id} ${c.lastMessage?.text ?? ""}`,
        run: () => navigate(commsContactPath(agentId, c.id)),
      });
    }
    for (const m of data.messages) {
      if (!m.ref || !TICKET_REF.test(m.ref)) continue;
      const ticket = ticketForRef(m.ref, m.ticket);
      const key = `${m.ref}|${ticket ?? ""}`;
      if (seenTickets.has(key)) continue;
      seenTickets.add(key);
      out.push({
        id: `comms:ticket:${key}`,
        group: "Thread",
        title: `Comms · ${ticket ?? m.ref}`,
        hint: m.text,
        haystack: `comms ${m.ref} ${ticket ?? ""} ${m.text}`,
        run: () => navigate(commsTicketPath(m.ref as string, ticket)),
      });
    }
  }
  return out;
}

/** Every thing the palette can reach or do right now, from what the HUD has already loaded. */
export function buildEntries(src: PaletteSources): PaletteEntry[] {
  const out: PaletteEntry[] = (Object.keys(PAGE_TITLES) as Page[]).map((page) => ({
    id: `page:${page}`,
    group: "Page",
    title: PAGE_TITLES[page],
    hint: HUD_PAGE_PATHS[page],
    run: () => navigate(HUD_PAGE_PATHS[page]),
  }));
  for (const row of src.rows ?? []) {
    const name = callSign(row);
    out.push({
      id: `seat:${row.id}`,
      group: "Seat",
      title: name,
      hint: row.repoId,
      haystack: `${name} ${row.id} ${row.repoId}`,
      run: () => navigate(agentPath(row.id)),
    });
    // The pause file belongs to observed TA loops; a studio loop waits for the cutover.
    if (row.kind === "loop" && row.loopKind === "ta-loop") {
      out.push({
        id: `action:${row.paused ? "resume" : "pause"}:${row.id}`,
        group: "Action",
        title: `${row.paused ? "Resume" : "Pause"} ${name}`,
        hint: row.repoId,
        run: () => setPaused(row),
      });
    }
  }
  for (const t of src.tickets ?? []) {
    if (t.closed || t.state === "done") continue;
    const ref = refText(t.repoId, t.issueNumber);
    out.push({
      id: `ticket:${ref}`,
      group: "Ticket",
      title: `${ref} ${t.title}`,
      hint: t.state,
      run: () => navigate(ticketPath(t.repoId, t.issueNumber)),
    });
    const seat = src.freeSeatFor?.(t.repoId) ?? null;
    if (seat) {
      out.push({
        id: `action:start:${ref}`,
        group: "Action",
        title: `Start a seat on ${ref}`,
        hint: `${callSign({ id: seat, kind: "crew" })} · ${t.title}`,
        haystack: `start ${ref} ${t.title}`,
        run: () => startSeat(seat, t),
      });
    }
  }
  for (const pr of src.prs ?? []) {
    if (pr.state !== "open") continue;
    out.push({
      id: `pr:${refText(pr.repoId, pr.number)}`,
      group: "PR",
      title: `${pr.repoId} PR ${pr.number} ${pr.title}`,
      hint: pr.ticket ?? undefined,
      haystack: `${pr.repoId} pr ${pr.number} #${pr.number} ${pr.title}`,
      run: () => openPr(pr),
    });
    // The same local mark the PR readiness tab keeps; without a head SHA there is nothing to mark.
    if (pr.headSha) {
      const head = pr.headSha;
      const label = `${pr.repoId} PR ${pr.number}`;
      const isChecked = checkedHead(pr.repoId, pr.number) === head;
      out.push({
        id: `action:${isChecked ? "uncheck" : "check"}:${refText(pr.repoId, pr.number)}`,
        group: "Action",
        title: isChecked ? `Undo checked on ${label}` : `Mark ${label} checked`,
        hint: isChecked ? "checked at this head" : pr.title,
        haystack: `${isChecked ? "undo uncheck" : "mark check"} checked ${label} #${pr.number} ${pr.title}`,
        run: () => {
          if (isChecked) undoChecked(pr.repoId, pr.number);
          else markChecked(pr.repoId, pr.number, head);
          toast(isChecked ? `${label} check undone.` : `${label} marked checked.`);
        },
      });
    }
  }
  out.push(...commsEntries(src));
  for (const th of src.threads ?? []) {
    out.push({
      id: `need:${th.key}`,
      group: "Needs you",
      title: th.text,
      hint: th.key,
      haystack: `${th.key} ${th.text}`,
      run: () => navigate(itemPath(th.key)),
    });
  }
  return out;
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);

function tokenScore(token: string, hay: string): number | null {
  const at = hay.indexOf(token);
  if (at === 0) return 1000;
  if (at > 0) return (isWordChar(hay[at - 1]) ? 600 : 800) - Math.min(at, 100);
  // a subsequence: every letter in order, rewarded for letters that sit together
  let from = 0;
  let score = 100;
  let prev = -2;
  for (const ch of token) {
    const i = hay.indexOf(ch, from);
    if (i < 0) return null;
    if (i === prev + 1) score += 10;
    prev = i;
    from = i + 1;
  }
  return score;
}

/**
 * How well `query` matches `text`: null when it does not. Every space-separated word must match,
 * either as a substring (a start of text or of a word scores highest) or letters in order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const hay = text.toLowerCase();
  let total = 0;
  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const s = tokenScore(token.replace(/^#/, "") || token, hay);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/**
 * The entries to list for `query`, best first. With nothing typed: the recent picks (by id,
 * newest first, at most five), then the pages. A recent id that no longer exists is skipped.
 */
export function filterEntries(
  entries: readonly PaletteEntry[],
  query: string,
  recent: readonly string[],
): PaletteEntry[] {
  if (query.trim() === "") {
    const picked = recent
      .slice(0, RECENT_LIMIT)
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is PaletteEntry => e !== undefined);
    const rest = entries.filter((e) => e.group === "Page" && !picked.includes(e));
    return [...picked, ...rest];
  }
  const scored: { e: PaletteEntry; s: number }[] = [];
  for (const e of entries) {
    const s = fuzzyScore(query, e.haystack ?? `${e.title} ${e.hint ?? ""}`);
    if (s !== null) scored.push({ e, s });
  }
  return scored
    .sort((a, b) => b.s - a.s || GROUPS.indexOf(a.e.group) - GROUPS.indexOf(b.e.group))
    .map((x) => x.e);
}
