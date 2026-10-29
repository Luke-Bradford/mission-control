import {
  type AttentionBrief,
  COMMS_CAPCOM,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  COMMS_OPEN_PREFIX,
} from "@mc/core";
import { protectedDecisionItem } from "./attention-holds.ts";
import type { CcConfig } from "./config.ts";
import { flightSeat } from "./flight/state.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import type { Store } from "./store.ts";

const ASK_MAX = 300;

/**
 * Raises one CAPCOM decision for each labelled question or blocker that has waited 15 minutes for
 * its addressee and a further 30 for FLIGHT. The brief's recommended option becomes the item's
 * default, which only the decision-default sweep applies, and not on an item it excludes.
 * Returns how many were raised.
 */
export function raiseStalledCommsDecisions(d: {
  config: CcConfig;
  store: Store;
  now: number;
}): number {
  const { config, store, now } = d;
  if (flightSeat(config) === null) return 0;
  const stalled = store
    .openCommsItems()
    .filter(
      (m) =>
        m.at >= COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT &&
        m.to !== COMMS_CAPCOM &&
        now >= m.at + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS &&
        !store.operatorBriefed(`${COMMS_OPEN_PREFIX}${m.id}`),
    );
  if (stalled.length === 0) return 0;
  const items = attentionItems(config, store, now, NO_LOCK);
  const briefs = store.briefs();
  let raised = 0;
  for (const message of stalled) {
    const key = `${COMMS_OPEN_PREFIX}${message.id}`;
    const item = items.find((i) => i.key === key);
    if (item === undefined || protectedDecisionItem(store, item, config, now)) continue;
    const blocker = message.label === "blocker";
    const flight = briefs.get(key);
    const brief: AttentionBrief = {
      for: "operator",
      original: message.text,
      context: `${message.from} sent ${message.to} a ${message.label}${message.ticket === null ? "" : ` on ${message.ticket}`} and nobody has settled it: ${message.text}`,
      ask: message.text.slice(0, ASK_MAX),
      recommendation:
        flight?.for === "flight" && flight.recommendation.trim() !== ""
          ? flight.recommendation
          : blocker
            ? "Let the seat work around the blocker where it safely can."
            : "Let the seat proceed on its best judgment with the most reversible choice.",
      basis: `Comms ${message.id}, unsettled since ${new Date(message.at).toISOString()}.`,
      at: now,
      recommendedOptionId: "proceed",
      options: [
        {
          id: "proceed",
          label: "Proceed",
          description: "Applies on its own if you do not answer in time.",
          answer: blocker
            ? "No one cleared this blocker in time. Work around it where you safely can, keep any change reversible, and say what you assumed. If you cannot, stay parked and say what you need."
            : "No one answered in time. Proceed on your best judgment with the most reversible choice, and say what you assumed.",
        },
        {
          id: "hold",
          label: "Hold",
          answer: "Do not act on this until CAPCOM answers.",
        },
      ],
    };
    store.addBrief({ key, ...brief });
    raised++;
  }
  return raised;
}
