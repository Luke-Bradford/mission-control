import type { FlightPrFlowRow, FlightPrFlowView, ReviewCheckState } from "@mc/core";
import { type ReviewStateProps, reviewStateProps } from "../hud/ReviewState.tsx";

/** The PR-flow rows by `repo#pr`, so a card finds its PR's stage and owner. */
export function flowByPr(view: FlightPrFlowView | undefined): ReadonlyMap<string, FlightPrFlowRow> {
  const m = new Map<string, FlightPrFlowRow>();
  for (const repo of view?.repos ?? [])
    for (const row of repo.rows) m.set(flowKey(repo.repoId, row.pr), row);
  return m;
}

export const flowKey = (repoId: string, pr: number): string => `${repoId}#${pr}`;

/** The flow's owner when it names the operator or FLIGHT; an ended run has none, so the review state's. */
function clearanceOwner(check: ReviewCheckState, row: FlightPrFlowRow): string {
  if (row.ownerKind === "operator" || row.ownerKind === "FLIGHT") return row.ownerKind;
  if (check.kind !== "held") return "FLIGHT";
  return check.by === "CAPCOM" || check.by === "operator" ? "operator" : check.by;
}

/**
 * The Board chip for a reviewed PR. Whether it can merge, and who moves it, is the PR flow's
 * stage and owner (the FLIGHT page's), not the review row's guess: "Ready to merge" only when the
 * flow's next step is the merge, and "Held · operator" only when the operator holds it. Without a
 * flow row (not loaded, or PR not in it) the review state stands.
 */
export function flowChip(
  check: ReviewCheckState,
  row: FlightPrFlowRow | undefined,
): ReviewStateProps {
  const own = reviewStateProps(check);
  if (row === undefined || (check.kind !== "ready" && check.kind !== "held")) return own;
  const reason = check.kind === "held" ? check.reason : undefined;
  switch (row.stage) {
    case "merge":
      return own;
    case "controller check":
      return { label: "Held · controller check", tone: "warn", reason };
    case "clearance":
      return {
        label: `Held · ${clearanceOwner(check, row)}`,
        tone: "warn",
        reason,
      };
    case "sync":
      return { label: "Held · sync", tone: "warn", reason };
    case "CI":
      return { label: "Waiting for CI", tone: "plain", reason };
    case "review":
      return { label: "Waiting for review", tone: "plain", reason };
    case "rework":
      return { label: "Findings sent · developer fixing", tone: "crit", reason };
    case "building":
      return { label: "Developer building", tone: "plain", reason };
  }
}
