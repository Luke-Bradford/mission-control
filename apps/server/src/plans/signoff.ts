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
  | { ok: false; status: 404 | 409; error: string };

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

const settingOf = async (deps: SignoffDeps, repoId: string): Promise<PlanSignoff> => {
  const rules = await deps.rules(repoId);
  return rules instanceof Error ? "never" : (rules.planSignoff ?? "never");
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

/**
 * Signs a plan off. A plan the repo holds its ticket for also moves the card to Ready (from Backlog
 * or Refinement); a plan that holds nothing is recorded and the card stays where it is.
 */
export async function approvePlan(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
): Promise<SignoffResult> {
  const plan = deps.store.plans.get(repoId, issue);
  if (plan === null || !deps.config.repos.some((r) => r.id === repoId))
    return { ok: false, status: 404, error: PLAN_NO_SUCH };
  if (plan.state !== "awaiting-signoff") return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  const held = planHolds(await settingOf(deps, repoId), plan);
  deps.store.plans.approve(repoId, issue, deps.now());
  let moved = false;
  let moveError: string | null = null;
  if (held && deps.move !== undefined) {
    const card = deps.store.board(repoId).find((i) => i.issueNumber === issue);
    const column = card === undefined ? null : hudColumnOf(card);
    if (column === "Backlog" || column === "Refinement") {
      const result = await deps.move({
        runId: `plan:${plan.ref}`,
        repoId,
        issue,
        column: "Ready",
      });
      moved = result.ok && result.changed;
      if (!result.ok) moveError = result.reason;
    }
  }
  const signed = deps.store.plans.get(repoId, issue) as TicketPlan;
  tellFlight(deps, signed, PLAN_APPROVED_COMMS(signed.ref));
  return { ok: true, plan: withTitle(deps.store, signed), moved, moveError };
}

/** Sends a plan back to the planner with the operator's note. */
export function sendBackPlan(
  deps: SignoffDeps,
  repoId: string,
  issue: number,
  note: string,
): SignoffResult {
  const plan = deps.store.plans.get(repoId, issue);
  if (plan === null || !deps.config.repos.some((r) => r.id === repoId))
    return { ok: false, status: 404, error: PLAN_NO_SUCH };
  if (plan.state !== "awaiting-signoff") return { ok: false, status: 409, error: PLAN_NOT_WAITING };
  deps.store.plans.sendBack(repoId, issue, note);
  const back = deps.store.plans.get(repoId, issue) as TicketPlan;
  tellFlight(deps, back, planSentBackComms(back.ref, note));
  return { ok: true, plan: withTitle(deps.store, back), moved: false, moveError: null };
}
