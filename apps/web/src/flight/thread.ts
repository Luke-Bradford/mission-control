import { COMMS_CAPCOM, type CommsMessage } from "@mc/core";
import { useMemo } from "react";
import { type CommsPage, useOlderMessages } from "../comms/older.ts";
import { hub, RESOURCES, useResource } from "../data.ts";
import { stripContext } from "../shell/flyoutContext.ts";
import type { DockRow } from "./conversation.ts";

const NO_MESSAGES: CommsMessage[] = [];

/** A stored message as a row of the conversation: the operator's, or FLIGHT's. */
export const threadRow = (m: CommsMessage): DockRow =>
  m.from === COMMS_CAPCOM
    ? { kind: "you", id: `c:${m.id}`, at: m.at, text: stripContext(m.text) }
    : { kind: "flight", id: `c:${m.id}`, at: m.at, text: m.text };

/**
 * The FLIGHT conversation Comms and the fly-out share: one read (`/api/comms/flight`, the stored
 * messages between the operator and FLIGHT), paged the same way. Both show these messages in this
 * order; the hub's own addition (the context line the fly-out sends) is left off the text in both.
 */
export function useFlightThread() {
  const res = useResource<CommsPage>(RESOURCES.commsFlight);
  const live = res.data?.messages ?? NO_MESSAGES;
  const older = useOlderMessages(
    res.data ? RESOURCES.commsFlight.path : null,
    live,
    res.data?.hasMore ?? false,
    "messages",
  );
  const rows = useMemo(() => older.messages.map(threadRow), [older.messages]);
  const status: "loading" | "error" | "ready" = res.data
    ? "ready"
    : res.error
      ? "error"
      : "loading";
  return {
    rows,
    messages: older.messages,
    older,
    status,
    retry: () => hub.refetch(RESOURCES.commsFlight.path),
  };
}
