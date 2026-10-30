import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type AttentionBrief,
  type AttentionItem,
  type BoardItem,
  DEFAULT_PROFILES,
  eligibleToStart,
  globMatches,
  hudColumnOf,
  type Profile,
  priorityRank,
  type RepoRules,
  seatCallSign,
  seatDef,
  type TicketView,
} from "@mc/core";
import { activeAway } from "./away.ts";
import { type CcConfig, type CrewSeatConfig, seatInput, seatUnavailable } from "./config.ts";
import { waitReader } from "./dependencies.ts";
import { refillQueues } from "./engine/queue.ts";
import { RepoRulesError } from "./engine/rules.ts";
import { matchesFocus } from "./focus.ts";
import type { MoveResult } from "./github-board.ts";
import { chooseRunProfile, type ProfilesError } from "./profiles.ts";
import type { Store } from "./store.ts";

export interface QueueReorderDeps {
  config: CcConfig;
  store: Store;
  rules: (repoId: string) => Promise<RepoRules | RepoRulesError>;
  fetchTicket: (repo: CcConfig["repos"][number], issue: number) => Promise<TicketView | null>;
  profiles?: () => readonly Profile[] | ProfilesError;
  login: string | null;
  enabled: () => boolean;
  readCard: (repoId: string, issue: number) => Promise<BoardItem | null>;
  readBoard: (repoId: string) => Promise<BoardItem[]>;
  edit: (repoId: string, issue: number, fields: { priority: string }) => Promise<MoveResult>;
  now: () => number;
}

export class QueueReorderError extends Error {}

const PREFIX = "queue-reorder:";
interface Proposal {
  seat: string;
  repoId: string;
  cards: [BoardItem, BoardItem];
  seatSnapshot: ReturnType<typeof seatInput>;
  state: "pending" | "writing" | "approved" | "denied" | "failed";
}
const refuse = (message: string): never => {
  throw new QueueReorderError(message);
};
const seatOf = (deps: QueueReorderDeps, id: string) => {
  for (const session of deps.config.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => s.id === id);
    if (seat) return { seat, session };
  }
  return refuse("Seat unavailable; refresh the queue.");
};

function gate(deps: QueueReorderDeps, seat: CrewSeatConfig, repoId: string): void {
  const repo = deps.config.repos.find((r) => r.id === repoId);
  if (
    !deps.enabled() ||
    deps.login === null ||
    repo?.autonomy !== "merge" ||
    repo.flightPowers !== "superuser" ||
    seat.retiring ||
    seatUnavailable(seat) ||
    seatDef(seat).loop !== "build" ||
    activeAway(deps.store, deps.now(), deps.config.operator.timezone)
  )
    refuse("Queue Priority writes unavailable; refresh the queue.");
}

async function validate(
  deps: QueueReorderDeps,
  seatId: string,
  cards: [BoardItem, BoardItem],
  board: BoardItem[],
): Promise<void> {
  const { seat, session } = seatOf(deps, seatId);
  gate(deps, seat, session.repoId);
  const repo =
    deps.config.repos.find((r) => r.id === session.repoId) ?? refuse("Repository unavailable.");
  const rules = await deps.rules(repo.id);
  if (rules instanceof RepoRulesError) return refuse("Cannot read eligibility rules.");
  const queue = deps.store.queue(seatId).filter((q) => q.takenAt === null);
  const [move, above] = cards;
  if (
    !move ||
    !above ||
    move.issueNumber === above.issueNumber ||
    queue.findIndex((q) => q.repoId === repo.id && q.issue === move.issueNumber) !==
      queue.findIndex((q) => q.repoId === repo.id && q.issue === above.issueNumber) + 1 ||
    !queue.some((q) => q.repoId === repo.id && q.issue === above.issueNumber)
  )
    refuse("Queue changed; propose again from the current queue.");
  for (const card of cards) {
    const ref = `${repo.id}#${card.issueNumber}`;
    // FLIGHT applies the swap itself now, so no one approves it: those tickets are the operator's.
    if (rules.alwaysAsk.some((g) => card.labels.some((l) => globMatches(g, l, true))))
      refuse("Card is always_ask; the operator orders it.");
    if (
      card.repoId !== repo.id ||
      !card.itemId ||
      !card.projectId ||
      card.prioritySource !== "field" ||
      card.priority === null ||
      !/^P[0-9]+$/.test(card.priority) ||
      hudColumnOf(card) !== "Ready" ||
      !matchesFocus(seat.focus, card) ||
      deps.store.activeTickets().has(ref) ||
      deps.store.queue(seatId).some((q) => q.issue === card.issueNumber && q.takenAt !== null)
    )
      refuse("Card or focus changed; refresh the queue.");
    const chosen = chooseRunProfile(
      deps.profiles?.() ?? DEFAULT_PROFILES,
      card.labels,
      card.size,
      deps.store.profileOverride(repo.id, card.issueNumber),
    );
    if ("refusal" in chosen) return refuse("Card profile unavailable.");
    const ticket = await deps.fetchTicket(repo, card.issueNumber);
    if (
      !ticket ||
      ticket.bodyTruncated ||
      ticket.state !== "open" ||
      eligibleToStart({
        repoId: repo.id,
        issue: card.issueNumber,
        card,
        rules: rules,
        seat: { call: seatCallSign(seatId), area: seat.area, loop: seatDef(seat).loop },
        login: deps.login,
        hasRun: false,
        lane: deps.config.crew?.lane,
        laneDefault: deps.config.crew?.laneDefault ?? false,
        body: ticket.body,
        closed: (n) => board.find((c) => c.issueNumber === n)?.closed,
        waits: waitReader(deps.store, repo.id)(card),
      }) !== null
    )
      refuse("Card no longer eligible for this seat.");
  }
  if (!move || !above || priorityRank(move.priority) <= priorityRank(above.priority))
    refuse(
      "Priority values must be distinct and the moved card must have lower priority; equal priorities cannot change queue order.",
    );
}

async function currentBoard(deps: QueueReorderDeps, repoId: string, issues: number[]) {
  const board = await deps.readBoard(repoId);
  const cards = await Promise.all(issues.map((issue) => deps.readCard(repoId, issue)));
  if (cards.some((c) => c === null)) refuse("Ticket not on this board.");
  return [
    ...board.filter((c) => !issues.includes(c.issueNumber)),
    ...cards.filter((c): c is BoardItem => c !== null),
  ];
}

async function validateAllocation(
  deps: QueueReorderDeps,
  seatId: string,
  cards: [BoardItem, BoardItem],
  board: BoardItem[],
) {
  const swapped = board.map((c) =>
    c.issueNumber === cards[0].issueNumber
      ? { ...c, priority: cards[1].priority }
      : c.issueNumber === cards[1].issueNumber
        ? { ...c, priority: cards[0].priority }
        : c,
  );
  let hand: number[] = [];
  const store = new Proxy(deps.store, {
    get(target, key) {
      if (key === "board")
        return (repoId: string) => (repoId === cards[0].repoId ? swapped : target.board(repoId));
      if (key === "replaceQueues")
        return (queues: { seatId: string; items: { issue: number }[] }[]) => {
          const queue = queues.find((q) => q.seatId === seatId);
          if (queue) hand = queue.items.map((q) => q.issue);
        };
      if (key === "raiseNote" || key === "clearNote") return () => {};
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await refillQueues({ ...deps, store });
  const moveAt = hand.indexOf(cards[0].issueNumber);
  if (moveAt < 0 || hand.indexOf(cards[1].issueNumber) <= moveAt)
    refuse("Queue allocation cannot deliver this order for this seat.");
}

function approvalItem(
  key: string,
  p: Proposal,
  at: number,
): AttentionItem & { brief: AttentionBrief } {
  const [move, above] = p.cards;
  const call = p.seatSnapshot.displayCallSign ?? seatCallSign(p.seat);
  const text = `Move ${p.repoId}#${move.issueNumber} above ${p.repoId}#${above.issueNumber} in ${call}'s queue? That swaps their Priority on the delivery board (${move.priority} ↔ ${above.priority}).`;
  return {
    acked: false,
    key: `note:${key}`,
    kind: "approval",
    agentId: null,
    repoId: p.repoId,
    text,
    tool: null,
    at,
    url: null,
    escalationId: null,
    ticket: `${p.repoId}#${move.issueNumber}`,
    owner: "operator",
    brief: {
      for: "operator",
      original: text,
      context: text,
      ask: text,
      recommendation: "Approve or deny the Priority swap.",
      basis: "Ready queue and board Priority snapshot.",
      at,
      options: [
        { id: "approve", label: "Approve", answer: "Approve" },
        { id: "deny", label: "Deny", answer: "Deny" },
      ],
    },
  };
}

async function prepareQueueReorder(
  deps: QueueReorderDeps,
  seatId: string,
  moveRef: string,
  aboveRef: string,
) {
  const { seat, session } = seatOf(deps, seatId);
  gate(deps, seat, session.repoId);
  const board = await currentBoard(
    deps,
    session.repoId,
    [moveRef, aboveRef].map((ref) => Number(ref.split("#")[1])),
  );
  const find = (ref: string) =>
    board.find((c) => `${c.repoId}#${c.issueNumber}` === ref) ??
    refuse("Ticket not on this board.");
  const cards: [BoardItem, BoardItem] = [find(moveRef), find(aboveRef)];
  await validate(deps, seatId, cards, board);
  await validateAllocation(deps, seatId, cards, board);
  const key = `${PREFIX}${randomUUID()}`;
  const p: Proposal = {
    seat: seatId,
    repoId: session.repoId,
    cards,
    seatSnapshot: seatInput(seat),
    state: "pending",
  };
  return { key, p };
}

export async function proposeQueueReorder(
  deps: QueueReorderDeps,
  seatId: string,
  moveRef: string,
  aboveRef: string,
) {
  const { key, p } = await prepareQueueReorder(deps, seatId, moveRef, aboveRef);
  const item = approvalItem(key, p, deps.now());
  deps.store.addBrief({ key: item.key, ...item.brief });
  deps.store.saveQueueReorder(key, JSON.stringify(p), item.at, {
    key,
    kind: "approval",
    seatId: null,
    repoId: p.repoId,
    runId: null,
    text: item.text,
    at: item.at,
  });
  return { item };
}

/** Applies FLIGHT's own queue judgement through the same guarded write and recovery path. */
export async function reorderQueue(
  deps: QueueReorderDeps,
  seatId: string,
  moveRef: string,
  aboveRef: string,
) {
  const { key, p } = await prepareQueueReorder(deps, seatId, moveRef, aboveRef);
  // The pending proposal is an internal recovery record, not an operator approval: no brief, no note.
  deps.store.saveQueueReorder(key, JSON.stringify(p), deps.now());
  try {
    return await resolveQueueReorder(deps, key, "approve");
  } catch (e) {
    // Refused before any write: drop the record, so it can never be approved later.
    const raw = deps.store.getSetting(key);
    if (raw !== null && (JSON.parse(raw) as Proposal).state === "pending")
      deps.store.deleteSetting(key);
    throw e;
  }
}

const approvals = new WeakMap<Store, Promise<unknown>>();
/** Serializes approvals across proposals too: two overlapping snapshots cannot write concurrently. */
export function resolveQueueReorder(
  deps: QueueReorderDeps,
  itemKey: string,
  action: "approve" | "deny",
) {
  const run = (approvals.get(deps.store) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => resolve(deps, itemKey, action));
  approvals.set(deps.store, run);
  return run;
}

async function resolve(deps: QueueReorderDeps, itemKey: string, action: "approve" | "deny") {
  const key = itemKey.startsWith("note:") ? itemKey.slice(5) : itemKey;
  if (!key.startsWith(PREFIX)) refuse("Unknown queue approval.");
  const raw = deps.store.getSetting(key);
  if (!raw) return refuse("Unknown queue approval.");
  const p = JSON.parse(raw) as Proposal;
  if (p.state !== "pending")
    refuse("This proposal has already been handled; refresh the board before proposing again.");
  const save = (state: Proposal["state"]) => {
    p.state = state;
    deps.store.setSetting(key, JSON.stringify(p));
  };
  if (action === "deny") {
    p.state = "denied";
    deps.store.saveQueueReorder(key, JSON.stringify(p), deps.now(), undefined, key);
    return { ok: true, text: "Left the order as it is." };
  }
  const { seat, session } = seatOf(deps, p.seat);
  if (session.repoId !== p.repoId || !isDeepStrictEqual(seatInput(seat), p.seatSnapshot))
    refuse("Seat changed; propose again from the current queue.");
  const board = await currentBoard(
    deps,
    p.repoId,
    p.cards.map((c) => c.issueNumber),
  );
  const find = (snapshot: BoardItem) => {
    const card = board.find((c) => c.issueNumber === snapshot.issueNumber);
    if (
      !card ||
      card.itemId !== snapshot.itemId ||
      card.projectId !== snapshot.projectId ||
      card.priority !== snapshot.priority ||
      card.prioritySource !== snapshot.prioritySource
    )
      return refuse("Board Priority snapshot is stale; refresh and propose again.");
    return card;
  };
  const cards: [BoardItem, BoardItem] = [find(p.cards[0]), find(p.cards[1])];
  await validate(deps, p.seat, cards, board);
  await validateAllocation(deps, p.seat, cards, board);
  const latestSeat = seatOf(deps, p.seat);
  if (
    latestSeat.session.repoId !== p.repoId ||
    !isDeepStrictEqual(seatInput(latestSeat.seat), p.seatSnapshot) ||
    cards.some(
      (c) =>
        deps.store.activeTickets().has(`${p.repoId}#${c.issueNumber}`) ||
        !deps.store
          .queue(p.seat)
          .some((q) => q.repoId === p.repoId && q.issue === c.issueNumber && q.takenAt === null),
    )
  )
    refuse("Seat or queue changed; propose again.");
  gate(deps, seatOf(deps, p.seat).seat, p.repoId);
  // Persist before the first external write. A crash or uncertain response must never replay it.
  const recoveryKey = `${key}:recovery`;
  const recoveryText = `Priority swap incomplete or unconfirmed for ${p.repoId}#${cards[0].issueNumber} and ${p.repoId}#${cards[1].issueNumber}. Refresh the board and check both Priority values. Before approval: ${p.repoId}#${cards[0].issueNumber} ${cards[0].priority}; ${p.repoId}#${cards[1].issueNumber} ${cards[1].priority}. Restore these on the board if needed, then queue the move again. This record will not write again.`;
  p.state = "writing";
  deps.store.saveQueueReorder(
    key,
    JSON.stringify(p),
    deps.now(),
    {
      key: recoveryKey,
      kind: "question",
      seatId: null,
      repoId: p.repoId,
      runId: null,
      text: recoveryText,
      at: deps.now(),
    },
    key,
  );
  try {
    const swaps = [
      [cards[0], cards[1].priority],
      [cards[1], cards[0].priority],
    ] as const;
    for (const [card, priority] of swaps) {
      const result = await deps.edit(p.repoId, card.issueNumber, {
        priority: priority ?? refuse("Priority unavailable."),
      });
      if (!result.ok) throw new Error("Priority write unconfirmed.");
    }
    const fresh = await currentBoard(
      deps,
      p.repoId,
      cards.map((c) => c.issueNumber),
    );
    for (const [card, priority] of swaps) {
      const changed = fresh.find((c) => c.issueNumber === card.issueNumber);
      if (
        changed?.itemId !== card.itemId ||
        changed?.projectId !== card.projectId ||
        changed?.prioritySource !== "field" ||
        changed?.priority !== priority
      )
        throw new Error("Priority swap unconfirmed.");
    }
    deps.store.replaceBoard(p.repoId, fresh);
    await refillQueues(deps);
    const queue = deps.store.queue(p.seat);
    const moveAt = queue.findIndex(
      (q) => q.repoId === p.repoId && q.issue === cards[0].issueNumber,
    );
    const aboveAt = queue.findIndex(
      (q) => q.repoId === p.repoId && q.issue === cards[1].issueNumber,
    );
    if (moveAt < 0 || aboveAt <= moveAt) throw new Error("Queue order unconfirmed.");
    p.state = "approved";
    deps.store.saveQueueReorder(key, JSON.stringify(p), deps.now(), undefined, recoveryKey);
    return {
      ok: true,
      text: `Changed Priority on the board. ${p.seatSnapshot.displayCallSign ?? seatCallSign(p.seat)} takes ${p.repoId}#${cards[0].issueNumber} first now.`,
    };
  } catch {
    save("failed");
    return { ok: false, text: recoveryText };
  }
}
