import type { PullRequestView } from "@mc/core";
import { describe, expect, it } from "vitest";
import { prVerdict } from "../src/qa/readiness.ts";

const pr = (overrides: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "mission-control",
  number: 987,
  title: "PR readiness",
  url: "https://github.com/Luke-Bradford/mission-control/pull/987",
  branch: "feature/987",
  ticket: "mission-control#987",
  state: "open",
  isDraft: false,
  review: "approved",
  ci: "passing",
  createdAt: 0,
  updatedAt: 0,
  mergedAt: null,
  headSha: "head-a",
  mergeable: "MERGEABLE",
  ...overrides,
});

describe("prVerdict", () => {
  it("calls an approved, green, mergeable PR ready", () => {
    expect(prVerdict(pr(), [])).toEqual({ tone: "ok", text: "Ready" });
  });

  it("waits for a named missing check", () => {
    expect(prVerdict(pr({ ci: "pending" }), [])).toEqual({
      tone: "warn",
      text: "Waiting on CI",
    });
  });

  it("waits while review findings are unavailable and when mergeability is unknown", () => {
    expect(prVerdict(pr(), [], false)).toEqual({
      tone: "warn",
      text: "Waiting on review evidence",
    });
    expect(prVerdict(pr({ mergeable: null }), [])).toEqual({
      tone: "warn",
      text: "Waiting on merge check",
    });
  });

  it("holds a PR with an unresolved important finding", () => {
    expect(
      prVerdict(pr(), [
        {
          reviewId: 1,
          authorRunId: "retro-cx/run",
          repoId: "mission-control",
          prNumber: 987,
          round: 1,
          reviewEndedAt: 0,
          pos: 0,
          severity: "Important",
          category: "correctness",
          file: "apps/web/src/App.tsx",
          line: 1,
          summary: "Missing guard",
          resolution: null,
          resolvedReviewId: null,
        },
      ]),
    ).toEqual({ tone: "crit", text: "Held: 1 open important finding" });
  });
});
