import {
  type AttentionBrief,
  COMMS_CAPCOM,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  COMMS_OPEN_PREFIX,
  hasUnreadableId,
  needsYouEntryFaults,
} from "@mc/core";
import { protectedDecisionItem } from "./attention-holds.ts";
import { bindPreparedBrief, ORDINARY_GUIDANCE, prepareOrdinaryGuidance } from "./brief-prepare.ts";
import type { CcConfig } from "./config.ts";
import { crewSeatIds, flightSeat } from "./flight/state.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import { parseTicket } from "./runview.ts";
import type { Store } from "./store.ts";

const ASK_MAX = 300;
const TITLE_MAX = 120;
/** The wait the escalation constants add up to, in whole minutes, for the question's words. */
const WAIT_MINUTES = Math.round((COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS) / 60_000);

/**
 * Raises one CAPCOM decision for each labelled question or blocker that has waited 15 minutes for
 * its addressee and a further 30 for FLIGHT. The brief carries no timed default: the operator
 * answers it. Returns how many were raised.
 */
export function raiseStalledCommsDecisions(d: {
  config: CcConfig;
  store: Store;
  now: number;
}): number {
  const { config, store, now } = d;
  if (flightSeat(config) === null) return 0;
  const stalled = store.openCommsItems().filter(
    (m) =>
      m.at >= COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT &&
      m.to !== COMMS_CAPCOM &&
      now >= m.at + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS &&
      // a question for the operator names its ticket (Needs you entry rules, #1543); without
      // one the item stays FLIGHT's, counted under the not-triaging alert
      m.ticket !== null &&
      // a brief the hub wrote itself and the entry check returned is rewritten, not final
      (!store.operatorBriefed(`${COMMS_OPEN_PREFIX}${m.id}`) ||
        store.briefs().get(`${COMMS_OPEN_PREFIX}${m.id}`)?.by === "hub"),
  );
  if (stalled.length === 0) return 0;
  const items = attentionItems(config, store, now, NO_LOCK);
  const briefs = store.briefs();
  let raised = 0;
  for (const message of stalled) {
    const key = `${COMMS_OPEN_PREFIX}${message.id}`;
    const item = items.find((i) => i.key === key);
    if (item === undefined || protectedDecisionItem(store, item, config, now)) continue;
    const seatIds = crewSeatIds(config);
    // an operator brief stands, unless the hub wrote it and the entry check returned it
    const returnedHubBrief =
      briefs.get(key)?.by === "hub" && needsYouEntryFaults(item, seatIds).length > 0;
    if (store.operatorBriefed(key) && !returnedHubBrief) continue;
    const t = parseTicket(message.ticket ?? "");
    const title = t === null ? undefined : store.boardItem(t.repoId, t.number)?.title;
    const short =
      title && title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX).trimEnd()}…` : title;
    // a title with an id would make the whole question fail the entry check; the link names it
    const about = short && !hasUnreadableId(short, seatIds) ? `"${short}"` : "a ticket";
    const blocker = message.label === "blocker";
    const flight = briefs.get(key);
    const targetRun = item.agentId ? store.seatRun(item.agentId) : undefined;
    if (!item.agentId || !targetRun) continue;
    const action = {
      kind: "ordinary-run-guidance" as const,
      seatId: item.agentId,
      runId: targetRun.id,
    };
    let prepared: ReturnType<typeof prepareOrdinaryGuidance>;
    try {
      prepared = prepareOrdinaryGuidance({ config, store, now: () => now }, item, action);
    } catch {
      continue;
    } // Unknown authority remains unbriefed; no invented operator-only reason.
    const brief: AttentionBrief = {
      for: "operator",
      original: message.text,
      context: `${message.from} sent ${message.to} a ${message.label}${message.ticket === null ? "" : ` on ${message.ticket}`} and nobody has settled it: ${message.text}`,
      assessment:
        flight?.assessment ??
        flight?.context ??
        `This ${message.label} is still open; the sender's current run can receive ordinary guidance within its existing authority.`,
      did: [],
      checked: [
        {
          source: `Comms ${message.id}`,
          finding: "The source, current run and existing FLIGHT delivery authority were checked.",
        },
      ],
      ask: message.text,
      recommendation:
        flight?.recommendation ??
        (blocker
          ? "Let the seat work around the blocker where it safely can."
          : "Let the seat proceed on its best judgment with the most reversible choice."),
      decision: {
        consulted: [],
        costOfDelay:
          "The sender continues waiting. There is no measured completion-time or money estimate for this delay.",
      },
      basis: `Comms ${message.id}, unsettled since ${new Date(message.at).toISOString()}.`,
      by: "hub",
      at: now,
      recommendedOptionId: "proceed",
      options: [
        {
          id: "proceed",
          label: "Proceed",
          description: "Applies on its own if you do not answer in time.",
          answer: ORDINARY_GUIDANCE,
          consequence:
            "Deliver bounded guidance to this exact existing run. It grants no approval or hold release.",
          reversibility: {
            kind: "reversible",
            detail:
              "The guidance can be superseded. This message performs no irreversible action or approval.",
          },
          action,
        },
        {
          id: "hold",
          label: "Hold",
          answer: "Do not act on this until CAPCOM answers.",
          consequence: "Hold this item for an explicit answer; do not apply its default.",
          reversibility: {
            kind: "reversible",
            detail: "The operator can release the explicit hold and refresh the brief.",
          },
          action: {
            kind: "attention-hold",
            reason: "Wait for CAPCOM's explicit answer.",
            condition: { kind: "manual" },
          },
        },
      ],
    };
    const bound = bindPreparedBrief(
      { config, store, now: () => now },
      item,
      brief,
      { service: "stalled-comms" },
      [
        prepared,
        {
          optionId: "hold",
          action: brief.options[1]?.action ?? { kind: "record-decision" },
          defaultable: false,
          effect: "Hold this item until an explicit answer",
        },
      ],
    );
    store.addBrief({ key, ...bound });
    raised++;
  }
  return raised;
}
