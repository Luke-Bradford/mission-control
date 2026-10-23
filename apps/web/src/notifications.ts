import { ApiError, apiPost } from "./api.ts";
import { ACTIONS, hub, RESOURCES } from "./data.ts";

export type CatchUpKind = "new" | "follow-up" | "old";

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

export const whoOf = (t: { author: string | null }): string => t.author ?? SOMEONE;
export const whereOf = (t: { repoId: string; number: number | null }): string =>
  `GitHub · ${t.number === null ? t.repoId : `${t.repoId}#${t.number}`}`;
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
