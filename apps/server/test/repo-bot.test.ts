import { describe, expect, it } from "vitest";
import type { PullRequestView } from "@mc/core";
import { repoBotVerdict } from "../src/review/repo-bot.ts";

const policy = {
  kind: "repo-bot" as const,
  check: "Claude Code Review",
  verdict: "comment" as const,
};
const pr = (patch: Partial<Pick<PullRequestView, "checks" | "review">> = {}) => ({
  review: null,
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
  ...patch,
});

describe("repoBotVerdict", () => {
  it("accepts an approved bot comment only after its workflow passed", () => {
    expect(repoBotVerdict(policy, pr({ review: "approved" }))).toBe("approved");
    expect(repoBotVerdict(policy, pr({ review: "approved", checks: [] }))).toBe("pending");
  });

  it("turns a bot change request or failed bot check into changes", () => {
    expect(repoBotVerdict(policy, pr({ review: "changes" }))).toBe("changes");
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
