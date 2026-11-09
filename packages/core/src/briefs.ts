/** Typed brief choices. Display text and claimed reversibility never grant execution authority. */
import type { AttentionHoldCondition, AttentionWaitCondition } from "./attention-model.ts";
export type BriefOperatorReason =
  | "money"
  | "product-direction"
  | "security-exception"
  | "irreversible"
  | "floor-approval";

export type BriefTarget =
  | { kind: "run"; runId: string; sha: string }
  | { kind: "pr"; repoId: string; number: number; sha: string };

/** Intent accepted from a producer, then independently bound and checked by the server. */
export type BriefAction =
  | { kind: "answer"; seatId: string; runId: string; text: string }
  | { kind: "ordinary-run-guidance"; seatId: string; runId: string }
  | { kind: "direct-queue-priority-swap"; seatId: string; move: string; above: string }
  | { kind: "review-rework"; runId: string; sha: string; text: string }
  | { kind: "review-resume"; runId: string; sha: string }
  | { kind: "run-resume"; runId: string; parkKind: string }
  | { kind: "queue-proposal"; key: string; action: "approve" | "deny" }
  | { kind: "person-post"; replyId: string }
  | { kind: "person-handled"; how: "marked" | "copied" | "flight"; replyId?: string }
  | {
      kind: "controller-check";
      target: BriefTarget;
      verdict: "pass" | "fail";
      note?: string;
      evidence: string;
    }
  | {
      kind: "uat";
      repoId: string;
      number: number;
      sha: string;
      action: "accept" | "send_back";
      note?: string;
    }
  | {
      kind: "floor-grant";
      rule: "merge-floor" | "repo-rules" | "merge-push";
      scope: string;
      until: string;
      reason: string;
    }
  | { kind: "merge-hold"; target: BriefTarget; action: "hold" | "release"; reason?: string }
  | { kind: "breaker-recovery" }
  | {
      kind: "attention-hold";
      reason: string;
      condition: AttentionHoldCondition | AttentionWaitCondition;
    }
  | { kind: "attention-dismiss" }
  | { kind: "record-decision" };

export interface BriefDecisionContext {
  whyOperator?: { kind: BriefOperatorReason; explanation: string };
  consulted: { who: string; finding: string; ref?: string }[];
  costOfDelay: string;
  waiting?: string;
}

export interface BriefActor {
  seatId: string;
  runId: string;
}

export interface BriefQueuePreparation {
  proof: string;
  reversibleState: {
    kind: "priority-swap";
    before: readonly [
      { repoId: string; issue: number; priority: string },
      { repoId: string; issue: number; priority: string },
    ];
  };
}

export interface PreparedBriefAction {
  optionId: string;
  action: BriefAction;
  /** Hash of additional service-specific preparation facts; never a caller's permission bit. */
  proof?: string;
  reversibleState?: BriefQueuePreparation["reversibleState"];
  defaultable: boolean;
  effect: string;
}

export interface BriefBinding {
  version: 2;
  sourceRevision: string;
  meaningKey: string;
  epoch: string;
  /** First brief row in this semantic epoch; stable across cosmetic rebriefs. */
  epochId: number;
  preparedAt: number;
  preparedBy: BriefActor | { service: "queue-proposal" | "stalled-comms" };
  actions: PreparedBriefAction[];
}

export interface BriefReadState {
  completeness: "complete" | "incomplete";
  freshness: "current" | "stale" | "unknown";
  reason: string;
  checkedAt?: number;
}

export interface BriefChoiceRequest {
  briefId: number;
  sourceRevision: string;
  optionId: string;
  requestId: string;
  input?: { note?: string; text?: string };
}

export interface BriefChoiceReceipt {
  epoch: string;
  requestId: string;
  optionId: string;
  at: number;
  state: "pending" | "dispatching" | "applied" | "refused" | "stale" | "unknown";
  text: string;
  actor: BriefActor | { operator: true };
  claimedBy?: BriefActor | { operator: true };
  /** Decision facts after a confirmed effect; prevents its old ack hiding later changes. */
  settledSourceRevision?: string;
  status?: number;
  /** Time a successful effect was confirmed, absent for pending/refused/unknown outcomes. */
  completedAt?: number;
}
