// @vitest-environment node

import { type AttentionItem, type LoopTry, pushChecksText, type RunLoopView } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

const RUN = "run/finished";
const START = 1_730_000_000_000;
const STEPS = ["working", "ci", "working", "ci", "review", "working", "ci", "review"] as const;
// The hub's push refusal, as a parked step records it (about 500 characters).
const REFUSAL = pushChecksText("80001f8abcdef", [{ command: "pnpm -s test", state: "missing" }]);
const tries: LoopTry[] = STEPS.map((step, index) => ({
  step,
  fix: index > 1,
  n: index + 1,
  tokens: 900 + index * 100,
  startedAt: START + index * 60_000,
  endedAt: START + (index + 1) * 60_000,
  outcome: index === STEPS.length - 1 ? "parked" : "pass",
  reason: index === STEPS.length - 1 ? REFUSAL : null,
}));
// A finished run with every section present: edges, timeline, events, tokens, caps and next.
const view: RunLoopView = {
  runId: RUN,
  loop: { phase: "review", ciFails: 1, parked: null } as RunLoopView["loop"] & object,
  events: [
    ...tries.map((try_, index) => ({
      key: `e${index}`,
      runId: RUN,
      text: try_.reason ? `parked: ${try_.reason}` : `${try_.step} finished`,
      at: try_.endedAt ?? START,
    })),
    // a long event no visit owns: one line, the whole text behind a click
    {
      key: "held",
      runId: RUN,
      text: `merge held by CAPCOM: ${"wait for the freeze to lift, ".repeat(8)}then release it`,
      at: START + 9 * 60_000,
    },
  ],
  tries,
  round: 2,
  budget: 20_000,
  review: null,
};

const ask = (key: string, text: string): AttentionItem => ({
  key,
  kind: "decision",
  agentId: "inco-1",
  repoId: null,
  text,
  tool: null,
  at: START,
  url: null,
  escalationId: null,
  ticket: null,
  owner: "operator",
  acked: false,
});

const api = {
  [RESOURCES.runLoop(RUN).path]: view,
  [RESOURCES.runs("inco-1").path]: [],
  [RESOURCES.crew.path]: { rows: [], firstRunToday: null },
  [RESOURCES.attention.path]: [
    ask("a", "Which of the two migration orders should the hub run first on the shared database?"),
    ask("b", "Merge?"),
  ],
  [RESOURCES.limits.path]: [],
};

describeRendered("Run Trace, rendered", () => {
  it.each([
    [1280, 720, "light"],
    [1280, 720, "dark"],
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
      // A parked step's refusal is one line: the full text is behind a click, and shown once.
      expect(await page.boxes(".run-checklist details:not([open])")).toHaveLength(1);
      expect(await page.unclipped(".run-checklist-note")).not.toContain(false);
      // Every disclosure's click target, in the timeline and in Run events, is at least 24px tall.
      const targets = await page.boxes(".trace-section summary");
      expect(targets.length, "timeline and event disclosures").toBeGreaterThanOrEqual(2);
      for (const target of targets) expect(target.height).toBeGreaterThanOrEqual(24);
      // The header's tabs all fit: none ends past the tabs' own box or runs under the status meters.
      const tabs = await page.box(".top .tabs");
      const status = await page.box(".top .top-status");
      for (const tab of await page.boxes(".top .tabs a")) {
        expect(tab.x + tab.width, "a tab is cut off").toBeLessThanOrEqual(
          tabs.x + tabs.width + 0.5,
        );
      }
      expect(tabs.x + tabs.width, "tabs run under the meters").toBeLessThanOrEqual(status.x + 0.5);
      // The dock's Open buttons are whole: inside their row, which is inside the Waiting block.
      const waiting = await page.box(".dwait");
      const rows = await page.boxes(".dask");
      for (const [index, button] of (await page.boxes(".dask > button")).entries()) {
        const edge = button.x + button.width;
        expect(edge, "Open is cut by its row").toBeLessThanOrEqual(
          rows[index].x + rows[index].width + 0.5,
        );
        // the block's own 12px padding stays clear of it
        expect(edge, "Open is cut by the block").toBeLessThanOrEqual(
          waiting.x + waiting.width - 11,
        );
      }
      // ...and so are their words: a button squeezed narrower than its label spills it out.
      expect(await page.unclipped(".dask > button"), "an Open label is cut").not.toContain(false);
      expect(await page.unclipped(".top .tabs"), "the tabs scroll sideways").not.toContain(false);
      // The trace uses the panel: its grid reaches the panel body's right edge to within a gutter.
      if (width >= 1600) {
        const body = await page.box(".trace-panel .pb");
        const grid = await page.box(".trace-grid");
        expect(grid.x + grid.width, "half the panel is empty").toBeGreaterThan(
          body.x + body.width - 48,
        );
      }
      if (process.env.MC_SHOT_DIR) {
        await page.screenshot(`${process.env.MC_SHOT_DIR}/trace-${width}-${scheme}.png`);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
