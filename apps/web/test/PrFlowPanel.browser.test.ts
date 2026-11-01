// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG } from "./fixtures.ts";
import { flightSummary } from "./flightSummaryFixture.ts";
import { prFlowFixture } from "./prFlowFixture.ts";

const { renderAt } = browserSession();
const shots =
  process.env.MC_FLOW_SHOTS ?? join(process.env.TMPDIR ?? "/tmp", "pr-flow-panel-shots");
const api = (count = 6) => ({
  [OPERATOR_BOOTSTRAP_PATH]: { token: "fixture-token" },
  "/api/prs/flow": prFlowFixture(count),
  "/api/config": CONFIG,
  "/api/crew?shape=summary": { rows: [], firstRunToday: null },
  "/api/flight": { seat: null, decisions: [] },
  "/api/attention": [],
  "/api/attention/held": [],
  "/api/notifications": { open: [], handledToday: [] },
  "/api/drafts": [],
  "/api/drafts/history": [],
  "/api/flight/brief": { session: null, sections: [] },
  "/api/flight/summary": flightSummary({ session: null }),
  "/api/settings/crew-pause": null,
});

describeRendered("FLIGHT PR flow panel", () => {
  it.each(
    [1280, 1600, 1920].flatMap((width) =>
      ["light", "dark"].map((theme) => ({ width, theme: theme as "light" | "dark" })),
    ),
  )(
    "fits $width in $theme with readable delay reasons",
    async ({ width, theme }) => {
      const page = await renderAt({
        page: "test/prFlowBrowser.html",
        width,
        height: 1000,
        colorScheme: theme,
        api: api(),
      });
      await page.boxes(".pr-flow-table tbody tr");
      expect(await page.unclipped("#prFlowP")).toEqual([true]);
      for (const link of await page.boxes(".pr-flow-table td > a, .pr-flow-table li > a")) {
        expect(link.height).toBeGreaterThanOrEqual(24);
        expect(link.width).toBeGreaterThanOrEqual(24);
      }
      expect(await page.unclipped(".pr-flow-table td")).not.toContain(false);
      expect(await page.reachable("#prFlowP")).toEqual([true]);
      expect(
        await page.evaluate(() => {
          const flow = document.getElementById("prFlowP");
          const needs = document.getElementById("askP");
          return (
            flow?.previousElementSibling === needs &&
            !!document.querySelector(".pr-flow-warn") &&
            !!document.querySelector(".pr-flow-crit")
          );
        }, null),
      ).toBe(true);
      await page.evaluate(
        () => document.getElementById("prFlowP")?.scrollIntoView({ block: "start" }),
        null,
      );
      mkdirSync(shots, { recursive: true });
      await page.screenshot(join(shots, `pr-flow-${width}-${theme}.png`));
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it.each(["light", "dark"] as const)(
    "keeps production repo and four-digit ticket refs readable in %s",
    async (theme) => {
      const f = prFlowFixture();
      const repo = f.repos[0];
      if (!repo) throw new Error("fixture missing");
      repo.repoId = "mission-control";
      repo.rows = repo.rows.map((r, i) => ({
        ...r,
        pr: 1311 + i,
        ticket: `mission-control#${1198 + i}`,
      }));
      const page = await renderAt({
        page: "test/prFlowBrowser.html",
        width: 1280,
        height: 1000,
        colorScheme: theme,
        api: { ...api(), "/api/prs/flow": f },
      });
      await page.boxes(".pr-flow-table tbody tr");
      expect(await page.unclipped(".pr-flow-table td")).not.toContain(false);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps 50 long rows scrollable and the last row reachable",
    async () => {
      const page = await renderAt({
        page: "test/prFlowBrowser.html",
        width: 1280,
        height: 1000,
        api: api(50),
      });
      expect(await page.boxes(".pr-flow-table tbody tr")).toHaveLength(50);
      expect(await page.unclipped(".pr-flow-title")).not.toContain(false);
      expect(await page.reachable(".pr-flow-table tbody tr:last-child")).toEqual([true]);
      expect(
        await page.evaluate(() => {
          const el = document.querySelector(".pr-flow-scroll");
          return !!el && el.scrollHeight > el.clientHeight;
        }, null),
      ).toBe(true);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it(
    "keeps the flow panel reachable in a short window",
    async () => {
      const page = await renderAt({
        page: "test/prFlowBrowser.html",
        width: 1600,
        height: 700,
        api: api(),
      });
      expect(await page.reachable("#prFlowP")).toEqual([true]);
      expect(await page.reachable(".pr-flow-table tbody tr:last-child")).toEqual([true]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
