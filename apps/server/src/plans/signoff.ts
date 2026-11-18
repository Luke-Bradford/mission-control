/** The operator's sign-off of a ticket's plan: the Planner tab's lists, Approve and Send back. */
import {
  COMMS_MC,
  hudColumnOf,
  PLAN_APPROVED_COMMS,
  PLAN_NO_SUCH,
  PLAN_NOT_WAITING,
  type PlanSignoff,
  type PlansView,
  planHolds,
  planSentBackComms,
  type RepoRules,
  type TicketPlan,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
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
}

export type SignoffResult =
  | { ok: true; plan: TicketPlan; moved: boolean; moveError: string | null }
  | { ok: false; status: 404 | 409 | 502; error: string };

/** The plan with its title from the board copy, when the ticket is still on the board. */
export function withTitle(store: Store, plan: TicketPlan): TicketPlan {
  const card = store.board(plan.repoId).find((i) => i.issueNumber === plan.issue);
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

/** The Planner tab: what waits for a plan or sign-off, and what was signed off. */
export function plansView(store: Store, config: CcConfig): PlansView {
  const known = new Set(config.repos.map((r) => r.id));
  const keep = (p: TicketPlan) => known.has(p.repoId);
  return {
    waiting: store.plans
      .inStates(["awaiting-plan", "sent-back", "awaiting-signoff"])
      .filter(keep)
      .map((p) => withTitle(store, p)),
    history: store.plans
      .signedOff()
      .filter(keep)
      .map((p) => withTitle(store, p)),
  };
}

/** The repo's live setting, or null when its rules cannot be read (decisions then fail closed). */
const settingOf = async (deps: SignoffDeps, repoId: string): Promise<PlanSignoff | null> => {
  const rules = await deps.rules(repoId);
  return rules instanceof Error ? null : (rules.planSignoff ?? "never");
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

async function approveOne(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
): Promise<SignoffResult> {
  const plan = deps.store.plans.get(repoId, issue);
  if (plan === null || !deps.config.repos.some((r) => r.id === repoId))
    return { ok: false, status: 404, error: PLAN_NO_SUCH };
  if (plan.state !== "awaiting-signoff") return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  const setting = await settingOf(deps, repoId);
  if (setting === null)
    return {
      ok: false,
      status: 502,
      error: "The repo's rules could not be read, so the plan is not signed off yet. Try again.",
    };
  const held = planHolds(setting, plan);
  let moved = false;
  if (held) {
    const card = deps.store.board(repoId).find((i) => i.issueNumber === issue);
    const column = card === undefined ? null : hudColumnOf(card);
    // the cached card may be missing or stale, so the board mover (idempotent, and it reads GitHub)
    // confirms Ready; a card already further along is left where it is
    if (column === null || column === "Backlog" || column === "Refinement" || column === "Ready") {
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
  if (!deps.store.plans.approve(repoId, issue, deps.now()))
    return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  const signed = deps.store.plans.get(repoId, issue) as TicketPlan;
  tellFlight(deps, signed, PLAN_APPROVED_COMMS(signed.ref));
  return { ok: true, plan: withTitle(deps.store, signed), moved, moveError: null };
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
    if (!deps.store.plans.sendBack(repoId, issue, note))
      return { ok: false, status: 409, error: PLAN_NOT_WAITING };
    const back = deps.store.plans.get(repoId, issue) as TicketPlan;
    tellFlight(deps, back, planSentBackComms(back.ref, note));
    return { ok: true, plan: withTitle(deps.store, back), moved: false, moveError: null };
  });
}
