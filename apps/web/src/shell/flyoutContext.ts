import type { AttentionItem } from "@mc/core";
import { openNeedsKey } from "../flight/needsGroups.ts";
import { itemParam, type Page, route, tabOf } from "../router.ts";

/** Each page's name as the header shows it, for the context chip. */
const PAGE_NAME: Record<Page, string> = {
  overview: "Overview",
  needs: "Needs you",
  flight: "FLIGHT",
  board: "Board",
  agent: "Agents",
  map: "Map",
  comms: "Comms",
  qa: "QA",
  telemetry: "Telemetry",
  audit: "Audit",
  setup: "Setup",
};

/**
 * Where the operator is, in words: the page, and the ticket, seat or question open on it. The fly-out
 * shows it as a chip above the box and sends it with the message while the chip stays. `items` is the
 * Needs-you set, which names the ticket of an open question.
 */
export function flyoutContext(
  path: string,
  search = "",
  items: readonly AttentionItem[] = [],
): string {
  const r = route(path, search);
  if (r === null) return PAGE_NAME.overview;
  const page = PAGE_NAME[tabOf(r)];
  if (r.page === "ticket") return `${page} · ${r.repoId}#${r.number}`;
  if (r.page === "board" && r.ticket !== null) return `${page} · ${r.repoId ?? ""}#${r.ticket}`;
  if (r.page === "agent" && r.id !== null) return `${page} · ${r.id}`;
  if (r.page === "comms") {
    const v = r.view;
    if (v.kind === "agent" || v.kind === "inbox" || v.kind === "contact")
      return `${page} · ${v.agentId}`;
    if (v.kind === "ticket") return `${page} · ${v.ref}`;
  }
  // An open question or item panel: its ticket when it has one, else its key.
  // The Needs you page opens its first question when its address names none.
  const key =
    (r.page === "needs" || r.page === "comms" ? r.item : null) ??
    itemParam(search) ??
    (r.page === "needs" ? openNeedsKey(items) : null);
  if (key !== null) {
    const item = items.find((i) => i.key === key);
    return `${page} · ${item?.ticket ?? key}`;
  }
  return page;
}

/** The text sent with a message when the chip stays: a leading line the reader can tell from the message. */
export const withContext = (context: string | null, body: string): string =>
  context === null ? body : `[Operator is on: ${context}]\n${body}`;

/** A stored message without the context line `withContext` put before it. */
export const stripContext = (text: string): string =>
  text.replace(/^\[Operator is on: [^\]\n]*\]\n/, "");
