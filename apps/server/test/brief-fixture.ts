import type { BriefAction, BriefOperatorReason, Run } from "@mc/core";
import {
  bindPreparedBrief,
  currentBriefFlight,
  ORDINARY_GUIDANCE,
  prepareOrdinaryGuidance,
} from "../src/brief/prepare.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud.ts";
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

/** Explicitly prepared ordinary guidance; the retired automatic Comms writer is never invoked. */
export function prepareFixtureGuidance(
  config: CcConfig,
  store: Store,
  now: number,
  key: string,
): void {
  const item = attentionItems(config, store, now).find((entry) => entry.key === key);
  const run = item?.agentId ? store.seatRun(item.agentId) : null;
  if (!item?.agentId || !run) throw new Error("Missing guidance source run");
  const deps = { config, store, now: () => now };
  const action = { kind: "ordinary-run-guidance" as const, seatId: item.agentId, runId: run.id };
  const prepared = prepareOrdinaryGuidance(deps, item, action);
  const hold = {
    kind: "attention-hold" as const,
    reason: "Wait for an explicit answer.",
    condition: { kind: "manual" as const },
  };
  const value = bindPreparedBrief(
    deps,
    item,
    {
      for: "operator",
      by: "flight",
      at: now,
      context: "The current run can receive ordinary guidance within its existing authority.",
      ask: "Proceed with the reversible choice?",
      recommendation: "Proceed within the existing authority.",
      did: [],
      checked: [],
      decision: { consulted: [], costOfDelay: "The run continues waiting." },
      basis: "The current run and its delivery guards were checked.",
      recommendedOptionId: "proceed",
      options: [
        {
          id: "proceed",
          label: "Proceed",
          answer: ORDINARY_GUIDANCE,
          consequence: "Deliver only bounded guidance to the displayed run.",
          reversibility: {
            kind: "reversible",
            detail: "Later guidance can supersede this message.",
          },
          action,
        },
        {
          id: "hold",
          label: "Hold",
          answer: "Wait for an explicit answer.",
          consequence: "Keep this item held without a default.",
          reversibility: { kind: "reversible", detail: "The hold can be released later." },
          action: hold,
        },
      ],
    },
    currentBriefFlight(config, store, item.agentId) ??
      (() => {
        throw new Error("Missing fixture FLIGHT");
      })(),
    [prepared, { optionId: "hold", action: hold, defaultable: false, effect: "Hold this item" }],
  );
  store.addBrief({ key, ...value });
}
