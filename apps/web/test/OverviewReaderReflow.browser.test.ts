// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const output = process.env.MC_QA_EVIDENCE_DIR;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const records: unknown[] = [];
async function record(page: RenderedPage, name: string, facts: unknown) {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await page.screenshot(join(output, `${name}.png`));
  records.push({
    name,
    capturedAt: new Date().toISOString(),
    source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    fixtureSha256: hash(JSON.stringify(overviewDensityFixture("normal-loops").api)),
    testSha256: hash(readFileSync(import.meta.filename)),
    png: { file: `${name}.png`, sha256: hash(readFileSync(join(output, `${name}.png`))) },
    facts,
    errors: page.errors(),
  });
  writeFileSync(join(output, "render-checks.json"), JSON.stringify(records, null, 2));
}
async function settle(page: RenderedPage) {
  await page.evaluate(async () => {
    const ready = () =>
      document.querySelectorAll("#agentsList .trow:not(.head)").length === 11 &&
      document.querySelectorAll(".loop-chip").length === 2 &&
      document.querySelector("#page-overview")?.textContent?.includes("41.2k") &&
      !!document.querySelector("#machineSummaryP .machine-chart");
    const end = performance.now() + 5000;
    while (!ready() && performance.now() < end)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!ready()) throw Error("Combined normal fixture not settled");
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, undefined);
}

describeRendered(
  "Overview review corrections retain readable monitoring and complete evidence",
  () => {
    for (const scheme of ["light", "dark"] as const) {
      it(
        `reflows KPI history actions beside enlarged values, ${scheme}`,
        async () => {
          const page = await renderAt({
            page: "test/overviewDensityBrowser.html",
            width: 1920,
            height: 1080,
            colorScheme: scheme,
            api: overviewDensityFixture("normal-loops").api,
          });
          try {
            await settle(page);
            await page.evaluate(async () => {
              // Same explicit text-only method as the independent finding. This is not browser zoom.
              const nodes = [
                ...document.querySelectorAll<HTMLElement>("#page-overview *, #dock *"),
              ].map((element) => {
                const style = getComputedStyle(element);
                return {
                  element,
                  font: Number.parseFloat(style.fontSize),
                  line: Number.parseFloat(style.lineHeight),
                };
              });
              for (const { element, font, line } of nodes) {
                if (Number.isFinite(font))
                  element.style.setProperty("font-size", `${font * 2}px`, "important");
                if (Number.isFinite(line))
                  element.style.setProperty("line-height", `${line * 2}px`, "important");
              }
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
            }, undefined);
            const facts = await page.evaluate(
              () =>
                [
                  ...document.querySelectorAll<HTMLElement>(".overview-kpi:has(.kpi-history-link)"),
                ].map((tile) => {
                  const button = tile.querySelector<HTMLElement>(".kpi-history-link")!;
                  const value = tile.querySelector<HTMLElement>(".v")!;
                  const b = button.getBoundingClientRect(),
                    v = value.getBoundingClientRect();
                  const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
                  return {
                    value: value.textContent,
                    button: b.toJSON(),
                    reading: v.toJSON(),
                    overlap:
                      Math.min(b.right, v.right) > Math.max(b.left, v.left) &&
                      Math.min(b.bottom, v.bottom) > Math.max(b.top, v.top),
                    painted: hit === button || button.contains(hit),
                  };
                }),
              undefined,
            );
            await record(page, `kpi-200percent-${scheme}`, facts);
            expect(facts).toHaveLength(5);
            expect(
              facts.every((f) => !f.overlap && f.painted),
              JSON.stringify(facts),
            ).toBe(true);
            expect(page.errors()).toEqual([]);
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );

      for (const width of [1920, 3840])
        it(
          `shows the larger history plot and final exact reading at${width}, ${scheme}`,
          async () => {
            const page = await renderAt({
              page: "test/overviewDensityBrowser.html",
              width,
              height: width === 3840 ? 2160 : 1080,
              colorScheme: scheme,
              api: overviewDensityFixture("normal-loops").api,
            });
            try {
              await settle(page);
              const opener =
                width === 3840
                  ? "#overviewHistory-tokens > .ph button"
                  : "#overviewHistoryP > .ph button";
              await page.evaluate((selector) => {
                const button = document.querySelector<HTMLElement>(selector);
                button?.scrollIntoView({ block: "center" });
                button?.focus();
              }, opener);
              await page.press("Enter");
              const facts = await page.evaluate(() => {
                const plot = document.querySelector<SVGSVGElement>(
                  "#overviewHistoryDetailP .measured-plot svg",
                )!;
                const dialog = plot.closest("dialog")!;
                return {
                  height: plot.getBoundingClientRect().height,
                  modal: dialog.matches(":modal"),
                  focus: dialog.contains(document.activeElement),
                  label: plot.getAttribute("aria-label"),
                };
              }, undefined);
              await record(page, `complete-history-${width}-${scheme}`, facts);
              expect(facts.height).toBe(240);
              expect(facts.modal && facts.focus).toBe(true);
              await page.click("#overviewHistoryDetailP .history-data summary");
              await page.evaluate(
                () =>
                  document
                    .querySelector<HTMLElement>("#overviewHistoryDetailP .history-data-scroll")
                    ?.focus(),
                undefined,
              );
              await page.press("End");
              const endpoint = await page.evaluate(async () => {
                const region = document.querySelector<HTMLElement>(
                  "#overviewHistoryDetailP .history-data-scroll",
                )!;
                const end = performance.now() + 1000;
                while (
                  region.scrollTop + region.clientHeight < region.scrollHeight - 1 &&
                  performance.now() < end
                )
                  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                const row = region.querySelector("tbody tr:last-child")!;
                const r = row.getBoundingClientRect(),
                  b = region.getBoundingClientRect();
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return {
                  focused: document.activeElement === region,
                  bottom: region.scrollTop + region.clientHeight >= region.scrollHeight - 1,
                  visible: r.top >= b.top && r.bottom <= b.bottom + 1,
                  painted: hit === row || row.contains(hit),
                  text: row.textContent,
                };
              }, undefined);
              await record(page, `complete-history-end-${width}-${scheme}`, endpoint);
              expect(endpoint).toMatchObject({
                focused: true,
                bottom: true,
                visible: true,
                painted: true,
              });
              expect(endpoint.text).toContain("41200");
              await page.press("Escape");
              expect(
                await page.evaluate(
                  (selector) => document.activeElement === document.querySelector(selector),
                  opener,
                ),
              ).toBe(true);
              expect(page.errors()).toEqual([]);
            } finally {
              await page.close();
            }
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
    }
  },
);
