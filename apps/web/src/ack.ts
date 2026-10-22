import { ACK_BATCH_MAX } from "@mc/core";
import { ApiError, apiPost } from "./api.ts";
import { ACTIONS, hub, RESOURCES } from "./data.ts";

/**
 * Acknowledge attention items, `ACK_BATCH_MAX` keys per request (the route's limit), then refetch
 * the list. Resolves to an error message to show, or null when every batch went through.
 */
export async function ackKeys(keys: string[]): Promise<string | null> {
  try {
    for (let i = 0; i < keys.length; i += ACK_BATCH_MAX) {
      await apiPost(ACTIONS.ack, { keys: keys.slice(i, i + ACK_BATCH_MAX) });
    }
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : "server unreachable";
  } finally {
    hub.refetch(RESOURCES.attention.path);
    hub.refetch(RESOURCES.guardHits.path);
  }
}
