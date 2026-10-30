import type { PullRequestView, QaFindingView } from "@mc/core";

export type ReadinessVerdict = { tone: "ok" | "warn" | "crit"; text: string };

const IMPORTANT = new Set(["critical", "blocker", "important"]);

export const isOpenFinding = (finding: QaFindingView): boolean => finding.resolution === null;

/** A local summary: a green PR may still be held by a recorded important review finding. */
export function prVerdict(
  pr: Pick<PullRequestView, "isDraft" | "mergeable" | "ci" | "review">,
  findings: readonly QaFindingView[],
  findingsKnown = true,
): ReadinessVerdict {
  if (!findingsKnown) return { tone: "warn", text: "Waiting on review evidence" };
  const important = findings.filter(
    (finding) => isOpenFinding(finding) && IMPORTANT.has(finding.severity.toLowerCase()),
  ).length;
  if (important > 0)
    return {
      tone: "crit",
      text: `Held: ${important} open important finding${important === 1 ? "" : "s"}`,
    };
  if (pr.mergeable === "CONFLICTING") return { tone: "crit", text: "Held: merge conflict" };
  if (pr.isDraft) return { tone: "warn", text: "Waiting on draft" };
  if (pr.ci === "failing") return { tone: "crit", text: "Held: CI failing" };
  if (pr.ci === "pending" || pr.ci === null) return { tone: "warn", text: "Waiting on CI" };
  if (pr.review === "changes") return { tone: "crit", text: "Held: review changes" };
  if (pr.review === "requested" || pr.review === null)
    return { tone: "warn", text: "Waiting on review" };
  if (pr.mergeable !== "MERGEABLE") return { tone: "warn", text: "Waiting on merge check" };
  return { tone: "ok", text: "Ready" };
}
