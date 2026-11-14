import type {
  AttentionBrief,
  AttentionItem,
  BriefAction,
  BriefActor,
  BriefChoiceReceipt,
  BriefChoiceRequest,
} from "@mc/core";
import { holds } from "../attention/holds.ts";
import type { ChangeBus } from "../bus.ts";
import {
  flightQuestionKeys,
  flightQuestionMessageId,
  isFlightOperatorQuestion,
} from "../comms/question.ts";
import { recordWrite, runawayTrip, watchRunaway } from "../flight/runaway.ts";
import { briefActionRoute } from "./dispatch.ts";
import {
  BriefActionRefused,
  BriefError,
  type BriefPreparationDeps,
  prepareBriefActions,
  validBriefActor,
} from "./prepare.ts";
import { briefHash, briefReadState, briefSourceRevision } from "./source.ts";

export interface BriefChoiceDeps extends BriefPreparationDeps {
  bus?: ChangeBus;
  item: (key: string) => AttentionItem | undefined;
  dispatch: (
    action: BriefAction,
    input: BriefChoiceRequest["input"],
    context: {
      actor: BriefActor | { operator: true };
      item: AttentionItem;
      brief: AttentionBrief;
      optionId: string;
      beforeWrite: () => void;
    },
  ) => Promise<string>;
}
interface ChoiceRecord {
  key: string;
  briefId: number;
  sourceRevision: string;
  fingerprint: string;
  receipt: BriefChoiceReceipt;
}
const running = new WeakMap<object, Map<string, Promise<BriefChoiceReceipt>>>();
const setting = (epoch: string) => `brief-choice:${epoch}`;

export function retainedBriefChoice(
  deps: Pick<BriefPreparationDeps, "store">,
  epoch: string,
): BriefChoiceReceipt | null {
  return deps.store.briefChoice(epoch);
}

/** A local decision epoch may settle once. An uncertain external dispatch is never replayed. */
export async function chooseBrief(
  deps: BriefChoiceDeps,
  key: string,
  request: BriefChoiceRequest,
  actor: BriefActor | { operator: true },
  mode: "explicit" | "default" = "explicit",
  claimDefault?: (
    item: AttentionItem,
    brief: AttentionBrief,
    claim: { epoch: string; requestKey: string; fingerprint: string; record: string },
  ) => boolean,
): Promise<BriefChoiceReceipt> {
  const requestKey = `brief-request:${key}:${request.requestId}`;
  const completedRefusal = deps.store.getSetting(`${requestKey}:receipt`);
  if (completedRefusal) {
    const record = JSON.parse(completedRefusal) as ChoiceRecord;
    const expected = briefHash({
      key,
      epoch: record.receipt.epoch,
      sourceRevision: request.sourceRevision,
      optionId: request.optionId,
      input: request.input,
      mode,
    });
    if (record.fingerprint !== expected)
      throw new BriefError(409, "This request ID identifies a different choice.");
    return record.receipt;
  }
  const retainedEpoch = deps.store.getSetting(`${requestKey}:epoch`);
  if (retainedEpoch) {
    const raw = deps.store.getSetting(setting(retainedEpoch));
    if (raw) {
      const retained = JSON.parse(raw) as ChoiceRecord;
      const expected = briefHash({
        key,
        epoch: retainedEpoch,
        sourceRevision: request.sourceRevision,
        optionId: request.optionId,
        input: request.input,
        mode,
      });
      if (retained.fingerprint !== expected)
        throw new BriefError(409, "This request ID identifies a different choice.");
      if (
        retained.receipt.state === "dispatching" &&
        !running.get(deps.store)?.has(retainedEpoch)
      ) {
        retained.receipt = {
          ...retained.receipt,
          state: "unknown",
          text: "The dispatch was interrupted. Its outcome is unknown; inspect it before any new action.",
        };
        deps.store.setSetting(setting(retainedEpoch), JSON.stringify(retained));
        deps.bus?.emit("attention");
        return retained.receipt;
      }
      if (!["pending", "dispatching"].includes(retained.receipt.state)) return retained.receipt;
    }
  }
  const snapshot = deps.store.briefs().get(key);
  if (!snapshot || snapshot.id !== request.briefId || !snapshot.binding)
    throw new BriefError(
      409,
      "Needs a refreshed brief: this brief identity is no longer current or bound.",
    );
  const current: AttentionBrief = snapshot;
  const binding = snapshot.binding;
  const fingerprint = briefHash({
    key,
    epoch: binding.epoch,
    sourceRevision: request.sourceRevision,
    optionId: request.optionId,
    input: request.input,
    mode,
  });
  const priorRequest = deps.store.getSetting(`brief-request:${key}:${request.requestId}`);
  if (priorRequest && priorRequest !== fingerprint)
    throw new BriefError(409, "This request ID already identifies a different choice.");
  const existing = deps.store.getSetting(setting(binding.epoch));
  let resumeRecord: ChoiceRecord | undefined;
  if (existing) {
    const record = JSON.parse(existing) as ChoiceRecord;
    if (record.fingerprint !== fingerprint)
      throw new BriefError(409, "This decision already has a different choice or default.");
    const live = running.get(deps.store)?.get(binding.epoch);
    if (live) return live;
    if (record.receipt.state === "dispatching") {
      record.receipt = {
        ...record.receipt,
        state: "unknown",
        text: "The dispatch was interrupted. Its outcome is unknown; inspect it before any new action.",
      };
      deps.store.setSetting(setting(binding.epoch), JSON.stringify(record));
      deps.bus?.emit("attention");
      return record.receipt;
    }
    if (record.receipt.state !== "pending") return record.receipt;
    resumeRecord = record;
  }
  const run = execute();
  let active = running.get(deps.store);
  if (!active) {
    active = new Map();
    running.set(deps.store, active);
  }
  active.set(binding.epoch, run);
  try {
    return await run;
  } finally {
    active.delete(binding.epoch);
  }

  async function execute(): Promise<BriefChoiceReceipt> {
    let item = deps.item(key);
    const check = () => {
      item = deps.item(key);
      const latest = deps.store.briefs().get(key);
      if (
        !item ||
        !latest?.binding ||
        latest.binding.epoch !== binding.epoch ||
        latest.id !== request.briefId ||
        latest.binding.sourceRevision !== request.sourceRevision ||
        briefReadState(deps.config, deps.store, item, latest).freshness !== "current"
      )
        throw new BriefError(
          409,
          "The source, brief, target or scope changed; refresh before choosing.",
        );
      const hold = holds(deps.store)[key];
      if (item.hold || (hold && hold.releasedAt === undefined))
        throw new BriefError(409, "This decision is held; a choice cannot release it implicitly.");
      if (mode === "default" && deps.store.getSetting(`brief-default-cancel:${binding.epoch}`))
        throw new BriefError(409, "An explicit answer or acknowledgment canceled this default.");
      if (mode === "default" || "seatId" in actor) {
        if (!("seatId" in actor) || !validBriefActor(deps.config, deps.store, actor))
          throw new BriefError(
            403,
            "The declared FLIGHT actor ended or changed; it cannot become operator authority.",
          );
        if (runawayTrip(deps.store))
          throw new BriefError(409, "The runaway breaker holds FLIGHT writes.");
      }
    };
    check();
    if (!item) throw new BriefError(404, "Decision source is no longer open.");
    if (item.acked && !(mode === "default" && resumeRecord))
      throw new BriefError(409, "This decision was already answered or acknowledged.");
    const prepared = await prepareBriefActions(
      { ...deps, actor: "seatId" in actor ? actor : undefined },
      item,
      current,
    );
    check();
    const action = prepared.find((entry) => entry.optionId === request.optionId);
    const saved = binding.actions.find((entry) => entry.optionId === request.optionId);
    if (!action || !saved || briefHash(action) !== briefHash(saved))
      throw new BriefError(409, "The prepared action or its reversible source changed.");
    briefActionRoute(action.action, key, request.input);
    if (
      mode === "default" &&
      (current.decision?.whyOperator ||
        !action.defaultable ||
        request.optionId !== current.recommendedOptionId ||
        request.input)
    )
      throw new BriefError(403, "This action has no authorized FYI default.");
    let record: ChoiceRecord = resumeRecord
      ? {
          ...resumeRecord,
          receipt: {
            ...resumeRecord.receipt,
            actor,
            claimedBy: resumeRecord.receipt.claimedBy ?? resumeRecord.receipt.actor,
          },
        }
      : {
          key,
          briefId: request.briefId,
          sourceRevision: request.sourceRevision,
          fingerprint,
          receipt: {
            epoch: binding.epoch,
            requestId: request.requestId,
            optionId: request.optionId,
            at: deps.now(),
            state: "pending",
            text: "Choice selected; dispatch pending.",
            actor,
            claimedBy: actor,
          },
        };
    const claim = {
      epoch: binding.epoch,
      requestKey: `brief-request:${key}:${request.requestId}`,
      fingerprint,
      record: JSON.stringify(record),
    };
    const claimed =
      resumeRecord !== undefined ||
      (mode === "default"
        ? claimDefault?.(item, current, claim) === true
        : deps.store.claimBriefChoice(
            claim.epoch,
            claim.requestKey,
            claim.fingerprint,
            claim.record,
          ));
    if (!claimed) {
      const other = JSON.parse(
        deps.store.getSetting(setting(binding.epoch)) ?? "null",
      ) as ChoiceRecord | null;
      if (other?.fingerprint === fingerprint) return other.receipt;
      throw new BriefError(409, "Another answer/default claimed this decision first.");
    }
    const save = (state: BriefChoiceReceipt["state"], text: string): BriefChoiceReceipt => {
      record = {
        ...record,
        receipt: {
          ...record.receipt,
          state,
          text,
          ...(state === "applied" ? { completedAt: deps.now() } : {}),
        },
      };
      deps.store.setSetting(setting(binding.epoch), JSON.stringify(record));
      deps.bus?.emit("attention");
      return record.receipt;
    };
    try {
      check();
      if ("seatId" in actor && current.decision?.whyOperator)
        throw new BriefActionRefused(403, "This decision requires the operator's explicit choice.");
      save("dispatching", "The action started; completion is not yet confirmed.");
      const text = await deps.dispatch(action.action, request.input, {
        actor,
        item,
        brief: current,
        optionId: request.optionId,
        beforeWrite: check,
      });
      const after = deps.item(key);
      if (after)
        record.receipt.settledSourceRevision = briefSourceRevision(
          deps.config,
          deps.store,
          after,
          binding.actions.map((entry) => entry.action),
        );
      deps.store.addFlightDecision({
        at: deps.now(),
        kind: "note",
        seatId: "seatId" in actor ? actor.seatId : null,
        targetRunId: "runId" in action.action ? action.action.runId : null,
        ref: item.ticket,
        questionId: null,
        about: `Brief choice ${key}`,
        decision: current.options.find((option) => option.id === request.optionId)?.answer ?? text,
        basis: `brief ${request.briefId}; source ${request.sourceRevision}; epoch ${binding.epoch}; option ${request.optionId}; ${mode}`,
      });
      if (mode === "default") {
        recordWrite(deps.store, {
          at: deps.now(),
          action: "brief_default",
          target: briefHash({ epoch: binding.epoch, optionId: request.optionId }),
          label: key,
        });
        if (deps.bus) watchRunaway(deps.store, deps.bus, deps.now());
      }
      const sourceMessageId = item.agentId ? flightQuestionMessageId(key, item.agentId) : null;
      const aliases: string[] =
        sourceMessageId !== null && item.agentId !== null
          ? isFlightOperatorQuestion(deps.store, sourceMessageId, item.agentId)
            ? [...flightQuestionKeys(sourceMessageId, item.agentId)]
            : [key]
          : [key];
      if (sourceMessageId !== null && item.agentId !== null && aliases.length === 2)
        deps.store.settleCommsItem(sourceMessageId, "CAPCOM", "Chosen in Needs you", deps.now());
      deps.store.ack(aliases, deps.now());
      return save("applied", text);
    } catch (error) {
      const text =
        error instanceof Error ? error.message : "Action completion could not be verified.";
      if (
        error instanceof BriefActionRefused ||
        (error instanceof BriefError && record.receipt.state === "pending")
      ) {
        record.receipt = { ...record.receipt, state: "refused", status: error.status, text };
        deps.store.refuseBriefChoice(
          binding.epoch,
          requestKey,
          fingerprint,
          JSON.stringify(record),
        );
        deps.bus?.emit("attention");
        return record.receipt;
      }
      if (error instanceof BriefError) record.receipt.status = error.status;
      return save(
        record.receipt.state === "pending" ? "stale" : "unknown",
        `${text} No automatic replay will occur; inspect the retained outcome.`,
      );
    }
  }
}
