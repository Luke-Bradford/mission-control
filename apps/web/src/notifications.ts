import type { AttentionBrief, CatchUpKind, PersonMessage, PillTone } from "@mc/core";
import { ApiError, apiPost } from "./api.ts";
import { ACTIONS, hub, RESOURCES } from "./data.ts";

export interface PersonThreadView {
  key: string;
  id: string;
  repoId: string;
  github: string;
  subjectType: string;
  number: number | null;
  title: string;
  reason: string;
  reasonText: string;
  author: string | null;
  snippet: string | null;
  url: string;
  updatedAt: number;
  firstSeenAt: number;
  catchUp: CatchUpKind;
  message?: PersonMessage;
  history?: PersonMessage[];
  brief?: AttentionBrief;
}

export interface HandledThreadView {
  id: string;
  repoId: string;
  number: number | null;
  title: string;
  author: string | null;
  how: string;
  at: number;
  firstSeenAt: number;
}

export interface NotificationsView {
  open: PersonThreadView[];
  handledToday: HandledThreadView[];
}

export const SOMEONE = "Someone";
export const CATCH_UP_LABEL: Record<CatchUpKind, string> = {
  new: "New",
  "follow-up": "Follow-up",
  old: "Old thread",
};

/** A catch-up pill is plain for a new thread and amber for one the operator has seen before. */
export const catchUpTone = (kind: CatchUpKind): PillTone => (kind === "new" ? "plain" : "warn");

export const whoOf = (t: { author: string | null }): string => t.author ?? SOMEONE;
export const sourceOf = (t: { message?: PersonMessage }): string =>
  t.message?.source.kind === "teams" ? "Teams" : "GitHub";
export const whereOf = (t: {
  repoId: string;
  number: number | null;
  message?: PersonMessage;
}): string =>
  t.message?.source.kind === "teams"
    ? `Teams · ${t.message.teams?.name ?? "message"}`
    : `GitHub · ${t.number === null ? t.repoId : `${t.repoId}#${t.number}`}`;
export const handledLine = (h: HandledThreadView[]): string =>
  `Handled today: ${h.map((x) => `${whoOf(x)} (${x.how})`).join(" · ")}`;

/** Marks the thread handled. Resolves to the server's refusal text to show, or null on success. */
export async function markHandled(key: string): Promise<string | null> {
  try {
    await apiPost(ACTIONS.handled(key), {});
    hub.refetch(RESOURCES.attention.path);
    hub.refetch(RESOURCES.notifications.path);
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "server unreachable";
  }
}

/** Explicit operator approval; the server revalidates the retained source before posting. */
export async function postPersonReply(key: string, replyId: string, text: string): Promise<void> {
  await apiPost(
    `/api/attention/${encodeURIComponent(key)}/replies/${encodeURIComponent(replyId)}/post`,
    { text },
  );
}

/** Keep the result in the panel before refreshing the surrounding lists. */
export function handlePerson(
  key: string,
  how: "marked" | "copied" | "flight",
  replyId?: string,
): Promise<{ handled: string; message?: string }> {
  return apiPost(ACTIONS.handled(key), { how, ...(replyId ? { replyId } : {}) });
}
