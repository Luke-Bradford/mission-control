import type { TestLockState } from "@mc/core";
import { COMMS_CAPCOM, COMMS_MC } from "@mc/core";
import type { BriefChoiceDeps } from "./brief-choices.ts";
import {
  BriefError,
  type BriefPreparationDeps,
  checkBriefRun,
  currentBriefFlight,
  ORDINARY_GUIDANCE,
} from "./brief-prepare.ts";
import type { ChangeBus } from "./bus.ts";
import { sendComms, validateCommsText } from "./comms.ts";
import { attentionItems, NO_LOCK } from "./hud.ts";
import {
  prepareQueueReorderSnapshot,
  type QueueReorderDeps,
  reorderQueue,
} from "./queue-reorder.ts";
import type { Supervisor } from "./runtime/supervisor.ts";

export interface BriefRoutineDeps extends BriefPreparationDeps {
  supervisor?: Pick<Supervisor, "message">;
  queue?: QueueReorderDeps;
  knownSecrets: () => Promise<readonly string[]>;
  bus?: ChangeBus;
}

/** Shared real-service actions used by explicit choice and the existing default sweep. */
export async function dispatchRoutineBriefAction(
  deps: BriefRoutineDeps,
  action: Parameters<BriefChoiceDeps["dispatch"]>[0],
  input: Parameters<BriefChoiceDeps["dispatch"]>[1],
  context: Parameters<BriefChoiceDeps["dispatch"]>[2],
): Promise<string | null> {
  const { store, config } = deps;
  const from = "seatId" in context.actor ? context.actor.seatId : COMMS_CAPCOM;
  const option = context.brief.options.find((entry) => entry.id === context.optionId);
  if (action.kind === "answer" || action.kind === "ordinary-run-guidance") {
    if (!deps.supervisor) throw new BriefError(503, "Message delivery is unavailable.");
    const text =
      action.kind === "ordinary-run-guidance" ? ORDINARY_GUIDANCE : (input?.text ?? action.text);
    await validateCommsText(deps.knownSecrets, text);
    const check = () => {
      context.beforeWrite();
      checkBriefRun(
        deps,
        action.seatId,
        action.runId,
        action.kind === "answer"
          ? Number(/^ask:(\d+)$/.exec(context.item.key)?.[1]) || undefined
          : undefined,
      );
    };
    check();
    await deps.supervisor.message(action.seatId, text, {
      interrupt: false,
      questions: "none",
      enforcePause: true,
      expectedRunId: action.runId,
      beforeWrite: check,
    });
    const questionId =
      action.kind === "answer" ? Number(/^ask:(\d+)$/.exec(context.item.key)?.[1]) : 0;
    if (questionId && store.question(questionId)?.runId === action.runId)
      store.answerQuestion(questionId, deps.now());
    // Record a confirmed provider delivery afterwards; never leave a stale pre-dispatch inbox line
    // that a later turn could mistake for authority. This line is already read by this exact run.
    const message = await sendComms(
      {
        store,
        crew: () =>
          config.crew?.sessions.flatMap((session) => session.seats.map((seat) => seat.id)) ?? [],
        knownSecrets: deps.knownSecrets,
        now: deps.now,
        seatSender: false,
        senderKind: "seatId" in context.actor ? "seat" : "operator",
        ...("runId" in context.actor ? { senderRunId: context.actor.runId } : {}),
      },
      from,
      {
        to: action.seatId,
        text,
        targetRunId: action.runId,
        ...(context.item.ticket ? { ref: context.item.ticket } : {}),
      },
    );
    store.markCommsInboxRead(action.seatId, [message.id]);
    deps.bus?.emit("agents");
    return action.kind === "answer"
      ? "Answer sent to the displayed run."
      : "Guidance delivered within the displayed run's existing authority; no approval was granted.";
  }
  if (action.kind === "direct-queue-priority-swap") {
    if (!deps.queue) throw new BriefError(503, "Direct queue writes are unavailable.");
    context.beforeWrite();
    const proof = context.brief.binding?.actions.find(
      (entry) => entry.optionId === context.optionId,
    )?.proof;
    if (!proof) throw new BriefError(409, "The validated queue snapshot is missing.");
    const result = await reorderQueue(
      deps.queue,
      action.seatId,
      action.move,
      action.above,
      context.beforeWrite,
      proof,
    );
    if (!result.ok) throw new BriefError(409, result.text);
    deps.bus?.emit("boards");
    deps.bus?.emit("agents");
    return result.text;
  }
  if (action.kind === "record-decision") {
    const text = option?.answer;
    if (!text) throw new BriefError(400, "The chosen decision text is missing.");
    await validateCommsText(deps.knownSecrets, text);
    context.beforeWrite();
    store.addFlightDecision({
      at: deps.now(),
      kind: "note",
      seatId: "seatId" in context.actor ? context.actor.seatId : null,
      targetRunId: null,
      ref: context.item.ticket,
      questionId: null,
      about: context.brief.ask ?? context.item.text,
      decision: `Decision recorded: ${text}. No external action was performed.`,
      basis: context.brief.basis,
    });
    store.addComms({
      at: deps.now(),
      from,
      to: currentBriefFlight(config, store)?.seatId ?? COMMS_MC,
      ticket: context.item.ticket,
      text: `Decision recorded for ${context.item.key}; brief ${context.brief.id}, option ${context.optionId}. The full decision is retained in the brief and audit. No external action was performed.`,
    });
    deps.bus?.emit("attention");
    return "Decision recorded. No external action was performed.";
  }
  return null;
}

/** Lazy scheduler adapter: no raw seat lookup or legacy message is replayed. */
export function routineBriefChoices(
  deps: BriefRoutineDeps,
  lock?: () => TestLockState,
): BriefChoiceDeps {
  const queue = deps.queue;
  return {
    ...deps,
    prepareQueue: queue
      ? (seat, move, above) => prepareQueueReorderSnapshot(queue, seat, move, above)
      : undefined,
    item: (key) =>
      attentionItems(
        deps.config,
        deps.store,
        deps.now(),
        lock?.() ?? NO_LOCK,
        undefined,
        null,
        true,
      ).find((item) => item.key === key),
    dispatch: async (action, input, context) => {
      const text = await dispatchRoutineBriefAction(deps, action, input, context);
      if (text === null) throw new BriefError(403, "This protected action has no default adapter.");
      return text;
    },
  };
}
