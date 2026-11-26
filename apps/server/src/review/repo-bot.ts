import { checkState, type PullRequestView } from "@mc/core";
import type { CcConfig } from "../config.ts";

export const REPO_BOT_SEAT = "repo-bot";

export type RepoBotVerdict = "approved" | "changes" | "pending";

/** The configured bot's result on the PR's current head. */
export function repoBotVerdict(
  review: NonNullable<CcConfig["repos"][number]["review"]>,
  pr: Pick<PullRequestView, "checks" | "review">,
): RepoBotVerdict {
  const check = checkState(pr.checks ?? [], review.check);
  if (check === "failing") return "changes";
  if (check !== "passing") return "pending";
  if (review.verdict === "check") return "approved";
  if (pr.review === "changes") return "changes";
  return pr.review === "approved" ? "approved" : "pending";
}
