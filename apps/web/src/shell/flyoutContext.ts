import { type Page, route, tabOf } from "../router.ts";

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
 * Where the operator is, in words: the page, and the ticket or seat open on it. The fly-out shows it
 * as a chip above the box and sends it with the message while the chip stays.
 */
export function flyoutContext(path: string, search = ""): string {
  const r = route(path, search);
  if (r === null) return PAGE_NAME.overview;
  const page = PAGE_NAME[tabOf(r)];
  if (r.page === "ticket") return `${page} · ${r.repoId}#${r.number}`;
  if (r.page === "board" && r.ticket !== null) return `${page} · ${r.repoId ?? ""}#${r.ticket}`;
  if (r.page === "agent" && r.id !== null) return `${page} · ${r.id}`;
  return page;
}

/** The text sent with a message when the chip stays: a leading line the reader can tell from the message. */
export const withContext = (context: string | null, body: string): string =>
  context === null ? body : `[Operator is on: ${context}]\n${body}`;
