// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const audit = {
  range: { since: 0, until: 1 },
  longRunners: [],
  deathLoops: [],
  reworkRounds: [],
  refusalsByRule: [],
  refusals: [],
  refusalSpikes: [],
  spendOutliers: [],
  costPerMergedTicket: [],
  prSizes: {
    prs: [
      {
        repoId: "large-repo",
        number: 1,
        ticket: "large-repo#1",
        mergedAt: 0,
        additions: 665_702,
        deletions: 0,
        changedFiles: 1,
      },
      {
        repoId: "small-repo",
        number: 2,
        ticket: "small-repo#2",
        mergedAt: 0,
        additions: 2_833,
        deletions: 0,
        changedFiles: 1,
      },
    ],
    outliers: [],
  },
  modelPromptTimeline: [],
  questions: { asked: 0, answered: 0, answerMs: null },
  chatter: [],
  flakes: [],
  changes: [],
  surgeonProposals: [],
};

const api = {
  "/api/audit?range=30d": audit,
  "/api/config": { loops: [], crew: { sessions: [] } },
};

const { renderAt } = browserSession();

describeRendered("Audit PR bars in a browser", () => {
  it(
    "uses the production stylesheet's logarithmic fill widths",
    async () => {
      const page = await renderAt({ page: "test/auditBarBrowser.html", width: 1280, api });
      const fills = await page.boxes(".audit-bar");
      const tracks = await page.boxes(".audit-bar-track");
      const [largestFill, smallerFill] = fills;
      const [largestTrack, smallerTrack] = tracks;

      expect(largestFill.width / largestTrack.width).toBeCloseTo(1, 3);
      expect(smallerFill.width / smallerTrack.width).toBeCloseTo(
        Math.log1p(2_833) / Math.log1p(665_702),
        3,
      );
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
