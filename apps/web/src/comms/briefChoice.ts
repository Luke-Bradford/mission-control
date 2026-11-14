/**
 * The bound choice on a complete operator brief. Eligibility and effect come only from the
 * server's binding, freshness and receipt on the item; labels, ids, kinds and chat never decide.
 */
import type {
  AttentionItem,
  BriefChoiceReceipt,
  BriefChoiceRequest,
  BriefOperatorReason,
  PreparedBriefAction,
} from "@mc/core";
import { useSyncExternalStore } from "react";
import { ApiError, apiPost } from "../api.ts";
import { ACTIONS, hub, RESOURCES } from "../data.ts";

export const REFRESH_NEEDED = "Needs a refreshed brief";

export type ChoiceInput = NonNullable<BriefChoiceRequest["input"]>;

/** Which typed extra input the server's action accepts. */
export type InputForm =
  | { field: "text"; label: string; initial: string }
  | { field: "note"; label: string; initial: string };

export function inputFormOf(prepared: PreparedBriefAction | undefined): InputForm | null {
  const action = prepared?.action;
  if (!action) return null;
  if (action.kind === "answer" || action.kind === "review-rework")
    return { field: "text", label: "Message to send", initial: action.text };
  if (action.kind === "controller-check" || action.kind === "uat")
    return { field: "note", label: "Note", initial: action.note ?? "" };
  return null;
}

export type Availability = { ok: true } | { ok: false; reason: string };

export interface AvailabilityContext {
  /** Whether the resource stream is connected and the item still listed. */
  connected: boolean;
  gone: boolean;
}

/** Whether the bound recommended/other option can be sent now, with the reason when it cannot. */
export function choiceAvailability(
  item: AttentionItem,
  optionId: string | undefined,
  context: AvailabilityContext,
): Availability {
  const brief = item.brief;
  if (context.gone) return { ok: false, reason: "This item is no longer waiting on you." };
  if (!brief?.binding || brief.id === undefined || !brief.state)
    return { ok: false, reason: `${REFRESH_NEEDED}: this brief has no bound choices.` };
  if (!context.connected)
    return { ok: false, reason: "Disconnected. Reconnect to see whether this is still current." };
  if (brief.state.completeness !== "complete")
    return { ok: false, reason: `${REFRESH_NEEDED}. ${brief.state.reason}` };
  if (brief.state.freshness === "stale")
    return { ok: false, reason: `${REFRESH_NEEDED}: the source changed. ${brief.state.reason}` };
  if (brief.state.freshness !== "current")
    return { ok: false, reason: `${REFRESH_NEEDED}: freshness is unknown. ${brief.state.reason}` };
  if (item.hold) return { ok: false, reason: "Held. Release the hold to choose." };
  const settled = brief.choice;
  if (settled && (settled.state === "pending" || settled.state === "dispatching"))
    return { ok: false, reason: "A choice is already being applied." };
  if (settled?.state === "unknown")
    return {
      ok: false,
      reason: "The last choice has an unknown result. It is not sent again; refresh the brief.",
    };
  if (
    settled?.state === "applied" &&
    settled.settledSourceRevision === brief.binding.sourceRevision
  )
    return { ok: false, reason: "This choice is already recorded." };
  if (optionId === undefined || !brief.binding.actions.some((a) => a.optionId === optionId))
    return { ok: false, reason: "The server did not prepare an action for this option." };
  return { ok: true };
}

export function preparedFor(
  item: AttentionItem,
  optionId: string | undefined,
): PreparedBriefAction | undefined {
  return item.brief?.binding?.actions.find((a) => a.optionId === optionId);
}

// ---- Per-item send state, kept outside React so tab/card changes cannot lose or cross it. ----

export interface ChoiceAttempt {
  /** The brief and revision captured when the operator pressed the button. */
  briefId: number;
  sourceRevision: string;
  optionId: string;
  requestId: string;
  input?: ChoiceInput;
  status: "sending" | "error" | "receipt";
  error?: string;
  receipt?: BriefChoiceReceipt;
}

export const attemptKey = (itemKey: string) => itemKey;
const attempts = new Map<string, ChoiceAttempt>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useChoiceAttempt(itemKey: string): ChoiceAttempt | undefined {
  return useSyncExternalStore(
    subscribe,
    () => attempts.get(attemptKey(itemKey)),
    () => undefined,
  );
}

export function resetChoiceAttempts(): void {
  attempts.clear();
  emit();
}

const sameInput = (a?: ChoiceInput, b?: ChoiceInput) =>
  (a?.note ?? null) === (b?.note ?? null) && (a?.text ?? null) === (b?.text ?? null);

const isReceipt = (body: unknown): body is BriefChoiceReceipt =>
  typeof body === "object" &&
  body !== null &&
  typeof (body as { requestId?: unknown }).requestId === "string" &&
  typeof (body as { state?: unknown }).state === "string";

/**
 * Sends the bound choice. The same request id is reused when the same option and input are
 * retried after a failure or uncertain result; a changed option or input gets a new one.
 * A second call while one is in flight is ignored.
 */
export async function submitChoice(
  item: AttentionItem,
  optionId: string,
  input?: ChoiceInput,
): Promise<void> {
  const brief = item.brief;
  if (brief?.id === undefined || !brief.binding) return;
  const k = attemptKey(item.key);
  const prior = attempts.get(k);
  if (prior?.status === "sending") return;
  const reusable =
    prior !== undefined &&
    prior.status === "error" &&
    prior.briefId === brief.id &&
    prior.sourceRevision === brief.binding.sourceRevision &&
    prior.optionId === optionId &&
    sameInput(prior.input, input);
  const attempt: ChoiceAttempt = {
    briefId: brief.id,
    sourceRevision: brief.binding.sourceRevision,
    optionId,
    requestId: reusable ? prior.requestId : crypto.randomUUID(),
    ...(input ? { input } : {}),
    status: "sending",
  };
  attempts.set(k, attempt);
  emit();
  const body: BriefChoiceRequest = {
    briefId: attempt.briefId,
    sourceRevision: attempt.sourceRevision,
    optionId,
    requestId: attempt.requestId,
    ...(input ? { input } : {}),
  };
  let next: ChoiceAttempt;
  try {
    const receipt = await apiPost<BriefChoiceReceipt>(ACTIONS.briefChoice(item.key), body);
    next = { ...attempt, status: "receipt", receipt };
  } catch (e) {
    if (e instanceof ApiError && isReceipt(e.body))
      next = { ...attempt, status: "receipt", receipt: e.body };
    else
      next = {
        ...attempt,
        status: "error",
        error: e instanceof ApiError ? e.message : "The server could not be reached.",
      };
  }
  // A late reply updates only the captured item's entry.
  attempts.set(k, next);
  emit();
  hub.refetch(RESOURCES.attention.path);
}

/** Clears a finished attempt so a different option can be chosen. */
export function dismissAttempt(itemKey: string): void {
  const a = attempts.get(attemptKey(itemKey));
  if (a && a.status !== "sending") {
    attempts.delete(attemptKey(itemKey));
    emit();
  }
}

/** What the receipt says in words, without claiming external work. */
export function receiptLine(r: BriefChoiceReceipt): string {
  switch (r.state) {
    case "applied":
      return r.text;
    case "pending":
    case "dispatching":
      return `Still being applied. ${r.text}`;
    case "unknown":
      return `Result unknown. ${r.text} It will not be sent again.`;
    case "stale":
      return `Not applied: the brief changed. ${r.text}`;
    default:
      return `Refused. ${r.text}`;
  }
}

export const OPERATOR_REASON_LABEL = {
  money: "Money",
  "product-direction": "Product direction",
  "security-exception": "Security exception",
  irreversible: "Not reversible",
  "floor-approval": "Floor approval",
} as const satisfies Record<BriefOperatorReason, string>;

export const RECEIPT_STATE_LABEL = {
  applied: "Done",
  pending: "In progress",
  dispatching: "In progress",
  refused: "Refused",
  stale: "Brief changed",
  unknown: "Result unknown",
} as const satisfies Record<BriefChoiceReceipt["state"], string>;
