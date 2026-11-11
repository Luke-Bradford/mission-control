import {
  BRIEF_INPUT_MAX,
  BRIEF_LABEL_MAX,
  BRIEF_OPTIONS_MAX,
  BRIEF_OPTIONS_MIN,
  COMMS_MESSAGE_MAX,
  MC_TEXT_MAX,
} from "@mc/core";
import { z } from "zod";
import { AttentionHoldInput } from "../attention/hold-schema.ts";

const text = z.string().trim().min(1).max(BRIEF_INPUT_MAX);
const messageText = z.string().trim().min(1).max(COMMS_MESSAGE_MAX);
const identity = z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/);
const id = z.string().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("run"), runId: id, sha }),
  z.strictObject({ kind: z.literal("pr"), repoId: id, number, sha }),
]);

export const BriefActionInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), seatId: id, runId: id, text: messageText }),
  z.strictObject({ kind: z.literal("ordinary-run-guidance"), seatId: id, runId: id }),
  z.strictObject({
    kind: z.literal("direct-queue-priority-swap"),
    seatId: id,
    move: id,
    above: id,
  }),
  z.strictObject({ kind: z.literal("review-rework"), runId: id, sha, text: messageText }),
  z.strictObject({ kind: z.literal("review-resume"), runId: id, sha }),
  z.strictObject({
    kind: z.literal("run-resume"),
    runId: id,
    parkKind: z.string().trim().min(1).max(80),
  }),
  z.strictObject({
    kind: z.literal("queue-proposal"),
    key: id,
    action: z.enum(["approve", "deny"]),
  }),
  z.strictObject({ kind: z.literal("person-post"), replyId: identity }),
  z.strictObject({
    kind: z.literal("person-handled"),
    how: z.enum(["marked", "copied", "flight"]),
    replyId: identity.optional(),
  }),
  z.strictObject({
    kind: z.literal("controller-check"),
    target,
    verdict: z.enum(["pass", "fail"]),
    note: messageText.optional(),
    evidence: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("uat"),
    repoId: id,
    number,
    sha,
    action: z.enum(["accept", "send_back"]),
    note: messageText.optional(),
  }),
  z.strictObject({
    kind: z.literal("floor-grant"),
    rule: z.enum(["merge-floor", "repo-rules", "merge-push"]),
    scope: z.string().trim().min(1).max(500),
    until: z.iso.datetime({ offset: true }),
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    kind: z.literal("merge-hold"),
    target,
    action: z.enum(["hold", "release"]),
    reason: z.string().trim().min(1).max(300).optional(),
  }),
  z.strictObject({ kind: z.literal("breaker-recovery") }),
  z.strictObject({
    kind: z.literal("attention-hold"),
    reason: AttentionHoldInput.shape.reason,
    condition: AttentionHoldInput.shape.condition,
  }),
  z.strictObject({ kind: z.literal("attention-dismiss") }),
  z.strictObject({ kind: z.literal("record-decision") }),
]);

export const BriefDecisionInput = z.strictObject({
  whyOperator: z
    .strictObject({
      kind: z.enum([
        "money",
        "product-direction",
        "security-exception",
        "irreversible",
        "floor-approval",
      ]),
      explanation: text,
    })
    .optional(),
  consulted: z
    .array(
      z.strictObject({
        who: z.string().trim().min(1).max(BRIEF_LABEL_MAX),
        finding: text,
        ref: id.optional(),
      }),
    )
    .max(20),
  costOfDelay: text,
  waiting: text.optional(),
});

export const CompleteBriefContent = z
  .object({
    ask: text,
    assessment: text.optional(),
    context: text,
    did: z.array(z.strictObject({ action: text, refs: z.array(id).max(20) })).max(20),
    checked: z
      .array(
        z.strictObject({ source: z.string().trim().min(1).max(BRIEF_LABEL_MAX), finding: text }),
      )
      .max(20),
    recommendation: text,
    recommendedOptionId: identity,
    decision: BriefDecisionInput,
    options: z
      .array(
        z.object({
          id: identity,
          label: z.string().trim().min(1).max(BRIEF_LABEL_MAX),
          answer: text,
          consequence: text,
          reversibility: z.strictObject({
            kind: z.enum(["reversible", "partly-reversible", "irreversible"]),
            detail: text,
          }),
          action: BriefActionInput,
        }),
      )
      .min(BRIEF_OPTIONS_MIN)
      .max(BRIEF_OPTIONS_MAX),
  })
  .superRefine((value, ctx) => {
    const ids = value.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["options"], message: "Use unique option IDs." });
    if (!ids.includes(value.recommendedOptionId))
      ctx.addIssue({
        code: "custom",
        path: ["recommendedOptionId"],
        message: "Identify one option by its ID.",
      });
    for (const [index, option] of value.options.entries()) {
      const action = option.action;
      if (
        (action.kind === "controller-check" && action.verdict === "fail" && !action.note) ||
        (action.kind === "uat" && action.action === "send_back" && !action.note) ||
        (action.kind === "merge-hold" && action.action === "hold" && !action.reason)
      )
        ctx.addIssue({
          code: "custom",
          path: ["options", index, "action"],
          message: "Supply the required failure note or hold reason in the proposed action.",
        });
      if (
        action.kind === "controller-check" &&
        `${action.note ?? ""}\nEvidence: ${action.evidence}`.trim().length > COMMS_MESSAGE_MAX
      )
        ctx.addIssue({
          code: "custom",
          path: ["options", index, "action", "note"],
          message: `Note and evidence reference together must fit ${COMMS_MESSAGE_MAX} characters.`,
        });
    }
  });

export const BriefChoiceInput = z.strictObject({
  briefId: number,
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  optionId: identity,
  requestId: identity,
  input: z
    .strictObject({
      note: messageText.optional(),
      text: z.string().trim().min(1).max(MC_TEXT_MAX).optional(),
    })
    .optional(),
});
