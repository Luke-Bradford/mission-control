import { type BriefAction, type BriefChoiceRequest, COMMS_MESSAGE_MAX } from "@mc/core";
import { BriefError } from "./brief-prepare.ts";

export { checkBriefDispatch, withinBriefDispatch } from "./brief-dispatch-context.ts";

const enc = encodeURIComponent;
type Route = { path: string; body: object };
/** This exhaustive registry selects existing typed routes, never a producer-supplied method/URL. */
export function briefActionRoute(
  action: BriefAction,
  key: string,
  input: BriefChoiceRequest["input"],
): Route | null {
  if (
    input?.text !== undefined &&
    !["answer", "review-rework", "person-post"].includes(action.kind)
  )
    throw new BriefError(400, "Text editing is not an input to this action.");
  if (input?.note !== undefined && !["controller-check", "uat"].includes(action.kind))
    throw new BriefError(400, "A note is not an input to this action.");
  if (
    input?.text !== undefined &&
    action.kind !== "person-post" &&
    input.text.length > COMMS_MESSAGE_MAX
  )
    throw new BriefError(400, `This message must fit ${COMMS_MESSAGE_MAX} characters.`);
  if (
    action.kind === "controller-check" &&
    `${input?.note ?? action.note ?? ""}\nEvidence: ${action.evidence}`.trim().length >
      COMMS_MESSAGE_MAX
  )
    throw new BriefError(
      400,
      "The note and evidence reference exceed the existing controller-check limit.",
    );
  switch (action.kind) {
    case "review-rework":
      return {
        path: `/api/runs/${enc(action.runId)}/message`,
        body: { text: input?.text ?? action.text },
      };
    case "run-resume":
    case "review-resume":
      return { path: `/api/runs/${enc(action.runId)}/resume`, body: {} };
    case "queue-proposal":
      return { path: `/api/queue/reorder/${enc(action.key)}`, body: { action: action.action } };
    case "person-post":
      return {
        path: `/api/attention/${enc(key)}/replies/${enc(action.replyId)}/post`,
        body: input?.text === undefined ? {} : { text: input.text },
      };
    case "person-handled":
      return {
        path: `/api/attention/${enc(key)}/handled`,
        body: { how: action.how, ...(action.replyId ? { replyId: action.replyId } : {}) },
      };
    case "controller-check": {
      const target = action.target;
      return {
        path:
          target.kind === "run"
            ? `/api/runs/${enc(target.runId)}/controller-check`
            : `/api/prs/${enc(target.repoId)}/${target.number}/controller-check`,
        body: {
          sha: target.sha,
          verdict: action.verdict,
          note: `${input?.note ?? action.note ?? ""}\nEvidence: ${action.evidence}`.trim(),
        },
      };
    }
    case "uat":
      return {
        path: `/api/prs/${enc(action.repoId)}/${action.number}/uat`,
        body: {
          action: action.action,
          sha: action.sha,
          ...((input?.note ?? action.note) ? { note: input?.note ?? action.note } : {}),
        },
      };
    case "floor-grant":
      return {
        path: "/api/flight/approvals",
        body: {
          rule: action.rule,
          scope: action.scope,
          until: action.until,
          reason: action.reason,
        },
      };
    case "merge-hold": {
      const target = action.target;
      return {
        path:
          target.kind === "run"
            ? `/api/runs/${enc(target.runId)}/merge-hold`
            : `/api/prs/${enc(target.repoId)}/${target.number}/merge-hold`,
        body: {
          action: action.action,
          ...(target.kind === "pr" ? { sha: target.sha } : {}),
          ...(action.reason ? { reason: action.reason } : {}),
        },
      };
    }
    case "breaker-recovery":
      return { path: "/api/flight/runaway/lift", body: {} };
    case "attention-hold":
      return {
        path: `/api/attention/${enc(key)}/hold`,
        body: { reason: action.reason, condition: action.condition },
      };
    case "attention-dismiss":
      return { path: `/api/attention/${enc(key)}/dismiss`, body: {} };
    case "answer":
    case "ordinary-run-guidance":
    case "direct-queue-priority-swap":
    case "record-decision":
      return null;
  }
}
