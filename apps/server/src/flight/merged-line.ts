import { COMMS_CAPCOM, COMMS_MC, flightMergedLine } from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import { flightSeat } from "./seat.ts";

const BASIS_MAX = 300;

/**
 * The operator's one line after FLIGHT merged a PR that needed its call: what it needed, and a
 * link to the logged reason. It carries no label, so it raises no Needs-you item. A failed send is
 * logged and never blocks the merge.
 */
export function sendFlightMergedLine(
  i: { store: Store; config: CcConfig; log: (line: string) => void },
  m: {
    at: number;
    pr: number;
    reasons: readonly string[];
    /** The ticket ref (`repo#n`) and the repo and issue it links to; null when the PR has none. */
    ticket: { ref: string; repoId: string; issue: number } | null;
    /** The logged decision that is the reason; null links FLIGHT's page with the basis instead. */
    decision: { id: number; basis: string } | null;
  },
): boolean {
  try {
    const ticketed = m.ticket !== null && m.decision !== null;
    const link =
      m.ticket !== null && m.decision !== null
        ? `/tickets/${m.ticket.repoId}/${m.ticket.issue}#decision-${m.decision.id}`
        : "/flight";
    const basis = m.decision?.basis.slice(0, BASIS_MAX) ?? "";
    const line = flightMergedLine(m.pr, m.reasons, link);
    i.store.addComms({
      at: m.at,
      from: flightSeat(i.config)?.seat.id ?? COMMS_MC,
      to: COMMS_CAPCOM,
      ticket: m.ticket?.ref ?? null,
      ref: `PR ${m.pr}`,
      text: ticketed || basis === "" ? line : `${line} ${basis}`,
    });
    return true;
  } catch (e) {
    i.log(
      `could not tell the operator of PR ${m.pr}'s merge: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
