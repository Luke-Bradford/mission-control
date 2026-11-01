// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const SHOTS = join(process.env.TMPDIR ?? "/tmp", "qa-acceptance-shots");
const { renderAt } = browserSession();
const SHA = "a".repeat(40),
  NOW = Date.now();
const LONG =
  "Overview crew table: one line per cell, with controls kept inside their row and long text retained for the operator";
function fixture(count = 3) {
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
    "/api/qa/queue": { prs, flightId: "flight-1" },
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
describeRendered("QA acceptance queue in a browser", () => {
  it.each(
    [1366, 1600, 1920].flatMap((width) =>
      ["light", "dark"].map((theme) => ({ width, theme: theme as "light" | "dark" })),
    ),
  )(
    "fits the approved layout at $width in $theme",
    async ({ width, theme }) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width,
        height: 1000,
        colorScheme: theme,
        api: fixture(),
      });
      await page.boxes(".uat-pair");
      // Fixture artwork stands in for the captured page. Production images come from the PNG route.
      await page.evaluate(() => {
        for (const image of document.querySelectorAll<HTMLImageElement>(".uat-shots img")) {
          const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#131a23"/><rect x="40" y="40" width="900" height="40" fill="#2a3646"/><rect x="40" y="130" width="460" height="800" fill="#0c1117"/><rect x="540" y="130" width="460" height="800" fill="#0c1117"/><rect x="1040" y="130" width="460" height="800" fill="#174f48"/></svg>';
          image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        }
      }, null);
      expect(await page.unclipped("#page-qa-readiness")).toEqual([true]);
      expect(await page.unclipped(".uat-detail .panel")).not.toContain(false);
      expect(await page.reachable(".uat-ask")).toEqual([true]);
      const columns = await page.evaluate(() => {
        const queue = document.querySelector(".uat-queue")?.getBoundingClientRect();
        const detail = document.querySelector(".uat-detail")?.getBoundingClientRect();
        return queue && detail ? queue.right < detail.left : false;
      }, null);
      expect(columns).toBe(true);
      await page.screenshot(join(SHOTS, `qa-uat-${width}-${theme}.png`));
      await page.click(".uat-actions .uat-send");
      expect(await page.unclipped(".uat-send-form")).toEqual([true]);
      await page.screenshot(join(SHOTS, `qa-uat-send-back-${width}-${theme}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "shows an honest empty queue",
    async () => {
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width: 1366,
        colorScheme: "light",
        api: fixture(0),
      });
      await page.boxes(".uat-empty");
      expect(
        await page.evaluate(
          () => document.body.textContent?.includes("Nothing is waiting for you"),
          null,
        ),
      ).toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
