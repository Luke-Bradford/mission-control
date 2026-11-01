const SHA = "a".repeat(40),
  NOW = Date.now();
const LONG =
  "Overview crew table: one line per cell, with controls kept inside their row and long text retained for the operator";
export function qaAcceptanceFixture(count = 3) {
  const prs = Array.from({ length: count }, (_, i) => ({
    repoId: "mission-control",
    number: 1011 + i,
    title: i ? `PR ${1011 + i}: ${LONG}` : LONG,
    url: `https://github.com/o/mc/pull/${1011 + i}`,
    branch: `feature/${1011 + i}-overview-crew-table`,
    ticket: `mission-control#${1011 + i}`,
    state: "open",
    isDraft: false,
    review: "approved",
    ci: "passing",
    createdAt: NOW - (i + 5) * 3600000,
    updatedAt: NOW,
    mergedAt: null,
    headSha: SHA,
    mergeable: "MERGEABLE",
    uat: { sha: SHA, since: NOW - (51 - i * 12) * 3600000 },
  }));
  return {
    "/api/qa/queue": {
      prs: [
        ...prs,
        ...(count
          ? Array.from({ length: 4 }, (_, i) => ({
              ...prs[0],
              number: 1062 + i,
              title: [
                "Telemetry: cost per ticket needs a window label",
                "Core: lease expiry writes an audit row",
                "Comms: unread count on the tab",
                "Audit: filter by ticket",
              ][i],
              uat: undefined,
              ci: "pending",
            }))
          : []),
      ],
      flightId: "flight-1",
    },
    [`/api/qa/uat/mission-control/1011?head=${SHA}`]: {
      repoId: "mission-control",
      number: 1011,
      sha: SHA,
      qaSummary:
        "The crew table now keeps every cell on one line. Controls stay inside the row at 1366 and 1600 wide. Long titles truncate and retain their full accessible name.",
      files: ["apps/web/src/pages/Overview.tsx", "apps/web/src/overview/crew.css"],
      tests: [
        {
          command: "pnpm test OverviewCrew",
          file: "test/OverviewCrew.test.tsx",
          passed: 14,
          failed: 0,
          skipped: 0,
          duration: 200,
        },
        {
          command: "pnpm test Browser",
          file: "test/OverviewCrew.browser.test.ts",
          passed: 8,
          failed: 0,
          skipped: 0,
          duration: 100,
        },
      ],
      testsAdded: [{ file: "test/OverviewCrew.test.tsx", failedOnBase: true }],
      rounds: [
        {
          round: 1,
          reviewId: 1,
          at: NOW - 7200000,
          sha: "b".repeat(40),
          blocking: [
            {
              severity: "Important",
              file: "Overview.tsx",
              line: 3,
              summary: "Interrupt overlaps Answer at 1366 wide.",
            },
          ],
          reply: {
            at: NOW - 7000000,
            from: "GUIDO-1",
            text: "Moved the controls into a bounded action column.",
          },
          fixSha: SHA,
          result: "resolved",
        },
        {
          round: 2,
          reviewId: 2,
          at: NOW - 3600000,
          sha: SHA,
          blocking: [],
          reply: null,
          fixSha: null,
          result: "clean",
        },
      ],
      comms: [
        {
          id: "comms:2",
          at: NOW - 600000,
          from: "flight-1",
          to: "CAPCOM",
          text: "The narrow view and both themes passed QA.",
          label: null,
        },
        {
          id: "comms:1",
          at: NOW - 900000,
          from: "CAPCOM",
          to: "flight-1",
          text: "Were both themes checked?",
          label: "question",
        },
      ],
      tryIt: {
        branch: "feature/1011-overview-crew-table",
        commands: [
          "git fetch origin feature/1011-overview-crew-table && git switch feature/1011-overview-crew-table",
          "pnpm dev",
        ],
        previewUrl: "http://127.0.0.1:7431",
      },
      uat: { waiting: true, since: NOW - 51 * 3600000, note: null },
    },
    [`/api/repos/mission-control/prs/1011?head=${SHA}`]: {
      ...prs[0],
      additions: 186,
      deletions: 42,
      changedFiles: 5,
      checks: [
        { name: "lint", kind: "check", state: "passing" },
        { name: "test", kind: "check", state: "passing" },
      ],
    },
    [`/api/prs/1011/evidence?repo=mission-control&sha=${SHA}`]: {
      repoId: "mission-control",
      pr: 1011,
      sha: SHA,
      mainSha: "b".repeat(40),
      capturedAt: NOW,
      pairs: [
        {
          page: "overview",
          scheme: "dark",
          changedPixels: 100,
          changedPercent: 1.2,
          regions: [{ x: 1, y: 2, width: 30, height: 40 }],
        },
      ],
    },
  };
}
