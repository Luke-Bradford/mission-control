// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { populatedAgentView } from "./agentV2Fixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const view = populatedAgentView();
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": { rows: [view.row], firstRunToday: null },
  "/api/agents/guido-1": view,
  "/api/attention": [],
  "/api/agents/guido-1/stream?limit=20": {
    runId: view.row.run?.id,
    events: [
      { id: "1:0", at: NOW, kind: "op", text: "Build the Agent page." },
      { id: "2:0", at: NOW, kind: "sys", text: "Context compacted" },
    ],
    tasks: [],
    truncated: false,
    more: false,
  },
  "/api/comms/agents/guido-1": { messages: [] },
  "/api/runs/r-12/loop": {
    loop: {
      phase: "parked",
      parked: { kind: "review", reason: "Keyboard check remains", ended: false },
    },
  },
};

describeRendered("Agent page v2", () => {
  it.each([
    { width: 1280, height: 1000 },
    { width: 1600, height: 1000 },
    { width: 1920, height: 1000 },
    { width: 1600, height: 700 },
  ])(
    "fits $width × $height in both themes",
    async ({ width, height }) => {
      for (const theme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/agentV2Browser.html",
          width,
          height,
          colorScheme: theme,
          api,
        });
        await page.box(".agent-v2-steps");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1, null),
        ).toBe(true);
        expect(
          await page.unclipped(
            ".agent-v2-stat, .agent-v2-identity, .agent-v2-next, .agent-v2-columns",
          ),
        ).not.toContain(false);
        expect(
          await page.reachable(
            ".agent-v2-deliverables a, #sideP button, #streamP input, .agent-v2-actions button, .agent-v2-actions summary",
          ),
        ).not.toContain(false);
        const summary = await page.evaluate(
          () => ({
            stats: document.querySelectorAll(".agent-v2-stat").length,
            steps: document.querySelectorAll(".agent-v2-steps li").length,
            next: document.querySelector(".agent-v2-next")?.textContent,
            top: document.querySelector(".agent-v2-steps")?.getBoundingClientRect().top ?? 1000,
          }),
          null,
        );
        expect(summary.stats).toBe(5);
        expect(summary.steps).toBe(6);
        expect(summary.next).toContain("For the controller");
        expect(summary.top).toBeLessThan(height);
        const shots = process.env.MC_AGENT_V2_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(join(shots, `agent-${width}-${height}-${theme}.png`));
        }
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps 50 long deliverables in a visible scroller",
    async () => {
      const many = {
        ...view,
        deliverables: Array.from({ length: 50 }, (_, i) => ({
          id: `file:${i}`,
          kind: "file",
          label: `apps/web/very-long-path/${"nested/".repeat(12)}file-${i}.tsx`,
          href: `/agent/guido-1?side=files&path=${i}`,
        })),
      };
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1280,
        height: 700,
        api: { ...api, "/api/agents/guido-1": many },
      });
      await page.box(".agent-v2-deliverables li");
      expect((await page.boxes(".agent-v2-deliverables li")).length).toBe(50);
      expect(
        await page.evaluate(() => {
          const e = document.querySelector(".agent-v2-deliverables") as HTMLElement;
          return e.scrollHeight > e.clientHeight && getComputedStyle(e).overflowY === "auto";
        }, null),
      ).toBe(true);
      expect(await page.unclipped(".agent-v2-deliverables")).not.toContain(false);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
