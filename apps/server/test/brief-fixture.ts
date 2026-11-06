import type { BriefAction, BriefOperatorReason, Run } from "@mc/core";
import type { Store } from "../src/store.ts";

/** Real retained run/session rows, never an eligibility boolean. */
export function liveBriefSeat(
  store: Store,
  seatId: string,
  id: string,
  at: number,
  repoId = "repo",
): void {
  const run: Run = {
    id,
    agentId: seatId,
    repoId,
    seq: 1,
    startedAt: at,
    endedAt: null,
    status: "running",
    sessionId: "fixture-cli",
    model: "fixture",
    branch: null,
    ticket: `${repoId}#1`,
    costUsd: null,
    tokens: null,
    transcriptPath: "/fixture",
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  store.setSeatSession({
    seatId,
    runId: id,
    cliSessionId: "fixture-cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: at,
  });
}

/** Complete fixture context; the chosen service effect remains explicit and is never inferred from prose. */
export function operatorDecisionFields(
  action: BriefAction,
  why: BriefOperatorReason = "product-direction",
) {
  return {
    did: [],
    checked: [],
    recommendedOptionId: "apply",
    decision: {
      whyOperator: {
        kind: why,
        explanation: "This fixture needs the operator's explicit decision.",
      },
      consulted: [],
      costOfDelay: "The fixture remains waiting.",
      waiting: "Explicit operator choice.",
    },
    options: [
      {
        id: "apply",
        label: "Apply displayed action",
        answer: "Apply only the displayed typed action.",
        consequence: "Perform only the displayed typed service effect.",
        reversibility: {
          kind: "partly-reversible" as const,
          detail: "The effect is described by its existing typed service.",
        },
        action,
      },
      {
        id: "wait",
        label: "Wait",
        answer: "Keep waiting.",
        consequence: "Hold the decision without executing its recommendation.",
        reversibility: {
          kind: "reversible" as const,
          detail: "The operator can release this wait.",
        },
        action: {
          kind: "attention-hold" as const,
          reason: "Wait for the operator.",
          condition: { kind: "manual" as const },
        },
      },
    ],
  };
}
