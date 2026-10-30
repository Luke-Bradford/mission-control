// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const SHOTS = join(process.env.TMPDIR ?? "/tmp", "qa-readiness-shots");
const { renderAt } = browserSession();
const LONG =
  "A long pull request title that makes sure the readiness card retains every piece of evidence without clipping the operator's view. ".repeat(
    3,
  );

const api = {
  "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
  "/api/repos/mission-control/prs": Array.from({ length: 4 }, (_, index) => ({
    repoId: "mission-control",
    number: index + 1,
    title: `${LONG}${index}`,
    url: `https://github.com/Luke-Bradford/mission-control/pull/${index + 1}`,
    branch: `feature/${index + 1}`,
    ticket: `mission-control#${index + 1}`,
    state: "open",
    isDraft: false,
    review: "approved",
    ci: "passing",
    createdAt: 0,
    updatedAt: 0,
    mergedAt: null,
    headSha: `head-${index}`,
    mergeable: "MERGEABLE",
    additions: 100,
    deletions: 20,
    changedFiles: 4,
  })),
  "/api/qa/ci-runs?days=90": { runs: [] },
  "/api/qa/findings?days=90": { findings: [] },
};

describeRendered("QA PR readiness in a browser", () => {
  it.each([1366, 1600, 1920])(
    "fits %ipx without horizontal clipping",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width,
        height: 1000,
        api,
      });
      expect(await page.unclipped("#page-qa-readiness")).toEqual([true]);
      expect(await page.unclipped(".qa-readiness-card")).not.toContain(false);
      await page.screenshot(join(SHOTS, `qa-readiness-${width}x1000.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
