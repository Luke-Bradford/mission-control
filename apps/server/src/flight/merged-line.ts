import { touchesReason } from "@mc/core";

/**
 * An external PR's merge, logged as a decision on the FLIGHT page. A linked ticket gives the
 * decision its ref, so the ticket page shows it too; when FLIGHT's call covered protected paths,
 * the decision names them. Returns the decision's id.
 */
export function recordExternalMerge(
  i: {
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
    pr: number;
    repoId: string;
    text: string;
    basis: string;
    seatId: string | null;
    /** The protected paths this merge changed; empty when FLIGHT's call was not needed. */
    paths?: readonly string[];
    ticket?: number;
  },
): number {
  return i.record({
    kind: "merge",
    about: `External PR #${m.pr}`,
    ref: m.ticket === undefined ? null : `${m.repoId}#${m.ticket}`,
    decision:
      m.paths !== undefined && m.paths.length > 0
        ? `${m.text} FLIGHT's call covered it: ${touchesReason(m.paths)}.`
        : m.text,
    basis: m.basis,
    seatId: m.seatId,
  });
}
