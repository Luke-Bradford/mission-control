import { ORDER_ANCHOR_PREFIX } from "../instructions/links.ts";
import { DECISION_ANCHOR_PREFIX } from "./conversation.ts";

/** The retained FLIGHT panels, addressed by their original fragment identifiers. */
const RECORD_PANEL: Readonly<Record<string, string>> = {
  handlingP: "handlingP",
  heldP: "heldP",
  waitingP: "waitingP",
  draftsP: "draftsP",
  decidedP: "decidedP",
  outcomesP: "outcomesP",
  powersP: "powersP",
  incP: "incP",
  logP: "logP",
  wifP: "wifP",
  ledgerP: "ledgerP",
  watchP: "watchP",
  ordersP: "ordersP",
  instructionsP: "instructionsP",
  memoryP: "memoryP",
  briefP: "briefP",
};

/** The record panel a former FLIGHT fragment opens, if it names one. */
export function recordPanelForHash(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (id.startsWith(ORDER_ANCHOR_PREFIX)) return "ordersP";
  if (id.startsWith("flight-note-")) return "briefP";
  if (id.startsWith("draft-")) return "draftsP";
  if (id.startsWith(DECISION_ANCHOR_PREFIX)) return "decidedP";
  return RECORD_PANEL[id] ?? null;
}

/** True when a fragment belongs in FLIGHT's secondary Records view. */
export function isFlightRecordHash(hash: string): boolean {
  return recordPanelForHash(hash) !== null;
}
