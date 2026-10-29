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
  /** Hands the default option's answer to the seat that owns the item; absent: nothing is sent. */
  deliver?: (seatId: string, text: string) => Promise<void>;
}

/**
 * Applies the default of every decision whose deadline has passed unanswered: the card is acked
 * (it leaves Decisions), "Default applied: …" goes to FLIGHT ↔ CAPCOM, and the answer is handed to
 * the seat that asked (an escalation is left alone: it is answered on GitHub).
 * Held and acked items are not in the set, so an answer or a hold before the deadline cancels it.
 * Each (key, ask) is claimed once in the store, so a restart or a second sweep never repeats it.
 * Returns how many were applied.
 */
export async function applyDecisionDefaults(d: DecisionDefaultsDeps): Promise<number> {
  const { config, store, now } = d;
  const flightId = flightSeat(config)?.seat.id ?? null;
  let applied = 0;
  for (const item of attentionItems(config, store, now, d.lock ?? NO_LOCK)) {
    if (item.acked) continue;
    const def = decisionDefault(store, item);
    if (def === null || def.dueAt > now) continue;
    const ask = item.brief?.ask || item.text;
    // the seat that asked, else FLIGHT
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
        text: defaultAppliedText(def.option.label, ask),
        ref: item.ticket,
      },
      now,
    );
    if (claimed) applied++;
  }
  await deliverPending(d);
  return applied;
}

/** Hands each applied default's answer to its seat; one that fails is retried on the next sweep. */
async function deliverPending(d: DecisionDefaultsDeps): Promise<void> {
  if (d.deliver === undefined) return;
  for (const p of d.store.pendingDecisionDeliveries()) {
    // the lead names the ask, so a seat can tell a repeat after a crash from a new answer
    const text = `Re: ${p.key} · default applied (${p.briefAt})\n\n${p.answer}`;
    try {
      await d.deliver(p.target, text);
    } catch {
      continue;
    }
    d.store.markDecisionDeliveryDone(p.key, p.briefAt, d.now);
  }
}
