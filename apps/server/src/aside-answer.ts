import type { ChangeBus } from "./bus.ts";
import { type CommsServiceDeps, sendComms } from "./comms/index.ts";

export class AsideAnswerChanged extends Error {
  readonly statusCode = 409;
}

export class AsideAnswerUnconfirmed extends Error {
  readonly statusCode = 502;
}

/** A stored answer belongs to its preserved run, never the next occupant of the seat. */
export async function answerAsideQuestion(
  deps: CommsServiceDeps & { bus: ChangeBus; reconcileRun?: (runId: string) => Promise<void> },
  questionId: number,
  from: string,
  text: string,
): Promise<void> {
  const target = () => {
    deps.beforeWrite?.();
    const question = deps.store.question(questionId);
    const run = question ? deps.store.run(question.runId) : null;
    if (
      !question ||
      question.answeredAt !== null ||
      question.passedAt === null ||
      !run ||
      run.endedAt !== null ||
      !run.loop?.aside
    )
      throw new AsideAnswerChanged(
        "The preserved question changed or ended; refresh before answering.",
      );
    return { question, run };
  };
  const { question, run } = target();
  await sendComms(
    {
      ...deps,
      senderKind: deps.senderKind,
      beforeWrite: () => {
        target();
      },
    },
    from,
    {
      to: question.agentId,
      text,
      ref: run.ticket ?? undefined,
      targetRunId: run.id,
    },
  );
  try {
    deps.store.answerQuestion(questionId, deps.now?.() ?? Date.now());
    deps.bus.emit("attention");
    await deps.reconcileRun?.(run.id);
  } catch {
    throw new AsideAnswerUnconfirmed(
      "The answer is stored, but waking its run could not be confirmed.",
    );
  }
}
