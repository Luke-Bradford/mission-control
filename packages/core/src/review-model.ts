/** Shared vocabulary and data shapes; independent of the domain algorithms. */

export type ReviewStatusState = "pending" | "success" | "failure";

export interface ReviewStatus {
  state: ReviewStatusState;
  description: string;
}

/**
 * One open PR's review state, the same on the Board card, the PR chip, the Overview crew row and
 * the Agent page. (`ReviewCheck` is a checklist item; this is the PR's state.)
 */
export type ReviewCheckState =
  | { kind: "queued"; position: number }
  | { kind: "checking"; seat: string; since: number }
  | { kind: "sent" }
  | { kind: "ready" }
  | { kind: "held"; by: "FLIGHT" | "CAPCOM" | "operator" | "hub" };
