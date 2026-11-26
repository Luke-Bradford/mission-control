import { checkState, type PullRequestView } from "@mc/core";
import type { CcConfig } from "../config.ts";

export const REPO_BOT_SEAT = "repo-bot";

export type RepoBotVerdict = "approved" | "changes" | "pending";

/** The configured bot's result on the PR's current head. */
export function repoBotVerdict(
  review: NonNullable<CcConfig["repos"][number]["review"]>,
  pr: Pick<PullRequestView, "checks" | "headSha" | "repoBotReview">,
): RepoBotVerdict {
  const check = checkState(pr.checks ?? [], review.check);
  if (check === "failing") return "changes";
  if (check !== "passing") return "pending";
  if (review.verdict === "check") return "approved";
  const bot = pr.repoBotReview;
  if (bot?.actor !== review.actor || bot.sha !== pr.headSha) return "pending";
  return bot.verdict;
}
