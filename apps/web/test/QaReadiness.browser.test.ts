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

function apiFor(count: number, failed = false) {
  return {
    "/api/repos": [{ id: "mission-control", name: "Mission Control" }],
    "/api/repos/mission-control/prs": Array.from({ length: count }, (_, index) => ({
      repoId: "mission-control",
      number: index + 1,
      title: `${LONG}${index}`,
      url: `https://github.com/Luke-Bradford/mission-control/pull/${index + 1}`,
      branch: `feature/${index + 1}`,
      ticket: `mission-control#${index + 1}`,
      state: "open",
      isDraft: false,
      review: "approved",
      ci: failed ? "failing" : "passing",
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
}

describeRendered("QA PR readiness in a browser", () => {
  it.each([
    ["empty light", 0, 1366, 1000, "light", false],
    ["long dark", 1, 1366, 1000, "dark", false],
    ["many dark", 50, 1600, 700, "dark", false],
    ["failed light", 1, 1600, 1000, "light", true],
    ["wide dark", 1, 1920, 1000, "dark", false],
  ] as const)(
    "%s fits without horizontal clipping",
    async (name, count, width, height, colorScheme, failed) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width,
        height,
        colorScheme,
        api: apiFor(count, failed),
      });
      expect(await page.unclipped("#page-qa-readiness"), name).toEqual([true]);
      if (count === 0) {
        expect(
          await page.evaluate(
            () => document.body.textContent?.includes("No open pull requests to check.") ?? false,
            null,
          ),
          name,
        ).toBe(true);
      } else {
        expect(await page.unclipped(".qa-readiness-card"), name).not.toContain(false);
      }
      await page.screenshot(
        join(SHOTS, `qa-readiness-${name.replace(" ", "-")}-${width}x${height}.png`),
      );
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
