// @vitest-environment node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentDensityFixture } from "./agentDensityFixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const waitForText = async (expected: string) => {
  const start = performance.now();
  while (
    !document.querySelector("#page-agent")?.textContent?.includes(expected) &&
    performance.now() - start < 1500
  ) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return document.querySelector("#page-agent")?.textContent?.includes(expected) ?? false;
};
describeRendered("Agent density in the production App", () => {
  it.each([
    { width: 1280, height: 1000 },
    { width: 1440, height: 1000 },
    { width: 1600, height: 1000 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 1600, height: 700 },
  ])(
    "keeps the answer first at $width × $height, both rail states and schemes",
    async ({ width, height }) => {
      for (const theme of ["light", "dark"] as const)
        for (const dock of ["folded", "open"] as const) {
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            colorScheme: theme,
            search: `?dock=${dock}`,
            api: agentDensityFixture().api,
          });
          await page.box(".agent-v2-story");
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          }, null);
          const shots = process.env.MC_AGENT_DENSITY_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `agent-${width}x${height}-${theme}-${dock}.png`));
          }
          const facts = await page.evaluate(
            () => ({
              width: document.documentElement.scrollWidth,
              story: document.querySelector(".agent-v2-story")?.getBoundingClientRect().toJSON(),
              next: document.querySelector(".agent-v2-next")?.getBoundingClientRect().toJSON(),
              figures: document.querySelectorAll(".agent-v2-stat").length,
              steps: document.querySelectorAll(".agent-v2-steps li").length,
              model: document.querySelector("#ahead")?.textContent,
              text: document.querySelector("#page-agent")?.textContent,
            }),
            null,
          );
          expect(page.errors()).toEqual([]);
          expect(facts.width).toBeLessThanOrEqual(width + 1);
          expect(facts.figures).toBe(5);
          expect(facts.steps).toBe(6);
          expect(facts.story?.bottom).toBeLessThan(height);
          expect(facts.next?.top).toBeLessThan(height);
          expect(facts.model).toContain("high · Budget $12.50");
          expect(facts.text).toContain("One keyboard check is still open");
          expect(
            await page.unclipped(
              ".agent-v2-columns, .agent-v2-identity, .agent-v2-story, .agent-v2-stat",
            ),
          ).not.toContain(false);
          expect(
            await page.reachable(".agent-v2-next a, #agentInput, .agent-v2-actions summary"),
          ).not.toContain(false);
          await page.close();
        }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
  it.each(["empty", "one", "long", "many", "loading", "error", "stale", "disconnected"] as const)(
    "keeps honest %s content and full access in both schemes",
    async (scenario) => {
      for (const theme of ["light", "dark"] as const) {
        const fixture = agentDensityFixture(scenario);
        const page = await renderAt({
          page: "test/agentV2Browser.html",
          width: 1280,
          height: 700,
          colorScheme: theme,
          search: `?dock=open&state=${scenario}${scenario === "empty" ? "&at=/agent" : ""}`,
          api: fixture.api,
        });
        const expected =
          scenario === "empty"
            ? "No agents in this session."
            : scenario === "loading"
              ? "Loading…"
              : scenario === "error"
                ? "Could not load this agent."
                : scenario === "one"
                  ? "No run yet."
                  : "Ask → result → next";
        await page.box("#page-agent");
        const settled = await page.evaluate(waitForText, expected);
        const shots = process.env.MC_AGENT_DENSITY_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(join(shots, `agent-state-${scenario}-${theme}-initial.png`));
        }
        expect(settled).toBe(true);
        if (scenario === "stale") {
          await page.evaluate(() => window.dispatchEvent(new Event("fixture-stale-agent")), null);
          expect(await page.evaluate(waitForText, "Showing the last saved agent view.")).toBe(true);
          expect(
            await page.evaluate(() => document.querySelector(".agent-v2-story")?.textContent, null),
          ).toContain(fixture.view.story.title);
        }
        if (scenario === "long") {
          await page.click('[aria-label="Read full reported result"]');
          expect(
            await page.evaluate(
              () => document.querySelector(".agent-v2-story .vdetail")?.textContent,
              null,
            ),
          ).toBe(fixture.view.story.report);
          expect(await page.reachable(".agent-v2-story .vdetail")).not.toContain(false);
          await page.press("Tab");
          const focusReady = await page.evaluate(async () => {
            const reader = document.querySelector(
              '[aria-label="Full reported result"]',
            ) as HTMLElement;
            const clip = document.querySelector("#page-agent") as HTMLElement,
              start = performance.now();
            const visible = () => {
              const box = reader.getBoundingClientRect(),
                outer = clip.getBoundingClientRect();
              return (
                document.activeElement === reader &&
                box.top >= outer.top &&
                box.bottom <= outer.bottom
              );
            };
            while (!visible() && performance.now() - start < 1000)
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            return {
              visible: visible(),
              box: reader.getBoundingClientRect().toJSON(),
              outer: clip.getBoundingClientRect().toJSON(),
            };
          }, null);
          if (shots)
            writeFileSync(
              join(shots, `agent-state-long-${theme}-focus.json`),
              JSON.stringify(focusReady, null, 2),
            );
          expect(focusReady.visible).toBe(true);
          await page.press("End");
          const fullText = await page.evaluate(async () => {
            const region = document.querySelector(
              '[aria-label="Full reported result"]',
            ) as HTMLElement;
            const start = performance.now();
            const read = () => {
              const range = document.createRange();
              range.selectNodeContents(region);
              const last = [...range.getClientRects()].at(-1),
                box = region.getBoundingClientRect();
              const hit = last
                ? document.elementFromPoint(
                    last.x + Math.min(last.width / 2, 20),
                    last.y + last.height / 2,
                  )
                : null;
              return {
                remaining: region.scrollHeight - region.clientHeight - region.scrollTop,
                region: box.toJSON(),
                last: last?.toJSON(),
                active: document.activeElement?.getAttribute("aria-label"),
                hit: hit?.tagName,
                painted:
                  !!last &&
                  last.bottom <= Math.min(box.bottom, innerHeight) + 1 &&
                  last.top >= Math.max(box.top, 0) - 1 &&
                  region.contains(hit),
              };
            };
            let measured = read();
            while (
              (!measured.painted || measured.remaining > 2) &&
              performance.now() - start < 1000
            ) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              measured = read();
            }
            return measured;
          }, null);
          if (shots)
            await page.screenshot(join(shots, `agent-state-long-${theme}-full-text-end.png`));
          if (shots)
            writeFileSync(
              join(shots, `agent-state-long-${theme}-full-text-metrics.json`),
              JSON.stringify(fullText, null, 2),
            );
          expect(fullText.remaining).toBeLessThanOrEqual(2);
          expect(fullText.painted).toBe(true);
        }
        if (scenario === "many") {
          expect((await page.boxes(".agent-v2-deliverables a")).length).toBe(50);
          await page.evaluate(
            () => (document.querySelector(".agent-v2-deliverables") as HTMLElement).focus(),
            null,
          );
          await page.press("End");
          const bottom = await page.evaluate(async () => {
            const list = document.querySelector(".agent-v2-deliverables") as HTMLElement;
            const start = performance.now();
            while (
              list.scrollHeight - list.clientHeight - list.scrollTop > 2 &&
              performance.now() - start < 1000
            )
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const last = list.querySelector("li:last-child a") as HTMLElement,
              box = last.getBoundingClientRect(),
              region = list.getBoundingClientRect();
            return {
              remaining: list.scrollHeight - list.clientHeight - list.scrollTop,
              last: last.textContent,
              painted:
                box.bottom <= Math.min(region.bottom, innerHeight) + 1 &&
                box.top >= Math.max(region.top, 0) - 1 &&
                last.contains(
                  document.elementFromPoint(
                    box.x + Math.min(box.width / 2, 30),
                    box.y + box.height / 2,
                  ),
                ),
            };
          }, null);
          if (shots) await page.screenshot(join(shots, `agent-state-many-${theme}-50th-link.png`));
          expect(bottom.remaining).toBeLessThanOrEqual(2);
          expect(bottom.last).toContain("evidence-50.tsx");
          expect(bottom.painted).toBe(true);
          expect((await page.boxes("#picker button")).length).toBe(50);
          await page.evaluate(
            () => (document.querySelector("#picker") as HTMLElement).focus(),
            null,
          );
          await page.press("End");
          const lastSeat = await page.evaluate(async () => {
            const region = document.querySelector("#picker") as HTMLElement,
              start = performance.now();
            while (
              region.scrollHeight - region.clientHeight - region.scrollTop > 2 &&
              performance.now() - start < 1000
            )
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const button = region.querySelector("button:last-child") as HTMLElement,
              rect = button.getBoundingClientRect(),
              box = region.getBoundingClientRect();
            return {
              text: button.textContent,
              remaining: region.scrollHeight - region.clientHeight - region.scrollTop,
              painted:
                rect.bottom <= Math.min(box.bottom, innerHeight) + 1 &&
                rect.top >= Math.max(box.top, 0) - 1 &&
                button.contains(
                  document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
                ),
            };
          }, null);
          if (shots) await page.screenshot(join(shots, `agent-state-many-${theme}-50th-seat.png`));
          expect(lastSeat.remaining).toBeLessThanOrEqual(2);
          expect(lastSeat.text).toContain("guido-50");
          expect(lastSeat.painted).toBe(true);
        }
        if (scenario === "disconnected")
          expect(
            await page.evaluate(
              () => document.querySelector(".dock-summary-state")?.textContent,
              null,
            ),
          ).toContain("Disconnected");
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(join(shots, `agent-state-${scenario}-${theme}.png`));
        }
        expect(page.errors()).toEqual([]);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1, null),
        ).toBe(true);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
