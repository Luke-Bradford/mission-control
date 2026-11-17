/**
 * The plan sign-off shapes the server sends (`GET /api/plans`). They live here until the server
 * half names them in mc/core; a plan is a proposal the operator approves or sends back.
 */
export const PLAN_STATUSES = ["pending", "approved", "sent-back"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanPicture {
  url: string;
  caption: string;
}

export interface Plan {
  id: string;
  repoId: string;
  /** The ticket as `repo#number`. */
  ticket: string;
  title: string;
  /** What the ticket asks for. */
  asks: string;
  /** What is proposed. */
  proposed: string;
  pictures: PlanPicture[];
  /** The size estimate, e.g. "M". */
  size: string;
  /** Complications and risks. */
  risks: string;
  status: PlanStatus;
  /** The operator's note when the plan was sent back. */
  note?: string;
  decidedAt?: number;
}

export interface PlansView {
  pending: Plan[];
  history: Plan[];
}

/** When a repo asks the operator to sign off a plan before a ticket goes to Ready. */
export const PLAN_SIGN_OFFS = ["always", "larger", "never"] as const;
export type PlanSignOff = (typeof PLAN_SIGN_OFFS)[number];

export const PLAN_SIGN_OFF_LABELS: Record<PlanSignOff, string> = {
  always: "Every ticket",
  larger: "Larger work only",
  never: "Never",
};

export const DEFAULT_PLAN_SIGN_OFF: PlanSignOff = "larger";

/** The ticket number of a `repo#number` ref; null when it is not one. */
export const ticketNumberOf = (ticket: string): number | null => {
  const m = /#([1-9]\d*)$/.exec(ticket);
  return m ? Number(m[1]) : null;
};
