/**
 * A ticket's plan, as the operator signs it off: what the ticket asks, what is proposed, pictures,
 * a size estimate and the risks. The hub keeps one row per ticket beside its comms and QA reports.
 * The proposal is the text the planner also writes under `## Plan` on the ticket.
 */

/** Whether a repo holds a ticket for the operator's sign-off before it can go to Ready. */
export const PLAN_SIGNOFFS = ["every", "larger", "never"] as const;
export type PlanSignoff = (typeof PLAN_SIGNOFFS)[number];

/** Where a plan stands. The first and third wait on the planner, the second on the operator. */
export const PLAN_STATES = [
  "awaiting-plan",
  "awaiting-signoff",
  "sent-back",
  "signed-off",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** The most mockups one plan carries, and the biggest picture kept. */
export const PLAN_MOCKUPS_MAX = 8;
export const PLAN_MOCKUP_BYTES_MAX = 2 * 1024 * 1024;
/** The longest note the operator sends a plan back with, and the longest of each plan part. */
export const PLAN_NOTE_MAX = 2000;
export const PLAN_PART_MAX = 2000;

export interface PlanMockup {
  /** The picture's content hash. */
  id: string;
  caption: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Where the page loads it from: content-addressed, so it never changes. */
  url: string;
}

export interface TicketPlan {
  repoId: string;
  issue: number;
  /** `repo#issue`. */
  ref: string;
  /** The ticket's title from the hub's board copy, when it is still on the board. */
  title: string | null;
  state: PlanState;
  /**
   * True when FLIGHT sent this ticket to the tab as larger work. Whether the ticket is held is worked
   * out from the repo's current setting and this mark (`planHolds`): every holds all, larger holds the
   * marked, never holds none.
   */
  marked: boolean;
  /** What the ticket asks for, in a few lines; null until the planner files the plan. */
  asks: string | null;
  /** What is proposed (the planner's plan text); null until filed. */
  proposal: string | null;
  sizeEstimate: string | null;
  risks: string | null;
  mockups: PlanMockup[];
  /** The operator's note, set while the plan is sent back. */
  note: string | null;
  requestedAt: number;
  plannedAt: number | null;
  decidedAt: number | null;
}

/** The Planner tab: tickets waiting for a plan or sign-off, and plans already signed off. */
export interface PlansView {
  waiting: TicketPlan[];
  history: TicketPlan[];
}

/** The signed-off plan a QA report keeps beside what was built. */
export type QaPlan = Pick<
  TicketPlan,
  "ref" | "asks" | "proposal" | "sizeEstimate" | "risks" | "mockups" | "decidedAt"
>;

export const planNotRequiredText = (ref: string): string =>
  `${ref} has no plan to sign off here: its repo does not hold tickets for sign-off, so it is already on the usual path.`;
/** FLIGHT's promote refusal: the repo needs a signed-off plan first. */
export const planNeedsSignoffText = (ref: string, state: PlanState | null): string =>
  state === "awaiting-signoff"
    ? `Not moved: ${ref}'s plan is waiting for the operator's sign-off. It goes to Ready when they approve it.`
    : state === "sent-back"
      ? `Not moved: ${ref}'s plan was sent back by the operator. Start a planner on it again; the operator's note is in its brief.`
      : `Not moved: ${ref} needs a plan the operator has signed off before it goes to Ready. Call send_to_planner for it, then start a planner.`;
export const PLAN_SEND_REFUSED =
  "Not sent: this ticket already has a plan the operator signed off.";
export const planSentText = (ref: string): string =>
  `${ref} is on the Planner tab. Start a planner on it; the operator signs the plan off before it goes to Ready.`;
export const PLAN_NO_SUCH = "no plan for that ticket";
export const PLAN_NOT_WAITING = "that plan is not waiting for sign-off";
export const PLAN_APPROVED_COMMS = (ref: string): string =>
  `The operator signed off the plan for ${ref}.`;
export const planSentBackComms = (ref: string, note: string): string =>
  `The operator sent the plan for ${ref} back with this note: ${note}. Start a planner on it again.`;

/**
 * Whether the repo's setting makes this ticket wait for the operator's sign-off: `every` always,
 * `larger` for a ticket FLIGHT sent to the Planner tab, `never` never. A signed-off plan no longer holds.
 */
export function planHolds(
  setting: PlanSignoff | undefined,
  plan: Pick<TicketPlan, "marked" | "state"> | null,
): boolean {
  if (plan?.state === "signed-off") return false;
  if (setting === "every") return true;
  return setting === "larger" && plan?.marked === true;
}

/** The copy a QA report keeps: the signed-off plan, or null while it is not signed off. */
export function signedOffQaPlan(plan: TicketPlan | null): QaPlan | null {
  if (plan === null || plan.state !== "signed-off" || plan.proposal === null) return null;
  return {
    ref: plan.ref,
    asks: plan.asks,
    proposal: plan.proposal,
    sizeEstimate: plan.sizeEstimate,
    risks: plan.risks,
    mockups: plan.mockups,
    decidedAt: plan.decidedAt,
  };
}

/** report_plan's refusal: the operator signs a plan off, so it needs every part. */
export const planPartsText = (missing: readonly string[]): string =>
  `Not written: the operator reads this plan on the Planner tab, so it needs ${missing.join(", ")} too. Add them (mockups only when the work changes something the operator will see) and call report_plan again.`;

/** send_to_planner's refusal: only a ticket that is not yet pickable can be held for a plan. */
export const planSendColumnText = (ref: string, where: string): string =>
  `Not sent: ${ref} is ${where}, and a seat can pick it up. Move it back to Backlog with promote { to: "Backlog" } first, then send it to the planner.`;

/** FLIGHT's note that a plan was signed off but its card was left where it is. */
export const planApprovedNotMovedComms = (ref: string, why: string): string =>
  `The operator signed off the plan for ${ref}, but its card was not moved to Ready: ${why} Promote it once that clears; promote now accepts it.`;
