// @vitest-environment node

import type { LoopTry, RunLoopView } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

const RUN = "run/finished";
const START = 1_730_000_000_000;
const STEPS = ["working", "ci", "working", "ci", "review", "working", "ci", "review"] as const;
const tries: LoopTry[] = STEPS.map((step, index) => ({
  step,
  fix: index > 1,
  n: index + 1,
  tokens: 900 + index * 100,
  startedAt: START + index * 60_000,
  endedAt: START + (index + 1) * 60_000,
  outcome: "pass",
  reason: null,
}));
// A finished run with every section present: edges, timeline, events, tokens, caps and next.
const view: RunLoopView = {
  runId: RUN,
  loop: { phase: "review", ciFails: 1, parked: null } as RunLoopView["loop"] & object,
  events: tries.map((try_, index) => ({
    key: `e${index}`,
    runId: RUN,
    text: `${try_.step} finished`,
    at: try_.endedAt ?? START,
  })),
  tries,
  round: 2,
  budget: 20_000,
  review: null,
};

const api = {
  [RESOURCES.runLoop(RUN).path]: view,
  [RESOURCES.runs("inco-1").path]: [],
  [RESOURCES.crew.path]: { rows: [], firstRunToday: null },
  [RESOURCES.attention.path]: [],
  [RESOURCES.limits.path]: [],
};

describeRendered("Run Trace, rendered", () => {
  it.each([
    [1366, 768, "light"],
    [1366, 768, "dark"],
    [1600, 1000, "light"],
    [1600, 1000, "dark"],
    [1920, 1080, "light"],
    [1920, 1080, "dark"],
  ] as const)(
    "shows every section whole at %ix%i, %s",
    async (width, height, scheme) => {
      const page = await renderAt({
        page: "test/traceBrowser.html",
        search: `?trace=${encodeURIComponent(RUN)}`,
        width,
        height,
        colorScheme: scheme,
        api,
      });
      const sections = await page.boxes(".trace-section");
      expect(sections.length).toBeGreaterThanOrEqual(5);
      for (const [index, section] of sections.entries()) {
        expect(section.height, `section ${index} is not collapsed`).toBeGreaterThan(20);
      }
      // Sections are as tall as their content, not stretched to the column or the window.
      expect(await page.hugsContent(".trace-section")).not.toContain(false);
      // Every section's bottom edge is inside the Run Trace panel or a scroller within it.
      expect(await page.reachable(".trace-section", ".panel")).not.toContain(false);
      if (process.env.MC_SHOT_DIR) {
        await page.screenshot(`${process.env.MC_SHOT_DIR}/trace-${width}-${scheme}.png`);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
