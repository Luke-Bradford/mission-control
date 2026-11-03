// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LimitRow } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { MIN, NOW } from "./fixtures.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
describeRendered("Overview constrained monitoring budget", () => {
  for (const age of ["fresh", "stale"] as const)
    for (const scenario of ["mixed", "normal-loops"] as const)
      for (const scheme of ["light", "dark"] as const)
        it(
          `retains the forecast, zero readings and wrapped next action at1920, ${age}, ${scenario}, ${scheme}`,
          async () => {
            const fixture = overviewDensityFixture(scenario);
            if (age === "stale") fixture.summary.at = NOW - 5 * MIN;
            fixture.summary.kpis.tokensPerMin.now = 0;
            fixture.summary.kpis.tokensPerMin.series = Array.from({ length: 30 }, () => 0);
            fixture.attention[0]!.text =
              "[operator-decision] Recorded fixture maintenance is paused until its next planned capacity window (Wednesday at02:00 UTC).";
            for (const row of fixture.rows)
              if (row.digest)
                row.digest.minuteTokens = row.digest.minuteTokens.map(([at]) => [at, 0]);
            const limits = fixture.api["/api/limits"] as LimitRow[];
            const binding = limits.find((row) => row.accountId === "codex-main")!;
            binding.used = 83;
            binding.fullAt = NOW + 8 * 60 * MIN;
            binding.resetAt = NOW + 7 * 24 * 60 * MIN;
            const page = await renderAt({
              page: "test/overviewDensityBrowser.html",
              width: 1920,
              height: 1080,
              colorScheme: scheme,
              api: fixture.api,
            });
            const records = [];
            try {
              await page.evaluate(
                async (expectedRows) => {
                  const ready = () =>
                    document.querySelectorAll("#agentsList .trow:not(.head)").length ===
                      expectedRows &&
                    document.querySelectorAll(".loop-chip").length === 2 &&
                    document
                      .querySelector(".overview-constraints")
                      ?.textContent?.includes("full in") &&
                    document.querySelector("#actList .arow") &&
                    document.querySelector(".overview-instant") &&
                    document.querySelector("#machineSummaryP .machine-chart") &&
                    document
                      .querySelector("#overviewHistoryP")
                      ?.textContent?.includes("No activity in the measured minutes.");
                  const end = performance.now() + 5000;
                  while (!ready() && performance.now() < end)
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                  if (!ready()) throw Error("Constrained fictional fixture did not settle");
                  await document.fonts.ready;
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  );
                },
                scenario === "mixed" ? 9 : 11,
              );
              for (const rail of ["folded", "open"]) {
                if (rail === "open") await page.click(".dockrail button");
                const facts = await page.evaluate(() => {
                  const box = (selector: string) =>
                    document.querySelector(selector)!.getBoundingClientRect().toJSON();
                  const grid = document.querySelector<HTMLElement>(".overview-grid")!;
                  return {
                    page: box("#page-overview"),
                    grid: { client: grid.clientHeight, scroll: grid.scrollHeight },
                    crew: box("#agentsP"),
                    provider: box("#quotaSummaryP"),
                    timeline: box("#timelineP"),
                    history: box("#overviewHistoryP"),
                    machine: box("#machineSummaryP"),
                    constraint: document.querySelector(".overview-constraints")?.textContent,
                    status: document.querySelector(".overview-status")?.textContent,
                    next: document.querySelector(".overview-next-first")?.textContent,
                    zero: document.querySelector("#overviewHistoryP")?.textContent,
                    rows: [...document.querySelectorAll("#agentsList .trow:not(.head)")].map(
                      (row) => row.getBoundingClientRect().height,
                    ),
                    controls: [
                      ...document.querySelectorAll(
                        ".overview-analytical .ph button,.overview-analytical .ph select",
                      ),
                    ]
                      .filter((el) => el.getBoundingClientRect().height > 0)
                      .map((el) => ({
                        width: el.getBoundingClientRect().width,
                        height: el.getBoundingClientRect().height,
                      })),
                  };
                }, undefined);
                const file = `constrained-${age}-${scenario}-1920x1080-${scheme}-${rail}.png`;
                if (evidence) {
                  mkdirSync(evidence, { recursive: true });
                  await page.screenshot(join(evidence, file));
                }
                records.push({
                  source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
                  capturedAt: new Date().toISOString(),
                  fixtureClock: NOW,
                  apiSha256: hash(JSON.stringify(fixture.api)),
                  helperSha256: hash(readFileSync(import.meta.filename)),
                  file,
                  facts,
                  errors: page.errors(),
                });
                if (evidence)
                  writeFileSync(
                    join(evidence, `constrained-${age}-${scenario}-${scheme}.json`),
                    JSON.stringify(records, null, 2),
                  );
                expect(facts.grid.scroll, JSON.stringify(facts)).toBeLessThanOrEqual(
                  facts.grid.client + 1,
                );
                expect(facts.machine.bottom).toBeLessThanOrEqual(facts.page.bottom + 1);
                if (age === "stale") {
                  expect(facts.status).toContain("Stale snapshot");
                  expect(facts.status).toContain("Last read");
                  expect(facts.status).toContain("Refresh overview");
                }
                expect(facts.next).toContain("Wednesday at02:00 UTC");
                expect(facts.zero).toContain("No activity in the measured minutes.");
                expect(facts.rows.every((height) => height === 32)).toBe(true);
                for (const control of facts.controls) {
                  expect(control.width).toBeGreaterThanOrEqual(24);
                  expect(control.height).toBeGreaterThanOrEqual(24);
                }
                expect(page.errors()).toEqual([]);
              }
            } finally {
              await page.close();
            }
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
});
