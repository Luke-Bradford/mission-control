/**
 * Queues and picking: each writer seat in a `merge` repo has a short queue of the Ready cards its
 * area may take (`refillQueues`), and an idle seat starts the head of it (`takeNext`). Both read
 * the last poll's board from the store, so a card can be stale by one poll interval; `takeNext`
 * re-reads the card just before it starts the run, and a start the supervisor refuses gives the
 * row back. A `draft` repo is never picked for: its seats are started by hand.
 *
 * A start that fails for the card's own sake (an issue GitHub no longer has, a worktree path that
 * is not this ticket's, a protected branch) would fail again every tick and hold up the rest of the
 * queue, so the card is dropped and a note asks the operator to look; refills leave it out until it leaves
 * Ready, or is moved or edited after the failure. Any other failure is the machine's or the seat's
 * state (the seat is busy, GitHub, the fetch or the install is down): it says nothing about the
 * card, and every card would meet it, so it is retried. A seat whose takes keep failing that way
 * raises one note of its own, which clears when a take succeeds. A note holds no raw error text.
 */
import {
  areaLabelsFor,
  areaLabelsOf,
  type BoardItem,
  claimedByOther,
  DEFAULT_PROFILES,
  eligibleToStart,
  fillLoopText,
  hudColumnOf,
  NEW_LOOP,
  PRIORITIES,
  type Profile,
  QUEUE_DEPTH,
  REFUSAL_TRIES,
  type RepoId,
  type RepoRules,
  seatCallSign,
  seatDef,
  type TicketView,
} from "@mc/core";
import type { CardNow } from "../collectors/github.ts";
import {
  type CcConfig,
  type CrewSeatConfig,
  type CrewSessionConfig,
  DEFAULT_MAX_OPEN_RUNS_PER_SEAT,
} from "../config.ts";
import { chooseRunProfile, type ProfilesError } from "../profiles.ts";
import { CheckoutError, CREW_GIT_SLOW_MS, cloneGitDir } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { CREW_ACTION_FAILED, type Supervisor, SupervisorError } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { wakeDueAsideRun } from "./aside.ts";
import { RepoRulesError } from "./rules.ts";

export const TWO_AREAS_KEY_PREFIX = "question:two-areas:";
export const TWO_AREAS_TEXT = "{ref} spans two areas ({labels}); split it";
export const TAKE_FAILED_KEY_PREFIX = "question:take-failed:";
export const TAKE_FAILED_TEXT =
  "{call} could not start {ref}: {reason}. Fix that, then move the card out of Ready and back.";
export const TAKE_STUCK_KEY_PREFIX = "question:take-stuck:";
export const TAKE_STUCK_TEXT =
  "{call} has failed to take a ticket {tries} times in a row: {reason}. It keeps trying each tick; this clears when a take succeeds.";
/** The longest reason a take-failed note carries. */
const REASON_MAX = 300;

export interface QueueDeps {
  config: CcConfig;
  store: Store;
  /** A repo's board rules (read at origin/HEAD); an error means no queue is built for the repo. */
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
  /** The hub's own `gh` login; null when it could not be read, so any assigned card is another's. */
  login: string | null;
  /** A ticket as GitHub has it; a card whose body cannot be read is not dealt. */
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  /** The template profiles, read from user config on each call; default `DEFAULT_PROFILES`. */
  profiles?: () => readonly Profile[] | ProfilesError;
  now: () => number;
  /** Called when a note this module manages is raised or cleared. */
  onNotes?: () => void;
}

export interface TakeDeps {
  config: CcConfig;
  store: Store;
  supervisor: Pick<Supervisor, "startRun">;
  /** The hub's own `gh` login; null when it could not be read, and then nothing is taken. */
  login: string | null;
  /** A repo's board rules (read at origin/HEAD); an error means no card is moved between queues. */
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
  /** The card as GitHub has it now (the issue and its project item); null when it is not there. */
  readCard: (repoId: RepoId, issue: number) => Promise<CardNow | null>;
  /** Git in the session's clone (default `crewGit` on the clone's own git dir); tests fake it. */
  git?: (checkout: string, args: string[], timeoutMs: number) => Promise<string>;
  /** false: a preview, crew off, or loop writes disabled; nothing is taken. */
  enabled: boolean;
  now: () => number;
  log?: (line: string) => void;
  /** Each seat's consecutive counted transient take failures since its last successful take; one map for the hub's life. */
  transientTakes: Map<string, number>;
  /** Called when a take-failed or take-stuck note is raised or cleared. */
  onNotes?: () => void;
}

const refOf = (repoId: RepoId, issue: number) => `${repoId}#${issue}`;

/** Ticket bodies read for the queue, by card; a body is current while the card's `updatedAt` is. */
const bodyCache = new Map<string, { updatedAt: number; body: string }>();

/** Empties the body cache (for tests). */
export const clearBodyCache = (): void => bodyCache.clear();

/** Priorities in the order they are picked; a card with none, or any other, comes after. */
const priorityRank = (p: string | null): number => {
  const i = p === null ? -1 : (PRIORITIES as readonly string[]).indexOf(p);
  return i === -1 ? PRIORITIES.length : i;
};

/** The writer seats of crew sessions, with their session. */
function writerSeats(config: CcConfig): { session: CrewSessionConfig; seat: CrewSeatConfig }[] {
  const out: { session: CrewSessionConfig; seat: CrewSeatConfig }[] = [];
  for (const session of config.crew?.sessions ?? []) {
    for (const seat of session.seats) {
      if (!seat.retiring && seatDef(seat).loop === "build") out.push({ session, seat });
    }
  }
  return out;
}

const isMerge = (config: CcConfig, repoId: RepoId): boolean =>
  config.repos.find((r) => r.id === repoId)?.autonomy === "merge";

/**
 * Whether the seat may take a ticket now: it has no seat row yet, or it is idle holding no run (or
 * only one that has ended), no run of its own waits off the seat for rework (flagged to wake,
 * CI failing on its pushed sha, or its review has reported blocking findings not yet sent), and it
 * holds fewer than `maxOpenRuns` set-aside runs that are not done. A run the store
 * does not know counts as live.
 */
export function seatMayTake(
  store: Store,
  seatId: string,
  maxOpenRuns: number = DEFAULT_MAX_OPEN_RUNS_PER_SEAT,
): boolean {
  if (wakeDueAsideRun(store, seatId) !== undefined) return false;
  const open = store.asideRuns().filter((r) => r.agentId === seatId && r.loop?.phase !== "done");
  if (open.length >= maxOpenRuns) return false;
  const row = store.seatSession(seatId);
  if (row === null) return true;
  if (row.state !== "idle") return false;
  return row.runId === null || store.run(row.runId)?.endedAt != null;
}

/** The cap on a writer seat's unfinished runs. */
export const maxOpenRunsOf = (config: CcConfig): number =>
  config.crew?.maxOpenRunsPerSeat ?? DEFAULT_MAX_OPEN_RUNS_PER_SEAT;

/** The cards in the Ready column (a closed card is Done, never Ready), in the order picked. */
function readyCards(store: Store, repoId: RepoId): BoardItem[] {
  return store
    .board(repoId)
    .filter((c) => hudColumnOf(c) === "Ready")
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        a.createdAt - b.createdAt ||
        a.issueNumber - b.issueNumber,
    );
}

/**
 * Rebuilds every writer seat's queue in each `merge` repo whose rules can be read, and raises or
 * clears the "split it" question for a Ready card with two or more area labels.
 */
export async function refillQueues(deps: QueueDeps): Promise<void> {
  const { config, store, now } = deps;
  const seats = writerSeats(config);
  const maxOpen = maxOpenRunsOf(config);
  const rulesOf = new Map<RepoId, RepoRules>();
  /** Repos a queue may be built for; one whose rules cannot be read is in here but not above. */
  const eligible = new Set<RepoId>();
  for (const repoId of new Set(seats.map((s) => s.session.repoId))) {
    if (!isMerge(config, repoId)) continue;
    eligible.add(repoId);
    const rules = await deps.rules(repoId);
    if (!(rules instanceof RepoRulesError)) rulesOf.set(repoId, rules);
  }
  // read after the awaits: a run that began while the rules were read is not queued again
  const active = store.activeTickets();

  // the "spans two areas" notes: one per Ready card with two area labels, gone when it has not
  const openAt = new Map(store.notes().map((n) => [n.key, n.at]));
  const wanted = new Set<string>();
  let changed = false;
  for (const [repoId, rules] of rulesOf) {
    for (const card of readyCards(store, repoId)) {
      const labels = areaLabelsOf(rules, card);
      if (labels.length < 2) continue;
      const ref = refOf(repoId, card.issueNumber);
      const key = `${TWO_AREAS_KEY_PREFIX}${ref}`;
      wanted.add(key);
      if (!openAt.has(key)) changed = true;
      store.raiseNote({
        key,
        kind: "question",
        runId: null,
        seatId: null,
        repoId,
        text: fillLoopText(TWO_AREAS_TEXT, { ref, labels: labels.join(", ") }),
        at: now(),
      });
    }
  }
  // a take-failed note stays while its card is Ready and untouched since the failure: it keeps
  // the card out of the queues; a card moved out of Ready and back, or edited, is dealt again
  const failed = new Set<string>();
  for (const [repoId] of rulesOf) {
    for (const card of readyCards(store, repoId)) {
      const key = `${TAKE_FAILED_KEY_PREFIX}${refOf(repoId, card.issueNumber)}`;
      const at = openAt.get(key);
      if (at !== undefined && card.updatedAt <= at) failed.add(key);
    }
  }
  // a take-stuck note stays while its seat is a writer in a repo that is still taken by rule
  const stuckKeep = new Set(
    seats
      .filter((s) => eligible.has(s.session.repoId))
      .map((s) => `${TAKE_STUCK_KEY_PREFIX}${s.seat.id}`),
  );
  for (const n of store.notes()) {
    const keep = n.key.startsWith(TWO_AREAS_KEY_PREFIX)
      ? wanted
      : n.key.startsWith(TAKE_FAILED_KEY_PREFIX)
        ? failed
        : n.key.startsWith(TAKE_STUCK_KEY_PREFIX)
          ? stuckKeep
          : null;
    if (keep === null || keep.has(n.key)) continue;
    // unreadable rules leave a note alone: the next read decides; a repo that is no longer a
    // `merge` repo with a writer seat will not be read again, so its notes go
    if (n.repoId !== null && eligible.has(n.repoId) && !rulesOf.has(n.repoId)) continue;
    store.clearNote(n.key, now());
    changed = true;
  }
  if (changed) deps.onNotes?.();

  // one deal per repo: a card goes to one seat, idle seats first
  const takenRefs = new Set<string>();
  for (const { seat } of seats) {
    for (const q of store.queue(seat.id)) {
      if (q.takenAt !== null) takenRefs.add(refOf(q.repoId, q.issue));
    }
  }
  const readyRefs = new Set<string>();
  for (const [repoId, rules] of rulesOf) {
    const group = seats.filter((s) => s.session.repoId === repoId);
    const order = [
      ...group.filter((s) => seatMayTake(store, s.seat.id, maxOpen)),
      ...group.filter((s) => !seatMayTake(store, s.seat.id, maxOpen)),
    ];
    const board = store.board(repoId);
    const repo = config.repos.find((r) => r.id === repoId);
    const cards: { issue: number; label: string }[] = [];
    for (const card of readyCards(store, repoId)) {
      const ref = refOf(repoId, card.issueNumber);
      readyRefs.add(ref);
      if (failed.has(`${TAKE_FAILED_KEY_PREFIX}${ref}`)) continue;
      // the card's template profile says whether it needs a plan; fails closed like an unreadable
      // body: an unreadable profiles file, or a stored override naming no profile, deals nothing
      const chosen = chooseRunProfile(
        deps.profiles?.() ?? DEFAULT_PROFILES,
        card.labels,
        card.size,
        store.profileOverride(repoId, card.issueNumber),
      );
      if ("refusal" in chosen) continue;
      // the one start check every start applies
      const startable = (body: string | null): boolean =>
        group.some(
          ({ seat }) =>
            eligibleToStart({
              planRequired: chosen.profile.planRequired,
              repoId,
              issue: card.issueNumber,
              card,
              rules,
              seat: { call: seatCallSign(seat.id), area: seat.area, loop: seatDef(seat).loop },
              login: deps.login,
              hasRun: takenRefs.has(ref) || active.has(ref),
              lane: config.crew?.lane,
              laneDefault: config.crew?.laneDefault ?? false,
              body,
              closed: (n) => board.find((i) => i.issueNumber === n)?.closed,
            }) === null,
        );
      // the board alone first: only a card that passes it has its body read
      if (!startable(null)) continue;
      // fails closed: a body that cannot be read, or a ticket GitHub no longer has, is not dealt
      // a body is read again only when the card has changed since (updatedAt includes the issue's)
      const hit = bodyCache.get(ref);
      let body: string;
      if (hit !== undefined && hit.updatedAt === card.updatedAt) body = hit.body;
      else {
        try {
          const ticket = repo === undefined ? null : await deps.fetchTicket(repo, card.issueNumber);
          if (ticket === null) continue;
          body = ticket.body;
        } catch {
          continue;
        }
        bodyCache.set(ref, { updatedAt: card.updatedAt, body });
      }
      if (!startable(body)) continue;
      const labels = areaLabelsOf(rules, card);
      const label = labels[0];
      if (labels.length === 1 && label !== undefined)
        cards.push({ issue: card.issueNumber, label });
    }
    const hands = dealQueues(
      order.map((s) => ({ id: s.seat.id, labels: areaLabelsFor(rules, s.seat.area) })),
      cards,
      QUEUE_DEPTH,
    );
    store.replaceQueues(
      order.map((s) => ({
        seatId: s.seat.id,
        items: (hands.get(s.seat.id) ?? []).map((issue) => ({ repoId, issue })),
      })),
    );
  }
  for (const ref of bodyCache.keys()) if (!readyRefs.has(ref)) bodyCache.delete(ref);
}

/**
 * Round-robin: each card, in order, goes to the first seat, searching from the one after the
 * previous card's seat (seats[0] for the first card), whose labels include its label and whose
 * hand has fewer than `depth`; else to no one. Every seat is in the result, hand maybe empty.
 */
export function dealQueues(
  seats: readonly { id: string; labels: readonly string[] }[],
  cards: readonly { issue: number; label: string }[],
  depth: number,
): Map<string, number[]> {
  const hands = new Map<string, number[]>(seats.map((s) => [s.id, []]));
  let next = 0;
  for (const card of cards) {
    for (let k = 0; k < seats.length; k++) {
      const i = (next + k) % seats.length;
      const seat = seats[i];
      const hand = seat === undefined ? undefined : hands.get(seat.id);
      if (seat === undefined || hand === undefined) continue;
      if (!seat.labels.includes(card.label) || hand.length >= depth) continue;
      hand.push(card.issue);
      next = i + 1;
      break;
    }
  }
  return hands;
}

/** What a note may say of a refused start: the error's fixed text, never a path or git's own. */
export function takeReason(e: unknown): string {
  if (e instanceof CheckoutError || e instanceof SupervisorError) return e.message;
  return `${CREW_ACTION_FAILED} (${e instanceof Error ? e.name : typeof e})`;
}

/** Whether a refused start is the card's own: a stray worktree path, a protected branch, an issue GitHub doesn't have. */
const isCardsOwn = (e: unknown): boolean =>
  (e instanceof SupervisorError && (e.status === 404 || e.status === 422)) ||
  (e instanceof CheckoutError && (e.code === "path" || e.code === "protected"));

/**
 * Whether a refused review start is retried unchanged: the seat is busy or the hub is stopping
 * (409), GitHub could not be read (502), or the clone could not be fetched or is not ready.
 * Anything else fails the attempt (capped by REVIEW_ATTEMPTS).
 */
export const isTransientStart = (e: unknown): boolean =>
  (e instanceof SupervisorError && (e.status === 409 || e.status === 502)) ||
  (e instanceof CheckoutError && (e.code === "fetch" || e.code === "checkout"));

/**
 * A seat about to take picks, in `readyCards` order, the first card of its own queue and the queues
 * of the seats that may not take now (busy, or at their account's quota stop), among the cards its area labels cover. A card from another
 * seat's queue moves to the head of this seat's, so a busy seat's queue never holds back a higher
 * Priority. A card a seat holds taken stays with it.
 */
async function claimBestReady(deps: TakeDeps, repoId: RepoId, seat: CrewSeatConfig): Promise<void> {
  const { config, store } = deps;
  const rules = await deps.rules(repoId);
  if (rules instanceof RepoRulesError) return;
  const own = store.queue(seat.id);
  if (own.some((q) => q.takenAt !== null)) return;
  const labels = areaLabelsFor(rules, seat.area);
  const holder = new Map<number, string>();
  for (const q of own) if (q.repoId === repoId) holder.set(q.issue, seat.id);
  for (const { session, seat: other } of writerSeats(config)) {
    if (
      other.id === seat.id ||
      session.repoId !== repoId ||
      (seatMayTake(store, other.id, maxOpenRunsOf(config)) && !atQuotaStop(deps, other.accountId))
    ) {
      continue;
    }
    for (const q of store.queue(other.id)) {
      if (q.repoId === repoId && q.takenAt === null) holder.set(q.issue, other.id);
    }
  }
  const best = readyCards(store, repoId).find((c) => {
    const l = areaLabelsOf(rules, c);
    const label = l[0];
    return (
      holder.has(c.issueNumber) && l.length === 1 && label !== undefined && labels.includes(label)
    );
  });
  if (best === undefined) return;
  const from = holder.get(best.issueNumber);
  if (from === undefined || from === seat.id) return;
  store.dropQueued(from, repoId, best.issueNumber);
  store.replaceQueue(seat.id, [
    { repoId, issue: best.issueNumber },
    ...own
      .filter((q) => q.issue !== best.issueNumber)
      .map((q) => ({ repoId: q.repoId, issue: q.issue })),
  ]);
}

/** The first of the ticket's branches on origin that no run of this hub is on, else null. */
async function foreignBranch(
  deps: TakeDeps,
  checkout: string,
  repoId: RepoId,
  issue: number,
): Promise<string | null> {
  const git =
    deps.git ??
    (async (cwd, args, timeoutMs) => {
      const common = await cloneGitDir(cwd);
      return crewGit(cwd, args, common, { gitDir: common, timeoutMs });
    });
  const out = await git(
    checkout,
    ["ls-remote", "--heads", "origin", `feature/${issue}`, `feature/${issue}-*`],
    CREW_GIT_SLOW_MS,
  );
  for (const line of out.split("\n")) {
    const name = line.split("\t")[1]?.trim();
    if (name === undefined || !name.startsWith("refs/heads/")) continue;
    const branch = name.slice("refs/heads/".length);
    if (!deps.store.hasRunOnBranch(repoId, branch)) return branch;
  }
  return null;
}

/**
 * The seat's next queued ticket, started as a looped run. Nothing happens for a draft repo, a
 * preview, a seat that is not idle or has a run, or an account at its quota stop.
 */
export async function takeNext(deps: TakeDeps, seatId: string): Promise<void> {
  const { config, store, supervisor } = deps;
  if (!deps.enabled || deps.login === null) return;
  const found = writerSeats(config).find((s) => s.seat.id === seatId);
  if (found === undefined || !isMerge(config, found.session.repoId)) return;
  if (!seatMayTake(store, seatId, maxOpenRunsOf(config))) return;
  if (atQuotaStop(deps, found.seat.accountId)) return;
  await claimBestReady(deps, found.session.repoId, found.seat);

  const taken = store.takeQueued(seatId, deps.now());
  if (taken === null) return;
  const { repoId, issue } = taken;
  const ref = refOf(repoId, issue);
  const card = store.board(repoId).find((c) => c.issueNumber === issue);
  // The card may have moved since the poll, and another seat may have been started on it by hand.
  if (card === undefined || hudColumnOf(card) !== "Ready" || store.activeTickets().has(ref)) {
    store.dropQueued(seatId, repoId, issue);
    return;
  }
  // The poll is up to a minute old and another hub may have claimed the card since: read it fresh.
  // The row goes back; the next refill, from a newer poll, decides whether it is dealt again.
  let latest: CardNow | null;
  try {
    latest = await deps.readCard(repoId, issue);
  } catch (e) {
    store.untake(seatId, repoId, issue);
    deps.log?.(`${seatId}: could not read ${ref} from GitHub: ${takeReason(e)}`);
    return;
  }
  if (latest === null || hudColumnOf(latest) !== "Ready" || claimedByOther(latest, deps.login)) {
    store.untake(seatId, repoId, issue);
    deps.log?.(`${seatId}: ${ref} is no longer Ready and unclaimed on GitHub`);
    return;
  }
  // GitHub's API can lag behind another hub's claim; origin's refs do not. A branch for the ticket
  // that no run of this hub made is another hub's work.
  let foreign: string | null;
  try {
    foreign = await foreignBranch(deps, found.session.checkout, repoId, issue);
  } catch (e) {
    if (!(e instanceof CheckoutError)) {
      store.untake(seatId, repoId, issue);
      deps.log?.(`${seatId}: could not list origin's branches for ${ref}: ${takeReason(e)}`);
      return;
    }
    // a broken clone: startRun refuses it the same way, and counts it toward the take-stuck note
    foreign = null;
  }
  if (foreign !== null) {
    store.dropQueued(seatId, repoId, issue);
    deps.log?.(`${seatId}: ${ref} already has a branch on origin (${foreign}); not started`);
    // without a note the next refill deals the card again and it holds up the rest of the queue
    store.raiseNote({
      key: `${TAKE_FAILED_KEY_PREFIX}${ref}`,
      kind: "question",
      runId: null,
      seatId,
      repoId,
      text: fillLoopText(TAKE_FAILED_TEXT, {
        call: seatCallSign(seatId),
        ref,
        reason: `it already has a branch on origin (${foreign})`.slice(0, REASON_MAX),
      }),
      at: deps.now(),
    });
    deps.onNotes?.();
    return;
  }
  try {
    await supervisor.startRun(seatId, issue, { loop: NEW_LOOP });
    store.dropQueued(seatId, repoId, issue);
    deps.transientTakes.delete(seatId);
    const stuckKey = `${TAKE_STUCK_KEY_PREFIX}${seatId}`;
    if (store.notes().some((n) => n.key === stuckKey)) {
      store.clearNote(stuckKey, deps.now());
      deps.onNotes?.();
    }
  } catch (e) {
    const reason = takeReason(e);
    const logText =
      e instanceof CheckoutError
        ? e.detail === null
          ? reason
          : `${reason} (${e.detail})`
        : e instanceof SupervisorError
          ? reason
          : `${reason}: ${e instanceof Error ? e.message : String(e)}`;
    if (isCardsOwn(e)) {
      store.dropQueued(seatId, repoId, issue);
      deps.log?.(`${seatId}: dropped ${ref}: ${logText}`);
      store.raiseNote({
        key: `${TAKE_FAILED_KEY_PREFIX}${ref}`,
        kind: "question",
        runId: null,
        seatId,
        repoId,
        text: fillLoopText(TAKE_FAILED_TEXT, {
          call: seatCallSign(seatId),
          ref,
          reason: reason.slice(0, REASON_MAX),
        }),
        at: deps.now(),
      });
      deps.onNotes?.();
      return;
    }
    store.untake(seatId, repoId, issue);
    deps.log?.(`${seatId}: could not take ${ref}: ${logText}`);
    // a seat that could not start its CLI shows its own error state; a busy seat is no failure
    if (e instanceof SupervisorError && (e.status === 500 || e.status === 409)) return;
    const n = (deps.transientTakes.get(seatId) ?? 0) + 1;
    deps.transientTakes.set(seatId, n);
    const stuckKey = `${TAKE_STUCK_KEY_PREFIX}${seatId}`;
    if (n >= REFUSAL_TRIES && !store.notes().some((x) => x.key === stuckKey)) {
      store.raiseNote({
        key: stuckKey,
        kind: "question",
        runId: null,
        seatId,
        repoId: found.session.repoId,
        text: fillLoopText(TAKE_STUCK_TEXT, {
          call: seatCallSign(seatId),
          tries: String(REFUSAL_TRIES),
          reason: reason.slice(0, REASON_MAX),
        }),
        at: deps.now(),
      });
      deps.onNotes?.();
    }
  }
}

/** Whether either usage window of the account is at its stop (a window that has reset is not). */
export function accountAtStop(
  config: CcConfig,
  store: Store,
  accountId: string,
  at: number,
): boolean {
  const account = config.accounts.find((a) => a.id === accountId);
  if (account === undefined) return false;
  return (["5h", "7d"] as const).some((window) => {
    const latest = store.latestUsage(accountId, window);
    return latest !== null && latest.resetAt > at && latest.pct >= account.stopAt;
  });
}

const atQuotaStop = (deps: TakeDeps, accountId: string): boolean =>
  accountAtStop(deps.config, deps.store, accountId, deps.now());
