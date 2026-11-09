import { type BriefChoiceRequest, COMMS_CAPCOM, type TestLockState } from "@mc/core";
import { decisionDefault } from "./attention-holds.ts";
import { type BriefChoiceDeps, chooseBrief, retainedBriefChoice } from "./brief-choices.ts";
import { BriefDeferred, checkBriefRun, currentBriefFlight } from "./brief-prepare.ts";
import type { CcConfig } from "./config.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import type { Store } from "./store.ts";

export interface DecisionDefaultsDeps {
  config: CcConfig;
  store: Store;
  now: number;
  lock?: TestLockState;
  choices?: BriefChoiceDeps;
  /** Historical callers may provide this, but unbound raw delivery never executes. */
  deliver?: (seatId: string, text: string) => Promise<void>;
}
interface PendingBinding {
  epoch: string;
  request: BriefChoiceRequest;
}
const delivering = new WeakSet<Store>();

/** Uses the same bound service path as explicit choices; unknown deliveries never replay. */
export async function applyDecisionDefaults(d: DecisionDefaultsDeps): Promise<number> {
  const { config, store, now, choices } = d;
  if (!choices || delivering.has(store)) return 0;
  delivering.add(store);
  let claimed = 0;
  try {
    // Resume only a durable pre-dispatch claim. A dispatching receipt is uncertain and stays so.
    for (const pending of store.pendingDecisionDeliveries()) {
      if (!pending.binding) continue;
      try {
        const bound = JSON.parse(pending.binding) as PendingBinding;
        const prior = retainedBriefChoice({ store }, bound.epoch);
        if (prior && !["pending", "dispatching"].includes(prior.state)) {
          settle(pending.key, pending.briefAt, prior);
          continue;
        }
        const latest = store.briefs().get(pending.key);
        if (
          prior?.state !== "dispatching" &&
          (!latest?.id || latest.binding?.epoch !== bound.epoch)
        ) {
          store.stopDecisionDelivery(
            pending.key,
            pending.briefAt,
            "canceled",
            "The bound decision epoch changed.",
          );
          continue;
        }
        const action = latest?.binding?.actions.find(
          (entry) => entry.optionId === bound.request.optionId,
        )?.action;
        const actor =
          action && "seatId" in action ? currentBriefFlight(config, store, action.seatId) : null;
        const executionActor = actor ?? (prior?.state === "dispatching" ? prior.actor : null);
        if (!executionActor) continue;
        if (prior?.state === "pending" && action?.kind === "ordinary-run-guidance")
          checkBriefRun(
            choices,
            action.seatId,
            action.runId,
            Number(/^ask:(\d+)$/.exec(pending.key)?.[1]) || undefined,
          );
        const receipt = await chooseBrief(
          choices,
          pending.key,
          {
            ...bound.request,
            briefId:
              latest?.binding?.epoch === bound.epoch
                ? (latest.id ?? bound.request.briefId)
                : bound.request.briefId,
          },
          executionActor,
          "default",
        );
        settle(pending.key, pending.briefAt, receipt);
      } catch (error) {
        if (error instanceof BriefDeferred) continue;
        store.stopDecisionDelivery(
          pending.key,
          pending.briefAt,
          "canceled",
          error instanceof Error ? error.message : "The bound source could not be revalidated.",
        );
      }
    }
    for (const item of attentionItems(config, store, now, d.lock ?? NO_LOCK)) {
      if (item.acked) continue;
      const def = decisionDefault(store, item, config, now);
      const brief = item.brief;
      if (!def || def.dueAt > now || !brief?.id || !brief.binding || !def.option.id) continue;
      const preparedAction = brief.binding.actions.find(
        (entry) => entry.optionId === def.option.id,
      )?.action;
      const actor =
        preparedAction && "seatId" in preparedAction
          ? currentBriefFlight(config, store, preparedAction.seatId)
          : null;
      if (!actor) continue;
      const request: BriefChoiceRequest = {
        briefId: brief.id,
        sourceRevision: brief.binding.sourceRevision,
        optionId: def.option.id,
        requestId: `default:${brief.binding.epoch}`,
      };
      try {
        const receipt = await chooseBrief(
          choices,
          item.key,
          request,
          actor,
          "default",
          (_source, current, choice) => {
            const action = current.binding?.actions.find(
              (entry) => entry.optionId === request.optionId,
            )?.action;
            if (!action) return false;
            const target = action.kind === "ordinary-run-guidance" ? action.seatId : actor.seatId;
            const ok = store.claimDecisionDefault(
              {
                key: item.key,
                briefAt: def.briefAt,
                optionId: def.option.id ?? null,
                label: def.option.label,
                dueAt: def.dueAt,
                target,
                answer: def.option.answer,
                choice,
                binding: JSON.stringify({ epoch: choice.epoch, request } satisfies PendingBinding),
              },
              {
                at: now,
                from: actor.seatId,
                to: COMMS_CAPCOM,
                ticket: item.ticket,
                text: `FYI default selected: ${def.option.label}. Bound dispatch is pending; no completion is claimed.`,
                ref: item.ticket,
              },
              now,
            );
            if (ok) claimed++;
            return ok;
          },
        );
        settle(item.key, def.briefAt, receipt);
      } catch {
        // No claim means no ack, delivery, or fabricated completion. The current brief stays open.
      }
    }
    return claimed;
  } finally {
    delivering.delete(store);
  }

  function settle(
    key: string,
    briefAt: number,
    receipt: Awaited<ReturnType<typeof chooseBrief>>,
  ): void {
    if (receipt.state === "applied")
      store.markDecisionDeliveryDone(key, briefAt, receipt.completedAt ?? now);
    else if (receipt.state === "unknown" || receipt.state === "dispatching")
      store.stopDecisionDelivery(key, briefAt, "unknown", receipt.text);
    else if (receipt.state !== "pending")
      store.stopDecisionDelivery(key, briefAt, "canceled", receipt.text);
  }
}
