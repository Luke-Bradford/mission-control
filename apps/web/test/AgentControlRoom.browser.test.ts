// @vitest-environment node
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
  "/api/limits": [],
  "/api/agents/guido-1/stream?limit=20": {
    runId: view.row.run?.id,
    events: [{ id: "1:0", at: NOW, kind: "op", text: "Build the Agent page." }],
    tasks: [],
    truncated: false,
    more: false,
  },
};

describeRendered("Agent control room", () => {
  it.each([
    { width: 1920, height: 940 },
    { width: 2560, height: 1145 },
  ])("fits $width × $height without page scrolling", async ({ width, height }) => {
    const page = await renderAt({ page: "test/agentV2Browser.html", width, height, api });
    await page.box(".agent-control-room");
    expect(
      await page.evaluate(
        () => ({
          page: document.documentElement.scrollHeight <= innerHeight + 1,
          hasLegacy: !!document.querySelector(".agent-v2-story, .agent-v2-deliverables, #sideP"),
        }),
        null,
      ),
    ).toEqual({ page: true, hasLegacy: false });
    expect(
      await page.unclipped(".agent-roster, .agent-identity-band, .agent-live-activity, #agentInput"),
    ).not.toContain(false);
    await page.close();
  }, BROWSER_TEST_TIMEOUT_MS);
});
