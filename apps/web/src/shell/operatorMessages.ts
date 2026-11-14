import { COMMS_CAPCOM, COMMS_CREW, type CommsMention } from "@mc/core";
import { useMemo } from "react";
import { apiPost } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { DEMO_REFUSED, writeFailure } from "../demo/mode.ts";
import { commsAgentPath, commsCrewPath } from "../router.ts";
import { store, useStore } from "./store.ts";
import { toast } from "./Toast.tsx";

/**
 * Messages marked read here that the hub's list may not show as seen yet. Every view reads
 * mentions through `useMentions`, so one mark lowers every count at once and none shows a
 * different number while the list refreshes.
 */
const markedSeen = store<ReadonlySet<string>>(new Set());

/** Forget what this tab marked read; for tests. */
export const resetMarkedSeen = (): void => markedSeen.set(new Set());

/** Every message that names the operator, `seen` true for one read in any view. */
export function useMentions(): CommsMention[] {
  const res = useResource<{ mentions: CommsMention[] }>(RESOURCES.commsMentions).data;
  const marked = useStore(markedSeen);
  return useMemo(
    () =>
      (res?.mentions ?? []).map((m) =>
        m.seen || !marked.has(m.message.id) ? m : { ...m, seen: true },
      ),
    [res, marked],
  );
}

/** The unseen messages that name the operator (CAPCOM): what the header's chat badge counts. */
export function useOperatorUnread(): CommsMention[] {
  const mentions = useMentions();
  return useMemo(() => mentions.filter((m) => !m.seen), [mentions]);
}

/** Where a message to the operator is read: #crew, or the conversation with the other end. */
export function mentionPath(mention: CommsMention): string {
  const { from, to } = mention.message;
  if (to === COMMS_CREW) return commsCrewPath();
  return commsAgentPath(from === COMMS_CAPCOM ? to : from);
}

/** Note that the hub took these as read: every view's count drops, then the list refreshes. */
export function recordMentionsSeen(ids: string[]): void {
  markedSeen.set(new Set([...markedSeen.get(), ...ids]));
  hub.refetch(RESOURCES.commsMentions.path);
}

/** Mark messages seen, as the Comms bell does, and refresh the count. */
export async function markMentionsSeen(ids: string[]): Promise<boolean> {
  try {
    await apiPost("/api/comms/mentions/seen", { ids });
    recordMentionsSeen(ids);
    return true;
  } catch (e) {
    const failure = writeFailure(e, "Could not mark messages read.");
    toast(failure === DEMO_REFUSED ? DEMO_REFUSED : failure);
    return false;
  }
}
