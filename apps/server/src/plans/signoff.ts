/** The operator's sign-off of a ticket's plan: the Planner tab's lists, Approve and Send back. */
import {
  type BoardItem,
  COMMS_MC,
  hudColumnOf,
  PLAN_APPROVED_COMMS,
  PLAN_NO_SUCH,
  PLAN_NOT_WAITING,
  type PlansView,
  planApprovedNotMovedComms,
  planHolds,
  planSentBackComms,
  type RepoRules,
  type TicketPlan,
  type TicketView,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { prototypeBlock, readyBlock, readyEarlyBlock } from "../flight/ready-checks.ts";
import { flightSeat } from "../flight/seat.ts";
import type { Move, MoveResult } from "../github/board.ts";
import type { Store } from "../store.ts";

export interface SignoffDeps {
  store: Store;
  config: CcConfig;
  now: () => number;
  /** The repo's rules as the engine reads them. */
  rules: (repoId: string) => Promise<RepoRules | Error>;
  /** Moves a card on the board; absent: approval signs off and leaves the card. */
  move?: (m: Move) => Promise<MoveResult>;
  /** One card read fresh from the board: approval moves a card only on its live state. */
  readCard?: (repoId: string, issue: number) => Promise<BoardItem | null>;
  /** Reads the ticket's body, for the checks a card passes before Ready. */
  fetchTicket?: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
}

export type SignoffResult =
  | { ok: true; plan: TicketPlan; moved: boolean; moveError: string | null }
  | { ok: false; status: 404 | 409 | 502; error: string };

/** The plan with its title from the board copy, when the ticket is still on the board. */
export function withTitle(store: Store, plan: TicketPlan): TicketPlan {
  const card = store.boardItem(plan.repoId, plan.issue);
  return { ...plan, title: card?.title ?? null };
}

/** A configured repo's plan for the ticket page, or null. */
export function ticketPlan(
  store: Store,
  config: CcConfig,
  repoId: string,
  issue: number,
): TicketPlan | null {
  if (!config.repos.some((r) => r.id === repoId)) return null;
  const plan = store.plans.get(repoId, issue);
  return plan === null ? null : withTitle(store, plan);
}

/** Whether the ticket's card is closed in the board copy: a closed ticket has no plan left to decide. */
const closedTicket = (store: Store, plan: TicketPlan): boolean =>
  store.boardItem(plan.repoId, plan.issue)?.closed === true;

/** The Planner tab: what waits for a plan or sign-off, and what was signed off. */
export function plansView(store: Store, config: CcConfig): PlansView {
  const known = new Set(config.repos.map((r) => r.id));
  const keep = (p: TicketPlan) => known.has(p.repoId);
  return {
    waiting: store.plans
      .inStates(["awaiting-plan", "sent-back", "awaiting-signoff"])
      .filter((p) => keep(p) && !closedTicket(store, p))
      .map((p) => withTitle(store, p)),
    history: store.plans
      .signedOff()
      .filter(keep)
      .map((p) => withTitle(store, p)),
  };
}

/** The repo's live rules, or null when they cannot be read (decisions then fail closed). */
const rulesOf = async (deps: SignoffDeps, repoId: string): Promise<RepoRules | null> => {
  const rules = await deps.rules(repoId);
  return rules instanceof Error ? null : rules;
};

const tellFlight = (deps: SignoffDeps, plan: TicketPlan, text: string): void => {
  const flight = flightSeat(deps.config)?.seat.id;
  if (flight === undefined) return;
  deps.store.addComms({
    at: deps.now(),
    from: COMMS_MC,
    senderKind: "hub",
    to: flight,
    ticket: plan.ref,
    text,
  });
};

/** One decision at a time per ticket, so a double submit or an approve racing a send back cannot both win. */
const approving = new Map<string, Promise<unknown>>();

/**
 * Signs a plan off. A plan the repo holds its ticket for first moves the card to Ready (from
 * Backlog or Refinement); only when that succeeds is the plan marked signed off, so a failed move
 * leaves it waiting and the operator can try again. A plan that holds nothing is recorded and the
 * card stays where it is.
 */
export function approvePlan(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
): Promise<SignoffResult> {
  return decided(repoId, issue, () => approveOne(deps, repoId, issue));
}

function decided(
  repoId: string,
  issue: number,
  fn: () => Promise<SignoffResult>,
): Promise<SignoffResult> {
  const key = `${repoId}#${issue}`;
  const run = (approving.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  approving.set(key, tail);
  void tail.then(() => {
    if (approving.get(key) === tail) approving.delete(key);
  });
  return run;
}

/** Why a card cannot go to Ready yet (the checks promote runs), or null when it can. */
async function notReadyWhy(
  deps: SignoffDeps,
  repoId: string,
  ref: string,
  card: BoardItem,
  rules: RepoRules,
): Promise<string | null> {
  const early = readyEarlyBlock(deps.store, ref, card);
  if (early !== null) return early;
  const repo = deps.config.repos.find((r) => r.id === repoId);
  let ticket: TicketView | null = null;
  try {
    ticket =
      repo === undefined || deps.fetchTicket === undefined
        ? null
        : await deps.fetchTicket(repo, card.issueNumber);
  } catch {
    ticket = null;
  }
  if (ticket === null) return `${ref} could not be read to check it is ready.`;
  const prototype = prototypeBlock(ref, ticket, repo?.github);
  if (prototype !== null) return prototype;
  return readyBlock({ store: deps.store, repoId, ref, card, body: ticket.body, rules });
}

async function approveOne(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
): Promise<SignoffResult> {
  const plan = deps.store.plans.get(repoId, issue);
  if (plan === null || !deps.config.repos.some((r) => r.id === repoId))
    return { ok: false, status: 404, error: PLAN_NO_SUCH };
  if (plan.state !== "awaiting-signoff" || closedTicket(deps.store, plan))
    return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  const rules = await rulesOf(deps, repoId);
  if (rules === null)
    return {
      ok: false,
      status: 502,
      error: "The repo's rules could not be read, so the plan is not signed off yet. Try again.",
    };
  const held = planHolds(rules.planSignoff ?? "never", plan);
  let moved = false;
  let moveError: string | null = null;
  if (held) {
    // the card as it is now, not as the last poll saw it: a card that cannot be read live is not
    // moved on the cache's word
    const cached = deps.store.boardItem(repoId, issue) ?? undefined;
    let card: BoardItem | undefined = cached;
    if (deps.readCard !== undefined) {
      const fresh = await deps.readCard(repoId, issue).catch(() => null);
      if (fresh === null)
        return {
          ok: false,
          status: 502,
          error:
            "The card could not be read from the board, so the plan is not signed off yet. Try again.",
        };
      card = fresh;
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
        const board = deps.store.board(repoId);
        deps.store.replaceBoard(repoId, [...board.filter((i) => i.issueNumber !== issue), fresh]);
      }
    }
    if (card === undefined)
      return {
        ok: false,
        status: 502,
        error: "The card is not on the board, so the plan is not signed off yet. Try again.",
      };
    const column = hudColumnOf(card);
    // the board mover (idempotent) confirms Ready; a card already further along is left where it is
    if (column === "Backlog" || column === "Refinement" || column === "Ready") {
      // a card leaving Backlog or Refinement passes the checks promote runs; one that fails them is
      // signed off but left where it is, for FLIGHT to promote once the wait clears
      if (column !== "Ready") moveError = await notReadyWhy(deps, repoId, plan.ref, card, rules);
      if (moveError === null) {
        if (deps.move === undefined)
          return {
            ok: false,
            status: 502,
            error: "The board cannot be written from this hub, so the plan is not signed off yet.",
          };
        const result = await deps.move({
          runId: `plan:${plan.ref}`,
          repoId,
          issue,
          column: "Ready",
        });
        if (!result.ok)
          return {
            ok: false,
            status: 502,
            error: `The card could not be confirmed in Ready (${result.reason}), so the plan is not signed off yet. Try again.`,
          };
        moved = result.changed;
      }
    }
  }
  if (!deps.store.plans.approve(repoId, issue, deps.now()))
    return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  const signed = deps.store.plans.get(repoId, issue) as TicketPlan;
  tellFlight(
    deps,
    signed,
    moveError === null
      ? PLAN_APPROVED_COMMS(signed.ref)
      : planApprovedNotMovedComms(signed.ref, moveError),
  );
  return { ok: true, plan: withTitle(deps.store, signed), moved, moveError };
}

/** Sends a plan back to the planner with the operator's note. */
export function sendBackPlan(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
  note: string,
): Promise<SignoffResult> {
  return decided(repoId, issue, async () => {
    const plan = deps.store.plans.get(repoId, issue);
    if (plan === null || !deps.config.repos.some((r) => r.id === repoId))
      return { ok: false, status: 404, error: PLAN_NO_SUCH };
    if (closedTicket(deps.store, plan) || !deps.store.plans.sendBack(repoId, issue, note))
      return { ok: false, status: 409, error: PLAN_NOT_WAITING };
    const back = deps.store.plans.get(repoId, issue) as TicketPlan;
    tellFlight(deps, back, planSentBackComms(back.ref, note));
    return { ok: true, plan: withTitle(deps.store, back), moved: false, moveError: null };
  });
}
