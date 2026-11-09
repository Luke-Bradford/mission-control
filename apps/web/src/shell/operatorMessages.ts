import { COMMS_CAPCOM, COMMS_CREW, type CommsMention } from "@mc/core";
import { apiPost } from "../api.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { DEMO_REFUSED, writeFailure } from "../demo/mode.ts";
import { commsAgentPath, commsCrewPath } from "../router.ts";
import { toast } from "./Toast.tsx";

/** The unseen messages that name the operator (CAPCOM): what the header's chat badge counts. */
export function useOperatorUnread(): CommsMention[] {
  const res = useResource<{ mentions: CommsMention[] }>(RESOURCES.commsMentions).data;
  return res?.mentions.filter((m) => !m.seen) ?? [];
}

/** Where a message to the operator is read: #crew, or the conversation with the other end. */
export function mentionPath(mention: CommsMention): string {
  const { from, to } = mention.message;
  if (to === COMMS_CREW) return commsCrewPath();
  return commsAgentPath(from === COMMS_CAPCOM ? to : from);
}

/** Mark messages seen, as the Comms bell does, and refresh the count. */
export async function markMentionsSeen(ids: string[]): Promise<boolean> {
  try {
    await apiPost("/api/comms/mentions/seen", { ids });
    hub.refetch(RESOURCES.commsMentions.path);
    return true;
  } catch (e) {
    const failure = writeFailure(e, "Could not mark messages read.");
    toast(failure === DEMO_REFUSED ? DEMO_REFUSED : failure);
    return false;
  }
}
