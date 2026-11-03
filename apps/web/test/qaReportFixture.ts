import { type QaReport, qaReportPermalink, REVIEW_CHECK_IDS } from "@mc/core";
import { qaAcceptanceFixture } from "./qaAcceptanceFixture.ts";

/** Browser-only raw image fixtures; report metadata stays unchanged and no DNS request escapes. */
export function qaReportAssets() {
  const image = {
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#607080"/></svg>',
  };
  return {
    "https://evidence.example/before.png": image,
    "https://evidence.example/after.png": image,
  };
}

export function qaReportFixture(): QaReport {
  const headSha = "a".repeat(40),
    id = "c".repeat(64),
    at = Date.UTC(2026, 10, 2, 12);
  const image = (side: string) => ({
    url: `https://evidence.example/${side}.png`,
    source: "controlled-fixture" as const,
    capturedAt: at,
    commitSha: side === "before" ? "b".repeat(40) : headSha,
    provenance:
      "Controlled fixture, same data and clock. Illustrative test evidence, not a live sign-off.",
  });
  return {
    schemaVersion: 1,
    id,
    repoId: "mission-control",
    github: "o/mc",
    prNumber: 1011,
    headSha,
    prTitle: "Overview keeps controls readable at desktop widths",
    prUrl: "https://github.com/o/mc/pull/1011",
    source: "controller",
    reviewer: { id: "independent-reviewer", label: "Independent reviewer" },
    reviewedAt: at,
    registeredAt: at + 1000,
    sourceRef: "https://github.com/o/mc/pull/1011#issuecomment-1",
    verdict: { spec: "pass", quality: "pass" },
    summary:
      "The controls fit at all required desktop widths. The named tests and browser checks passed.",
    worksWell: [
      "Keyboard focus reaches the controls and long titles retain their full accessible names.",
    ],
    coverage: REVIEW_CHECK_IDS.map((check) => ({
      check,
      result: check === "parameterized-sql" ? "n-a" : "pass",
      note:
        check === "parameterized-sql"
          ? "No SQL changes."
          : "Checked in this controlled report fixture.",
    })),
    findings: [],
    resolutions: [],
    tests: [
      {
        command: "pnpm exec vitest run test/OverviewCrew.test.tsx",
        origin: "hub-receipt",
        outcome: "passed",
        at,
        exitCode: 0,
        evidence: "Recorded command completion at the reviewed commit; fixture receipt.",
      },
      {
        command: "pnpm exec vitest run test/OverviewCrew.browser.test.ts",
        origin: "reviewer-reported",
        outcome: "passed",
        passed: 8,
        failed: 0,
        skipped: 0,
        evidence: "Counts reported by the reviewer; no execution receipt attached.",
      },
    ],
    ci: {
      observedAt: at,
      headSha,
      source: "github",
      checks: [
        {
          name: "web-core",
          kind: "check",
          state: "passing",
          conclusion: "SUCCESS",
          attempt: 1,
          url: "https://github.com/o/mc/actions/runs/1",
        },
      ],
    },
    limitations: [
      "This fixture confirms the reader layout. It does not establish production deployment approval.",
    ],
    followUps: [
      {
        text: "Retain the minor visible-history suggestion in the existing debt ticket.",
        disposition: "ticket",
        ticket: "https://github.com/o/mc/issues/656",
        basis: "No new ticket is needed.",
      },
    ],
    visual: {
      applicability: "required",
      reason:
        "A visible layout change needs paired renders. These fixture captures show the same data and clock.",
      pairs: [
        { label: "Overview · 1600×1000 · light", before: image("before"), after: image("after") },
      ],
    },
    completeness: { state: "complete", missing: [] },
    permalink: `/qa?repo=mission-control&pr=1011&report=${id}`,
  };
}

export function qaReportApi(count = 3) {
  const r = qaReportFixture();
  return {
    ...qaAcceptanceFixture(count),
    [`/api/qa-reports?repoId=mission-control&prNumber=1011&headSha=${r.headSha}`]: { reports: [r] },
    "/api/qa-reports?repoId=mission-control&prNumber=1011": { reports: [r] },
    [`/api/qa-reports/${r.id}`]: r,
  };
}

/** A report for the shared ticket fixture, with matching PR and repository provenance. */
export function ticketQaReportFixture(): QaReport {
  const r = qaReportFixture();
  return {
    ...r,
    repoId: "shop-app",
    github: "octo-org/shop-app",
    prNumber: 40,
    prUrl: "https://github.com/octo-org/shop-app/pull/40",
    permalink: qaReportPermalink("shop-app", 40, r.id),
  };
}
