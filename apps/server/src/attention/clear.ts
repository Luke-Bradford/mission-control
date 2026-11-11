import { type AttentionItem, COMMS_MC, COMMS_OPEN_PREFIX } from "@mc/core";
import { questionAskAt } from "./holds.ts";
import type { ChangeBus } from "../bus.ts";
import type { CcConfig } from "../config.ts";
import { flightSeat } from "../flight/seat.ts";
import type { NewCommsRow, Store } from "../store.ts";

/** Clear the displayed question at its source. Waking it uses the engine's ordinary holds. */
export async function clearAttentionItem(
  deps: {
    config: CcConfig;
    store: Store;
    bus: ChangeBus;
    now: () => number;
    by: string;
    actorName: string;
    reconcileRun?: (runId: string) => Promise<void>;
  },
  item: AttentionItem,
): Promise<boolean> {
  const { store } = deps;
  const at = deps.now();
  const question = item.brief?.ask || item.text;
  const reason = `${deps.actorName} cleared this item without an answer.`;
  const ask = /^ask:(\d+)$/.exec(item.key);
  const questionRun = ask ? store.question(Number(ask[1]))?.runId : undefined;
  const noteRun = item.key.startsWith("note:")
    ? store.notes().find((n) => `note:${n.key}` === item.key)?.runId
    : null;
  const commsRun = item.key.startsWith(COMMS_OPEN_PREFIX)
    ? store.commsRun(item.key.slice(COMMS_OPEN_PREFIX.length))?.id
    : undefined;
  const run = store.run(questionRun ?? noteRun ?? commsRun ?? "");
  const flight = flightSeat(deps.config)?.seat.id;
  const notices: NewCommsRow[] = [];
  if (run?.endedAt === null) {
    notices.push({
      at,
      from: COMMS_MC,
      senderKind: "hub",
      to: run.agentId,
      ticket: run.ticket,
      targetRunId: run.id,
      text: `${ask ? `Question ${ask[1]}` : "The displayed item"} was cleared by ${deps.actorName.toLowerCase()} without an answer. Existing approvals and holds still apply.`,
    });
  }
  if (flight && flight !== run?.agentId)
    notices.push({
      at,
      from: COMMS_MC,
      senderKind: "hub",
      to: flight,
      ticket: item.ticket,
      text: `${deps.actorName} cleared ${item.key} without an answer. The stored closure retains the question.`,
    });
  if (
    !store.clearAttention(
      {
        key: item.key,
        askAt: questionAskAt(item, item.brief),
        kind: "cleared",
        reason,
        by: deps.by,
        question,
        ticket: item.ticket,
        operator: true,
        at,
      },
      notices,
    )
  )
    return false;
  deps.bus.emit("attention");
  deps.bus.emit("agents");
  if (questionRun) {
    try {
      await deps.reconcileRun?.(questionRun);
    } catch {
      /* The closure and run-bound notice are durable. */
    }
  }
  return true;
}
