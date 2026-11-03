// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describeRendered("Corrected operational Overview first composition", () => {
  it(
    "retains the normal crew and independent domains in settled full-App contexts",
    async () => {
      execFileSync("git", ["diff", "--quiet", "HEAD", "--", "apps/web/src"]);
      const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const receipts = [];
      for (const [width, height, scheme] of [
        [1920, 1080, "light"],
        [3840, 2160, "dark"],
      ] as const) {
        const fixture = overviewDensityFixture();
        const page = await renderAt({
          page: "test/overviewDensityBrowser.html",
          width,
          height,
          colorScheme: scheme,
          api: fixture.api,
        });
        const key = `${width}x${height}-${scheme}-initial`;
        try {
          await page.evaluate(async () => {
            const ready = () =>
              document.querySelectorAll("#agentsList .trow:not(.head)").length === 11 &&
              document.querySelector("#page-overview")?.textContent?.includes("41.2k") &&
              (document.querySelector("#quotaSummaryP")?.textContent?.includes("37% left") ||
                document.querySelector("#quotaP")?.textContent?.includes("63%")) &&
              document.querySelector("#machineSummaryP .machine-chart") &&
              document.querySelector(".overview-instant");
            const deadline = performance.now() + 5000;
            while (!ready() && performance.now() < deadline)
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await document.fonts.ready;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
            if (!ready())
              throw Error(
                `Full-App fixture not settled: ${document.querySelector("#page-overview")?.textContent}`,
              );
          }, undefined);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot(join(evidence, `${key}.png`));
          }
          const facts = await page.evaluate(() => {
            const box = (selector: string) =>
              document.querySelector(selector)?.getBoundingClientRect().toJSON();
            const grid = document.querySelector<HTMLElement>(".overview-grid");
            return {
              viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
              page: box("#page-overview"),
              grid: grid && {
                clientHeight: grid.clientHeight,
                scrollHeight: grid.scrollHeight,
                clientWidth: grid.clientWidth,
                scrollWidth: grid.scrollWidth,
                ...grid.dataset,
              },
              columns: getComputedStyle(document.querySelector(".overview-workspace") as Element)
                .gridTemplateColumns,
              panels: Object.fromEntries(
                [
                  "agentsP",
                  "actP",
                  "pipelineP",
                  "quotaSummaryP",
                  "quotaP",
                  "timelineP",
                  "machineSummaryP",
                  "contextSummaryP",
                ].map((id) => [id, box("#" + id)]),
              ),
              histories: [...document.querySelectorAll(".overview-history-domain > .panel")].map(
                (p) => ({ id: p.id, box: p.getBoundingClientRect().toJSON() }),
              ),
              rows: [...document.querySelectorAll("#agentsList .trow:not(.head)")].map(
                (r) => r.getBoundingClientRect().height,
              ),
              roster: (() => {
                const r = document.querySelector<HTMLElement>("#agentsList");
                return r && { client: r.clientWidth, scroll: r.scrollWidth };
              })(),
              horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
              text: document.querySelector("#page-overview")?.textContent,
            };
          }, undefined);
          receipts.push({
            source,
            key,
            capturedAt: new Date().toISOString(),
            fixtureSha256: hash(JSON.stringify(fixture.api)),
            harnessSha256: hash(
              readFileSync(join(import.meta.dirname, "overviewDensityBrowser.tsx")),
            ),
            testSha256: hash(readFileSync(import.meta.filename)),
            png: evidence
              ? { file: `${key}.png`, sha256: hash(readFileSync(join(evidence, `${key}.png`))) }
              : null,
            facts,
            errors: page.errors(),
          });
          if (evidence)
            writeFileSync(join(evidence, "render-checks.json"), JSON.stringify(receipts, null, 2));
          expect(page.errors()).toEqual([]);
          expect(facts.rows).toHaveLength(11);
          expect(facts.rows.every((h) => h === 32)).toBe(true);
          expect(facts.horizontalOverflow).toBe(false);
          expect(facts.roster && facts.roster.scroll <= facts.roster.client).toBe(true);
          expect(
            facts.grid && facts.grid.scrollHeight <= facts.grid.clientHeight + 1,
            JSON.stringify(facts),
          ).toBe(true);
          expect(facts.histories).toHaveLength(width === 3840 ? 5 : 1);
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
