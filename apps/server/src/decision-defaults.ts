import { COMMS_CAPCOM, COMMS_MC, defaultAppliedText, type TestLockState } from "@mc/core";
import { decisionDefault } from "./attention-holds.ts";
import type { CcConfig } from "./config.ts";
import { flightSeat } from "./flight/state.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import type { Store } from "./store.ts";

export interface DecisionDefaultsDeps {
  config: CcConfig;
  store: Store;
  now: number;
  lock?: TestLockState;
  deliver?: (seatId: string, text: string) => Promise<void>;
}

/** Applies each eligible, overdue reversible decision exactly once. */
export async function applyDecisionDefaults(d: DecisionDefaultsDeps): Promise<number> {
  const { config, store, now } = d;
  const flightId = flightSeat(config)?.seat.id ?? null;
  let applied = 0;
  for (const item of attentionItems(config, store, now, d.lock ?? NO_LOCK)) {
    if (item.acked) continue;
    const def = decisionDefault(store, item, config, now);
    if (def === null || def.dueAt > now) continue;
    const asker = item.agentId !== null && store.seatSession(item.agentId) !== null;
    const claimed = store.claimDecisionDefault(
      {
        key: item.key,
        briefAt: def.briefAt,
        optionId: def.option.id ?? null,
        label: def.option.label,
        dueAt: def.dueAt,
        target: asker ? item.agentId : flightId,
        answer: def.option.answer,
      },
      {
        at: now,
        from: flightId ?? COMMS_MC,
        to: COMMS_CAPCOM,
        ticket: item.ticket,
        text: defaultAppliedText(def.option.label, item.brief?.ask || item.text),
        ref: item.ticket,
      },
      now,
    );
    if (claimed) applied++;
  }
  await deliverPending(d);
  return applied;
}

const delivering = new WeakSet<Store>();
async function deliverPending(d: DecisionDefaultsDeps): Promise<void> {
  if (d.deliver === undefined || delivering.has(d.store)) return;
  delivering.add(d.store);
  try {
    for (const pending of d.store.pendingDecisionDeliveries()) {
      try {
        await d.deliver(
          pending.target,
          `Re: ${pending.key} · default applied (${pending.briefAt})\n\n${pending.answer}`,
        );
      } catch {
        continue;
      }
      d.store.markDecisionDeliveryDone(pending.key, pending.briefAt, d.now);
    }
  } finally {
    delivering.delete(d.store);
  }
}
