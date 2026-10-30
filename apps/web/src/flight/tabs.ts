import { NEEDS_YOU_PANEL } from "../router.ts";

/** The FLIGHT page's tabs, each named for the question the operator brings to it. */
export const FLIGHT_TABS = ["needs", "did", "crew", "knows"] as const;
export type FlightTab = (typeof FLIGHT_TABS)[number];

export const TAB_LABEL: Record<FlightTab, string> = {
  needs: "Needs you",
  did: "What FLIGHT did",
  crew: "Crew & board",
  knows: "What FLIGHT knows",
};

/** Panels a link may name, by the tab that holds them; a working-context or draft row by prefix. */
const HASH_TAB: Readonly<Record<string, FlightTab>> = {
  [NEEDS_YOU_PANEL]: "needs",
  defaultsP: "needs",
  handlingP: "needs",
  heldP: "needs",
  waitingP: "needs",
  draftsP: "needs",
  decidedP: "did",
  outcomesP: "did",
  powersP: "did",
  incP: "did",
  logP: "did",
  wifP: "crew",
  ledgerP: "crew",
  watchP: "crew",
  ordersP: "knows",
  instructionsP: "knows",
  memoryP: "knows",
  briefP: "knows",
};

/** The tab a `#fragment` link opens: the one holding it, else Needs you. */
export function tabForHash(hash: string): FlightTab {
  const id = hash.replace(/^#/, "");
  if (id.startsWith("flight-note-")) return "knows";
  if (id.startsWith("draft-")) return "needs";
  return HASH_TAB[id] ?? "needs";
}
