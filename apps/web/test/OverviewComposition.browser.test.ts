// @vitest-environment node

import { expect, it } from "vitest";
import { browserSession, describeRendered, type RenderedPage } from "./browserRunner.ts";
import { type OverviewScenario, overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();

async function settled(page: RenderedPage) {
  await page.evaluate(async () => {
    const deadline = performance.now() + 5000;
    while (!document.querySelector("#agentsList .trow:not(.head)") && performance.now() < deadline)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }, undefined);
}

function open(scenario: OverviewScenario, width: number, height: number, dark = true) {
  return renderAt({
    page: "test/overviewDensityBrowser.html",
    width,
    height,
    colorScheme: dark ? "dark" : "light",
    api: overviewDensityFixture(scenario).api,
  });
}

const measure = (page: RenderedPage) =>
  page.evaluate(() => {
    const bottom = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().bottom ?? Number.NaN;
    const width = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().width ?? Number.NaN;
    const grid = document.querySelector(".overview-grid") as HTMLElement;
    const doc = document.documentElement;
    const rows = [...document.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head)")];
    // A cell that spills out of its row is clipped or overprints the next one.
    const spill = rows.flatMap((row) => {
      const box = row.getBoundingClientRect();
      return [...row.children].filter((cell) => {
        const r = cell.getBoundingClientRect();
        return r.width > 0 && (r.top < box.top - 1 || r.bottom > box.bottom + 1);
      });
    }).length;
    const head = [...document.querySelectorAll<HTMLElement>("#agentsList .trow.head > *")];
    const first = rows[0] ? [...rows[0].children] : [];
    const shown = (cell: Element) => cell.getBoundingClientRect().width > 0;
    const heads = head.filter(shown).map((cell) => Math.round(cell.getBoundingClientRect().left));
    const cells = first.filter(shown).map((cell) => Math.round(cell.getBoundingClientRect().left));
    return {
      pageScroll: doc.scrollHeight - innerHeight,
      pageScrollX: doc.scrollWidth - doc.clientWidth,
      gridScroll: grid.scrollHeight - grid.clientHeight,
      primaryBottom: bottom("#pipelineP"),
      secondaryBottom: bottom("#actP"),
      crewShare: width("#agentsP") / width(".overview-grid"),
      side: width(".overview-secondary"),
      spill,
      heads,
      cells,
      order: [...document.querySelectorAll(".overview-secondary > *")].map((el) => el.id),
    };
  }, undefined);

describeRendered("Overview composition", () => {
  it.each([
    [1920, 940],
    [2560, 1145],
    [2560, 1250],
    [3840, 2160],
  ])(
    "fits %ix%i without page scrolling, with level columns and Crew in the wide one",
    async (width, height) => {
      const page = await open("mixed", width, height);
      await settled(page);
      const m = await measure(page);
      expect(page.errors()).toEqual([]);
      expect(m.pageScroll).toBeLessThanOrEqual(0);
      expect(m.pageScrollX).toBeLessThanOrEqual(0);
      expect(m.gridScroll).toBeLessThanOrEqual(0);
      expect(Math.abs(m.primaryBottom - m.secondaryBottom)).toBeLessThanOrEqual(1);
      expect(m.crewShare).toBeGreaterThan(0.6);
      expect(m.crewShare).toBeLessThan(0.8);
      expect(m.order).toEqual(["overviewNextP", "macP", "tokensP", "actP"]);
      expect(m.spill).toBe(0);
      expect(m.heads).toEqual(m.cells);
    },
    60_000,
  );

  it("sizes the side column by its content, whatever spare width there is", async () => {
    const small = await open("mixed", 1920, 940);
    await settled(small);
    const wide = await open("mixed", 2560, 1250);
    await settled(wide);
    expect((await measure(small)).side).toBe(560);
    expect((await measure(wide)).side).toBe(640);
  }, 60_000);

  it.each(["empty", "one", "many", "long"] as const)(
    "keeps the %s crew inside the page, with every row whole",
    async (scenario) => {
      const page = await open(scenario, 1920, 940);
      await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }, undefined);
      const m = await measure(page);
      expect(page.errors()).toEqual([]);
      expect(m.pageScroll).toBeLessThanOrEqual(0);
      expect(m.pageScrollX).toBeLessThanOrEqual(0);
      expect(m.spill).toBe(0);
    },
    60_000,
  );

  it("a short window scrolls the grid, never the page, and reaches the log", async () => {
    const page = await open("mixed", 1600, 700);
    await settled(page);
    const m = await measure(page);
    expect(m.pageScrollX).toBeLessThanOrEqual(0);
    expect(m.gridScroll).toBeGreaterThan(0);
    expect(await page.reachable("#actP")).toEqual([true]);
  }, 60_000);

  it("stacks the columns in a narrow window with nothing out of reach", async () => {
    const page = await open("mixed", 1280, 800);
    await settled(page);
    const m = await measure(page);
    expect(m.pageScrollX).toBeLessThanOrEqual(0);
    expect(await page.reachable("#actP")).toEqual([true]);
    expect(await page.reachable("#tokensP")).toEqual([true]);
  }, 60_000);

  it("holds the same composition in the light theme", async () => {
    const page = await open("mixed", 2560, 1145, false);
    await settled(page);
    const m = await measure(page);
    expect(m.pageScroll).toBeLessThanOrEqual(0);
    expect(Math.abs(m.primaryBottom - m.secondaryBottom)).toBeLessThanOrEqual(1);
  }, 60_000);
});
