import { randomUUID } from "node:crypto";
import {
  type AttentionBrief,
  type AttentionItem,
  type BriefAction,
  type BriefActor,
  type BriefBinding,
  type BriefQueuePreparation,
  type PreparedBriefAction,
  seatDef,
} from "@mc/core";
import { heldRun, holdCycle, protectedDecisionItem } from "../attention/holds.ts";
import { pendingRunApproval } from "../attention/subjects.ts";
import { activeAway } from "../away.ts";
import type { CcConfig } from "../config.ts";
import { pausedSeat } from "../crew-pause.ts";
import { runawayTrip } from "../flight/runaway.ts";
import { isOperatorCall, questionWithOperator } from "../hud.ts";
import type { Store } from "../store.ts";
import { CompleteBriefContent } from "./schema.ts";
import { briefHash, briefSourceRevision } from "./source.ts";

export class BriefError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}
export class BriefDeferred extends BriefError {}
/** A confirmed refusal before any action took effect. */
export class BriefActionRefused extends BriefError {}
export interface BriefPreparationDeps {
  config: CcConfig;
  store: Store;
  now: () => number;
  actor?: BriefActor;
  prepareQueue?: (seatId: string, move: string, above: string) => Promise<BriefQueuePreparation>;
}
export const ORDINARY_GUIDANCE =
  "Continue only within the current ticket, repository rules, standing instructions and existing authority. Keep the choice reversible and report your assumptions. This message grants no approval, spending, scope change or hold release. If the work needs an operator/controller decision or remains blocked, stay blocked and ask FLIGHT.";

export function completeBriefError(brief: AttentionBrief): string | null {
  if (!brief.decision)
    return "decision.whyOperator: provide the operator reason and complete decision context, or a supported authorized FYI action.";
  const parsed = CompleteBriefContent.safeParse(brief);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `${issue?.path.join(".") || "brief"}: ${issue?.message ?? "Complete decision context is required."}`;
}

export function validBriefActor(config: CcConfig, store: Store, actor: BriefActor): boolean {
  const seat = config.crew?.sessions
    .flatMap((session) => session.seats)
    .find((entry) => entry.id === actor.seatId);
  const row = store.seatSession(actor.seatId);
  const run = store.run(actor.runId);
  return (
    seat?.role === "FLIGHT" &&
    seatDef(seat).loop === "watch" &&
    !seat.retiring &&
    row?.runId === actor.runId &&
    row.state !== "stopped" &&
    run?.agentId === actor.seatId &&
    run.endedAt === null &&
    run.status === "running"
  );
}

export function currentBriefFlight(
  config: CcConfig,
  store: Store,
  targetSeatId?: string,
): BriefActor | null {
  for (const session of config.crew?.sessions ?? []) {
    if (targetSeatId && !session.seats.some((seat) => seat.id === targetSeatId)) continue;
    for (const seat of session.seats) {
      if (seat.role !== "FLIGHT" || seat.retiring || seatDef(seat).loop !== "watch") continue;
      const row = store.seatSession(seat.id);
      const run = row?.runId ? store.run(row.runId) : null;
      if (run && validBriefActor(config, store, { seatId: seat.id, runId: run.id }))
        return { seatId: seat.id, runId: run.id };
    }
  }
  return null;
}

/** Shared automatic-delivery guard. It is checked again inside the supervisor's queued write. */
export function checkBriefRun(
  deps: BriefPreparationDeps,
  seatId: string,
  runId: string,
  explicitQuestionId?: number,
): void {
  const { config, store } = deps;
  const run = store.run(runId);
  const seat = config.crew?.sessions
    .flatMap((s) => s.seats)
    .find((s) => s.id === seatId && !s.retiring);
  if (
    !seat ||
    !run ||
    run.agentId !== seatId ||
    run.status !== "running" ||
    run.endedAt !== null ||
    (store.seatSession(seatId)?.runId !== runId &&
      !(explicitQuestionId !== undefined && run.loop?.aside?.ask === explicitQuestionId))
  )
    throw new BriefError(409, "The intended seat/run changed or ended; refresh the brief.");
  if (
    pausedSeat(store, seatId, runId) ||
    heldRun(store, config, deps.now(), run, undefined, { excludeQuestionId: explicitQuestionId }) ||
    pendingRunApproval(store, run) ||
    run.loop?.phase === "parked"
  )
    throw new BriefDeferred(
      409,
      "The intended run is paused, stopped, parked or held for approval.",
    );
}

/** Positive ordinary FYI case: fixed guidance, actual actor/run and existing service boundaries. */
export function prepareOrdinaryGuidance(
  deps: BriefPreparationDeps,
  item: AttentionItem,
  action: Extract<BriefAction, { kind: "ordinary-run-guidance" }>,
): PreparedBriefAction {
  const { config, store } = deps;
  const at = deps.now();
  if (item.agentId !== action.seatId)
    throw new BriefError(409, "The FYI recipient differs from its source.");
  const qid = /^ask:(\d+)$/.exec(item.key)?.[1];
  checkBriefRun(deps, action.seatId, action.runId, qid === undefined ? undefined : Number(qid));
  const question = qid ? store.question(Number(qid)) : null;
  if (
    isOperatorCall(item, store) ||
    protectedDecisionItem(store, item, config, at) ||
    (question && questionWithOperator(question, store.briefs().get(item.key)))
  )
    throw new BriefError(409, "This source needs a human decision; guidance cannot settle it.");
  const actor = deps.actor ?? currentBriefFlight(config, store, action.seatId);
  if (
    !actor ||
    !validBriefActor(config, store, actor) ||
    pausedSeat(store, actor.seatId, actor.runId) ||
    activeAway(store, at, config.operator.timezone) ||
    runawayTrip(store)
  )
    throw new BriefDeferred(409, "No current authorized FLIGHT actor can deliver this FYI.");
  if (
    !config.crew?.sessions.some(
      (session) =>
        session.seats.some((seat) => seat.id === actor.seatId) &&
        session.seats.some((seat) => seat.id === action.seatId),
    )
  )
    throw new BriefError(403, "This FYI recipient is outside FLIGHT's session.");
  return {
    optionId: "proceed",
    action,
    defaultable: true,
    effect: actionEffect(action),
    proof: briefHash({ guidance: ORDINARY_GUIDANCE }),
  };
}

const actionEffect = (action: BriefAction): string => {
  switch (action.kind) {
    case "answer":
      return "Answer sent to the displayed run";
    case "ordinary-run-guidance":
      return "Within-authority guidance delivered to the displayed run";
    case "direct-queue-priority-swap":
      return "Swap the two displayed board Priority values";
    case "review-rework":
      return "Send the displayed rework and resume this review park";
    case "run-resume":
      return "Resume this exact displayed run park using the existing operator guards";
    case "review-resume":
      return "Accept findings and resume this review park";
    case "queue-proposal":
      return action.action === "approve"
        ? "Approve this Priority proposal"
        : "Leave this queue order unchanged";
    case "person-post":
      return "Post the displayed source-bound reply";
    case "person-handled":
      return action.how === "copied"
        ? "Record this reply as copied"
        : action.how === "flight"
          ? "Let FLIGHT handle this thread"
          : "Mark this thread handled locally";
    case "controller-check":
      return "Record the displayed controller verdict for this exact head";
    case "uat":
      return action.action === "accept"
        ? "Accept this exact PR head"
        : "Send this exact PR head back";
    case "floor-grant":
      return "Record the displayed rule/scope/expiry grant";
    case "merge-hold":
      return action.action === "hold"
        ? "Hold this merge"
        : "Release this merge hold; no other approval is supplied";
    case "breaker-recovery":
      return "Lift the runaway breaker after explicit operator recovery";
    case "attention-hold":
      return "Hold this item for the displayed condition";
    case "attention-dismiss":
      return "Dismiss this ordinary note; no recommendation is executed";
    case "record-decision":
      return "Record this decision; no external action is performed";
  }
};

export async function prepareBriefActions(
  deps: BriefPreparationDeps,
  item: AttentionItem,
  brief: AttentionBrief,
): Promise<PreparedBriefAction[]> {
  const problem = completeBriefError(brief);
  if (problem) throw new BriefError(400, problem);
  const { config, store } = deps;
  const at = deps.now();
  const result: PreparedBriefAction[] = [];
  const note = item.key.startsWith("note:")
    ? store.notes().find((n) => `note:${n.key}` === item.key)
    : undefined;
  const itemRun = note?.runId ?? (item.agentId ? store.seatRun(item.agentId)?.id : null);
  const sourceRun = itemRun ? store.run(itemRun) : null;
  const prSource = /^pr:([^#]+)#([1-9][0-9]*):/.exec(item.key);
  const matchesPrSource = (repoId: string, number: number): boolean =>
    item.repoId === repoId &&
    ((prSource?.[1] === repoId && Number(prSource[2]) === number) ||
      (sourceRun?.repoId === repoId && sourceRun.loop?.prNumber === number));
  for (const option of brief.options) {
    const action = option.action;
    if (!action || !option.id)
      throw new BriefError(400, "options.action: specify a typed action and option ID.");
    let proof: string | undefined;
    let reversibleState: BriefQueuePreparation["reversibleState"] | undefined;
    let defaultable = false;
    if ("runId" in action && !["answer", "ordinary-run-guidance"].includes(action.kind)) {
      if (!itemRun || action.runId !== itemRun)
        throw new BriefError(409, "The action is not bound to this item's run.");
      const run = store.run(action.runId);
      const pr = run?.loop?.prNumber ? store.pullRequest(run.repoId, run.loop.prNumber) : null;
      const currentSha = pr?.headSha ?? store.newestRunCommit(action.runId)?.sha;
      if ("sha" in action && currentSha !== action.sha)
        throw new BriefError(409, "The proposed review head changed or is unknown.");
      if (
        (action.kind === "review-rework" || action.kind === "review-resume") &&
        !["review", "review-ruling"].includes(run?.loop?.parked?.kind ?? "")
      )
        throw new BriefError(409, "The source is not the displayed review park.");
    }
    switch (action.kind) {
      case "answer":
      case "ordinary-run-guidance": {
        const target = item.agentId ?? currentBriefFlight(config, store)?.seatId;
        if (!target || target !== action.seatId)
          throw new BriefError(409, "The proposed answer target differs from the source.");
        checkBriefRun(
          deps,
          action.seatId,
          action.runId,
          Number(/^ask:(\d+)$/.exec(item.key)?.[1]) || undefined,
        );
        if (action.kind === "ordinary-run-guidance") {
          proof = prepareOrdinaryGuidance(deps, item, action).proof;
          defaultable = true;
        }
        break;
      }
      case "direct-queue-priority-swap": {
        if (
          isOperatorCall(item, store) ||
          protectedDecisionItem(store, item, config, at) ||
          item.key.startsWith("note:queue-reorder:")
        )
          throw new BriefError(
            409,
            "A human approval proposal cannot become a direct queue default.",
          );
        const actor = deps.actor ?? currentBriefFlight(config, store, action.seatId);
        if (
          !actor ||
          !validBriefActor(config, store, actor) ||
          pausedSeat(store, actor.seatId, actor.runId) ||
          runawayTrip(store)
        )
          throw new BriefError(409, "No current authorized FLIGHT actor can prepare this FYI.");
        if (
          !config.crew?.sessions.some(
            (session) =>
              session.seats.some((seat) => seat.id === actor.seatId) &&
              session.seats.some((seat) => seat.id === action.seatId),
          )
        )
          throw new BriefError(403, "This queue is outside FLIGHT's session.");
        if (!deps.prepareQueue)
          throw new BriefError(409, "Direct queue preparation is unavailable.");
        const prepared = await deps.prepareQueue(action.seatId, action.move, action.above);
        proof = prepared.proof;
        reversibleState = prepared.reversibleState;
        defaultable = true;
        break;
      }
      case "queue-proposal": {
        if (action.key !== item.key || !item.key.startsWith("note:queue-reorder:"))
          throw new BriefError(409, "Queue proposal identity changed.");
        let proposal: { state?: string } | null;
        try {
          proposal = JSON.parse(store.getSetting(action.key.slice(5)) ?? "null");
        } catch {
          throw new BriefError(409, "The stored queue proposal is unreadable; refresh it.");
        }
        if (proposal?.state !== "pending")
          throw new BriefError(409, "This queue proposal is no longer pending.");
        break;
      }
      case "person-post":
      case "person-handled":
        if (item.kind !== "person" || !brief.person)
          throw new BriefError(409, "The person source is unavailable.");
        if (
          "replyId" in action &&
          action.replyId &&
          !brief.person.replies?.some((r) => r.id === action.replyId)
        )
          throw new BriefError(409, "The displayed person reply changed.");
        if ("replyId" in action && action.replyId)
          proof = briefHash({
            source: brief.person.source,
            reply: brief.person.replies
              ?.filter((reply) => reply.id === action.replyId)
              .map((reply) => ({ id: reply.id, text: reply.text })),
          });
        if (action.kind === "person-post" && brief.person.source.kind !== "github")
          throw new BriefError(400, "This source supports copy/handled only, not posting.");
        if (
          action.kind === "person-handled" &&
          action.how === "copied" &&
          (brief.person.source.kind !== "teams" || !action.replyId)
        )
          throw new BriefError(400, "Copy/handled requires the exact suggested Teams reply.");
        break;
      case "controller-check":
      case "merge-hold": {
        const target = action.target;
        if (target.kind === "run") {
          if (!itemRun || target.runId !== itemRun)
            throw new BriefError(409, "The approval target is not this item's run.");
          const run = store.run(target.runId);
          const pr = run?.loop?.prNumber ? store.pullRequest(run.repoId, run.loop.prNumber) : null;
          if ((pr?.headSha ?? store.newestRunCommit(target.runId)?.sha) !== target.sha)
            throw new BriefError(409, "The approval head changed or is unknown.");
        } else {
          if (
            !matchesPrSource(target.repoId, target.number) ||
            !config.repos.some((r) => r.id === target.repoId)
          )
            throw new BriefError(409, "The configured approval repo changed.");
          const pr = store.pullRequest(target.repoId, target.number);
          if (pr?.state !== "open" || pr.headSha !== target.sha)
            throw new BriefError(409, "The approval PR/head changed.");
        }
        break;
      }
      case "uat": {
        const pr = store.pullRequest(action.repoId, action.number);
        if (
          !matchesPrSource(action.repoId, action.number) ||
          !pr ||
          pr.state !== "open" ||
          pr.headSha !== action.sha
        )
          throw new BriefError(409, "The displayed acceptance head changed.");
        break;
      }
      case "floor-grant":
        if (
          !brief.decision?.whyOperator ||
          Date.parse(action.until) <= at ||
          Date.parse(action.until) > at + 7 * 24 * 60 * 60_000
        )
          throw new BriefError(400, "Provide a current explicit operator scope/expiry grant.");
        break;
      case "breaker-recovery":
        if (item.key !== "note:flight-runaway")
          throw new BriefError(409, "This is not the runaway recovery source.");
        break;
      case "record-decision":
        if (item.key.startsWith("ask:"))
          throw new BriefError(
            400,
            "A seat question needs its typed answer action; recording a decision alone does not answer it.",
          );
        proof = briefHash({ answer: option.answer });
        if (
          item.kind === "approval" ||
          item.key === "note:flight-runaway" ||
          item.key.startsWith("note:queue-reorder:") ||
          item.kind === "person"
        )
          throw new BriefError(
            400,
            "This source needs its actual typed resolver, not a recorded answer substitute.",
          );
        break;
      case "attention-hold":
        if (holdCycle(store, item.key, action.condition))
          throw new BriefError(409, "That wait condition would create an item-hold cycle.");
        break;
      case "attention-dismiss":
        if (!item.key.startsWith("note:") || item.key === "note:flight-runaway")
          throw new BriefError(400, "Use the actual typed resolver for this source.");
        break;
      case "run-resume": {
        const loop = store.run(action.runId)?.loop;
        if (
          loop?.phase !== "parked" ||
          loop.parked?.kind !== action.parkKind ||
          loop.parked.ended ||
          [
            "review",
            "review-ruling",
            "controller-check",
            "uat",
            "merge-hold",
            "pr-closed",
          ].includes(action.parkKind)
        )
          throw new BriefError(
            409,
            "This is not the displayed resumable operator park; use its dedicated typed resolver where required.",
          );
        break;
      }
      case "review-rework":
      case "review-resume":
        break;
    }
    result.push({
      optionId: option.id,
      action,
      defaultable: defaultable && !brief.decision?.whyOperator,
      effect: actionEffect(action),
      ...(proof ? { proof } : {}),
      ...(reversibleState ? { reversibleState } : {}),
    });
  }
  return result;
}

export async function bindCompleteBrief(
  deps: BriefPreparationDeps,
  item: AttentionItem,
  brief: AttentionBrief,
  preparedBy: BriefBinding["preparedBy"],
): Promise<AttentionBrief> {
  const before = briefSourceRevision(
    deps.config,
    deps.store,
    item,
    brief.options.flatMap((option) => (option.action ? [option.action] : [])),
  );
  const actions = await prepareBriefActions(deps, item, brief);
  const recommended = actions.find((action) => action.optionId === brief.recommendedOptionId);
  if (!brief.decision?.whyOperator && !recommended?.defaultable)
    throw new BriefError(
      400,
      "decision.whyOperator: give the genuine operator reason, or choose a supported authorized reversible FYI action.",
    );
  if (brief.decision?.whyOperator && !brief.decision.waiting?.trim())
    throw new BriefError(
      400,
      "decision.waiting: specify the explicit waiting condition; operator decisions never default.",
    );
  const sourceRevision = briefSourceRevision(
    deps.config,
    deps.store,
    item,
    actions.map((entry) => entry.action),
  );
  if (before !== sourceRevision)
    throw new BriefError(409, "The source changed during preparation; refresh before briefing.");
  return bindPreparedBrief(deps, item, brief, preparedBy, actions);
}

/** Only trusted hub producers use this after constructing and validating their typed actions. */
export function bindPreparedBrief(
  deps: BriefPreparationDeps,
  item: AttentionItem,
  brief: AttentionBrief,
  preparedBy: BriefBinding["preparedBy"],
  actions: PreparedBriefAction[],
): AttentionBrief {
  const problem = completeBriefError(brief);
  if (problem) throw new BriefError(400, problem);
  const recommended = actions.find((entry) => entry.optionId === brief.recommendedOptionId);
  if (
    !brief.decision?.whyOperator &&
    brief.options.find((option) => option.id === brief.recommendedOptionId)?.reversibility?.kind !==
      "reversible"
  )
    throw new BriefError(
      400,
      "The recommended FYI must describe its validated reversible effect; otherwise give the genuine operator reason.",
    );
  if (!brief.decision?.whyOperator && !recommended?.defaultable)
    throw new BriefError(400, "No positive FYI action is authorized.");
  if (brief.decision?.whyOperator && !brief.decision.waiting)
    throw new BriefError(400, "Specify the explicit operator waiting condition.");
  const sourceRevision = briefSourceRevision(
    deps.config,
    deps.store,
    item,
    actions.map((entry) => entry.action),
  );
  const meaningKey = briefHash({
    sourceRevision,
    recommendedOptionId: brief.recommendedOptionId,
    actions: actions.map(({ optionId, action, proof }) => ({ optionId, action, proof })),
    why: brief.decision?.whyOperator,
  });
  const prior = deps.store.briefs().get(item.key)?.binding;
  return {
    ...brief,
    binding: {
      version: 2,
      sourceRevision,
      meaningKey,
      epoch: prior?.meaningKey === meaningKey ? prior.epoch : randomUUID(),
      epochId: prior?.meaningKey === meaningKey ? prior.epochId : 0,
      preparedAt: deps.now(),
      preparedBy,
      actions,
    },
  };
}
