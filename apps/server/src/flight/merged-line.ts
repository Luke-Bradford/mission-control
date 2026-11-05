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

/**
 * An external PR's merge, logged as a decision. With a linked ticket the decision carries its ref,
 * so the ticket page shows it; when FLIGHT's call covered protected paths, the operator's line
 * links that decision. Returns the decision's id.
 */
export function recordExternalMerge(
  i: {
    store: Store;
    config: CcConfig;
    log: (line: string) => void;
    record: (d: {
      kind: "merge";
      about: string;
      ref: string | null;
      decision: string;
      basis: string;
      seatId: string | null;
    }) => number;
  },
  m: {
    at: number;
    pr: number;
    repoId: string;
    text: string;
    basis: string;
    seatId: string | null;
    reasons?: readonly string[];
    ticket?: number;
  },
): number {
  const ref = m.ticket === undefined ? null : `${m.repoId}#${m.ticket}`;
  const id = i.record({
    kind: "merge",
    about: `External PR #${m.pr}`,
    ref,
    decision: m.text,
    basis: m.basis,
    seatId: m.seatId,
  });
  if (m.reasons !== undefined && m.reasons.length > 0)
    sendFlightMergedLine(i, {
      at: m.at,
      pr: m.pr,
      reasons: m.reasons,
      ticket:
        ref === null || m.ticket === undefined ? null : { ref, repoId: m.repoId, issue: m.ticket },
      decision: { id, basis: m.basis },
    });
  return id;
}
