// @vitest-environment node
import { type AgentStream, GUARD_WINDOW_DAYS } from "@mc/core";
import { expect, it } from "vitest";
import { populatedAgentView } from "./agentV2Fixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const view = populatedAgentView();
const payload = (offset: number): AgentStream => ({
  runId: view.row.run?.id ?? null,
  events: Array.from({ length: 20 }, (_, index) => ({
    id: `proof:${index + offset}`,
    at: NOW - 20_000 + (index + offset) * 100,
    kind: "msg" as const,
    text: `Event ${index + offset}\n\n${"A detailed activity row remains readable. ".repeat(8)}`,
  })),
  tasks: [],
  truncated: false,
  hasMore: false,
  lastOutputAt: NOW,
  reason: null,
});

describeRendered("Agent stream window", () => {
  it(
    "counts arrivals at a fixed 20-row limit without moving the reader, then jumps and clears",
    async () => {
      const page = await renderAt({
        page: "test/agentStreamWindowBrowser.html",
        width: 1920,
        height: 940,
        api: {
          "/api/config": CONFIG,
          "/api/crew?shape=summary": { rows: [view.row], firstRunToday: null },
          "/api/agents/guido-1": view,
          "/api/attention": [],
          "/api/limits": [],
          "/api/activity": [],
          [`/api/guard/hits?days=${GUARD_WINDOW_DAYS}`]: { hits: [] },
          "/api/agents/guido-1/stream?limit=20": payload(0),
        },
      });
      await page.box("#stream .ev:last-child");
      const before = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("#stream");
        if (!el) throw new Error("Stream absent");
        el.scrollTop = 5;
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
        return {
          top: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          rows: el.querySelectorAll(".ev").length,
        };
      }, null);
      expect(before.rows).toBe(20);
      expect(before.max).toBeGreaterThan(80);

      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent("proof-stream-arrivals", { detail })),
        payload(2),
      );
      await page.box(".agent-new-rows");
      const after = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>("#stream");
        return {
          top: el?.scrollTop,
          rows: el?.querySelectorAll(".ev").length,
          badge: document.querySelector(".agent-new-rows")?.textContent?.trim(),
        };
      }, null);
      expect(after).toEqual({ top: before.top, rows: 20, badge: "2 new" });

      await page.click(".agent-new-rows");
      await page.evaluate(() => new Promise((resolve) => window.setTimeout(resolve, 100)), null);
      expect(
        await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>("#stream");
          return {
            badge: !!document.querySelector(".agent-new-rows"),
            bottom: !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 40,
          };
        }, null),
      ).toEqual({ badge: false, bottom: true });
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
