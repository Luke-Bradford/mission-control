import type { PullRequestView } from "@mc/core";
import { describe, expect, it } from "vitest";
import { repoBotVerdict } from "../src/review/repo-bot.ts";

const policy = {
  kind: "repo-bot" as const,
  check: "Claude Code Review",
  verdict: "comment" as const,
  actor: "claude[bot]",
};
const pr = (patch: Partial<Pick<PullRequestView, "checks" | "review" | "repoBotReview">> = {}) => ({
  review: null,
  headSha: "a".repeat(40),
  checks: [
    {
      name: "Claude Code Review",
      state: "passing" as const,
      kind: "check" as const,
      conclusion: "success",
      attempt: 1,
      url: null,
    },
  ],
  repoBotReview: null,
  ...patch,
});

describe("repoBotVerdict", () => {
  it("accepts only the configured bot's current-head approval after its workflow passed", () => {
    expect(
      repoBotVerdict(
        policy,
        pr({
          repoBotReview: {
            actor: "claude[bot]",
            sha: "a".repeat(40),
            verdict: "approved",
            findings: [],
          },
        }),
      ),
    ).toBe("approved");
    expect(repoBotVerdict(policy, pr({ review: "approved" }))).toBe("pending");
    expect(
      repoBotVerdict(
        policy,
        pr({
          repoBotReview: {
            actor: "claude[bot]",
            sha: "b".repeat(40),
            verdict: "approved",
            findings: [],
          },
        }),
      ),
    ).toBe("pending");
  });

  it("turns a bot change request or failed bot check into changes", () => {
    expect(
      repoBotVerdict(
        policy,
        pr({
          repoBotReview: {
            actor: "claude[bot]",
            sha: "a".repeat(40),
            verdict: "changes",
            findings: [
              {
                file: "apps/server/src/example.ts",
                line: 4,
                summary: "Handle the empty value.",
                scenario: "The bot found an empty request value.",
                fix: "Reject it at the boundary.",
              },
            ],
          },
        }),
      ),
    ).toBe("changes");
    expect(
      repoBotVerdict(
        { ...policy, verdict: "check", check: "review" },
        pr({
          checks: [
            {
              name: "review",
              state: "failing",
              kind: "check",
              conclusion: "failure",
              attempt: 1,
              url: null,
            },
          ],
        }),
      ),
    ).toBe("changes");
  });
});
