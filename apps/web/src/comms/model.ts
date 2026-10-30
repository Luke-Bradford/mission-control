import { COMMS_TICKET, type CommsThreadMessage } from "@mc/core";
import type { CommsView } from "../router.ts";

export type { CommsView } from "../router.ts";
export type ComposerPrefill = { token: number; text: string };

export type ContactSummary = {
  id: string;
  count: number;
  latest: CommsThreadMessage;
};

export function contactSummaries(
  agentId: string,
  messages: CommsThreadMessage[],
): ContactSummary[] {
  const contacts = new Map<string, CommsThreadMessage[]>();
  for (const message of messages) {
    const id = message.from === agentId ? message.to : message.from;
    if (id === agentId) continue;
    const list = contacts.get(id) ?? [];
    list.push(message);
    contacts.set(id, list);
  }
  return [...contacts.entries()]
    .flatMap(([id, list]) => {
      const latest = list.at(-1);
      return latest ? [{ id, count: list.length, latest }] : [];
    })
    .sort((a, b) => (b.latest.at ?? 0) - (a.latest.at ?? 0));
}

export function messagesForView(
  view: CommsView,
  messages: CommsThreadMessage[],
): CommsThreadMessage[] {
  if (view.kind !== "contact") return messages;
  return messages.filter(
    (message) =>
      (message.from === view.agentId && message.to === view.contactId) ||
      (message.from === view.contactId && message.to === view.agentId),
  );
}

export function breadcrumbs(view: CommsView): string[] {
  if (view.kind === "flight") return ["Comms"];
  if (view.kind === "crew") return ["Comms", "#crew"];
  if (view.kind === "ticket") return ["Comms", view.ref];
  if (view.kind === "contact") return ["Comms", "Agents", view.agentId, view.contactId];
  return ["Comms", "Agents", view.agentId];
}

/** The ticket (`repo#n`) a `#n` reference points at, when the message's own ticket agrees; else none. */
export function ticketForRef(ref: string, ticket: string | null): string | undefined {
  if (ticket === null || !COMMS_TICKET.test(ticket)) return undefined;
  const issue = /^#(\d+)$/.exec(ref)?.[1];
  return issue === undefined || ticket.endsWith(`#${issue}`) ? ticket : undefined;
}
