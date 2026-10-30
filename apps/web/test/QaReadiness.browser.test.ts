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
    "/api/crew": { rows: [] },
    "/api/repos/mission-control/map": impactMap(),
  };
}

/** One seat holds feature/1 and changed util.ts, which main.ts imports. */
function impactMap() {
  const seat = {
    seat: "GUIDO-1",
    state: "running",
    since: 0,
    ticket: 1,
    title: "A change",
    branches: ["feature/1"],
    area: [],
    changedOn: ["feature/1"],
    nowTicket: null,
    tickets: { "feature/1": 1 },
    calls: [],
    scope: { read: [], modified: [{ file: "src/util.ts", add: 3, rem: 0, source: "diff" }] },
    recent: [],
    context: { total: 0, window: 64000 },
    badges: { questions: [], failures: [], review: null, tests: null, ci: null, waiting: null },
  };
  return {
    repoId: "mission-control",
    tree: [
      { path: "src/main.ts", lines: 60 },
      { path: "src/util.ts", lines: 20 },
      { path: "test/main.test.ts", lines: 20 },
    ],
    imports: [
      { from: "src/main.ts", to: "src/util.ts" },
      { from: "test/main.test.ts", to: "src/main.ts" },
    ],
    hist: { since: 0, prCount: 0, fixCount: 0, files: {}, coupling: [] },
    seats: [seat],
    findings: [],
    conflicts: [],
    conflictsUnchecked: [],
    rules: { areas: {}, hardRules: [] },
    seq: 0,
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

  it.each([1366, 1600, 1920] as const)(
    "keeps the card unclipped with Impact open at %i",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/qaReadinessBrowser.html",
        width,
        height: 1000,
        colorScheme: "dark",
        api: apiFor(1),
      });
      await page.boxes(".qa-readiness-card");
      await page.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent?.trim() === "Show impact")
          ?.click();
      }, null);
      await page.boxes(".qa-impact .map-lens");
      expect(await page.unclipped("#page-qa-readiness"), String(width)).toEqual([true]);
      expect(await page.unclipped(".qa-readiness-card"), String(width)).not.toContain(false);
      expect(await page.unclipped(".qa-impact .map-lens"), String(width)).not.toContain(false);
      // the Impact section takes the card's full width
      const [card, impact] = await Promise.all([
        page.box(".qa-evidence"),
        page.box(".qa-evidence-impact"),
      ]);
      expect(Math.abs(impact.width - card.width)).toBeLessThan(2);
      await page.screenshot(join(SHOTS, `qa-readiness-impact-${width}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
