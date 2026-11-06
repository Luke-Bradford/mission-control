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

  it.each([
    ["error", "Refresh failed"],
    ["stale", "Stale snapshot"],
    ["disconnected", "Disconnected"],
    ["loading", "Loading current work"],
  ] as const)(
    "the %s state says %s without breaking the page",
    async (scenario, words) => {
      const page = await renderAt({
        page: "test/overviewDensityBrowser.html",
        width: 1920,
        height: 940,
        search: `?state=${scenario}`,
        colorScheme: "dark",
        api: overviewDensityFixture(scenario).api,
      });
      await page.evaluate(async (expected) => {
        const status = () => document.querySelector(".overview-status")?.textContent ?? "";
        const deadline = performance.now() + 20_000;
        while (!status().includes(expected) && performance.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        // The checks below need the other panels' late layout and errors, not only the first paint.
        await document.fonts.ready;
        await new Promise((resolve) => setTimeout(resolve, 800));
      }, words);
      const m = await page.evaluate(
        () => ({
          pageScroll: document.documentElement.scrollHeight - innerHeight,
          status: document.querySelector(".overview-status")?.textContent ?? "",
        }),
        undefined,
      );
      expect(page.errors()).toEqual([]);
      expect(m.pageScroll).toBeLessThanOrEqual(0);
      expect(m.status, "status text after waiting up to 20 s for it").toContain(words);
    },
    60_000,
  );

  const crewSideOverlap = (page: RenderedPage) =>
    page.evaluate(async () => {
      // The width reaches the layout through a media query change and a React update: wait for it to hold.
      const read = () => {
        const crew = document.querySelector("#agentsP")?.getBoundingClientRect();
        const side = document.querySelector("#overviewNextP")?.getBoundingClientRect();
        return crew && side ? { crew, side } : null;
      };
      const key = () => {
        const now = read();
        return now ? JSON.stringify([now.crew, now.side]) : "missing";
      };
      const deadline = performance.now() + 5000;
      let last = "";
      let held = 0;
      while (held < 3 && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const next = key();
        held = next === last ? held + 1 : 0;
        last = next;
      }
      const now = read();
      if (!now) return "panel missing";
      const { crew, side } = now;
      return crew.right <= side.left || side.right <= crew.left || crew.bottom <= side.top
        ? "apart"
        : "overlap";
    }, undefined);

  // Fresh loads where the layout changes; the other widths resize one browser, because a launch per
  // width slowed the tests running beside this file.
  it.each([1500, 1536])(
    "keeps Crew and the side column apart when first opened at %i wide",
    async (width) => {
      const page = await open("mixed", width, 900);
      await settled(page);
      expect(await crewSideOverlap(page)).toBe("apart");
    },
    60_000,
  );

  it("keeps Crew and the side column apart as the window changes width", async () => {
    const page = await open("mixed", 1280, 900);
    await settled(page);
    const results: Record<number, string> = {};
    for (const width of [1280, 1366, 1500, 1505, 1512, 1536, 1600, 1700, 1505, 1280]) {
      await page.resize(width, 900);
      const result = await crewSideOverlap(page);
      if (result !== "apart") results[width] = result;
    }
    expect(results).toEqual({});
  }, 60_000);

  it("keeps every row's controls and links reachable at the reference size", async () => {
    const page = await open("mixed", 1920, 940);
    await settled(page);
    expect(page.errors()).toEqual([]);
    for (const selector of [
      "#agentsList .rowlink",
      "#agentsList button",
      ".board-card",
      ".needs-row",
    ])
      expect((await page.reachable(selector, ".overview-grid")).every(Boolean), selector).toBe(
        true,
      );
    const small = await page.evaluate(() => {
      const selector = ".board-stage h3 a, .token-head a, .mac-row h2 a, #page-overview .ph h2 a";
      return [...document.querySelectorAll(selector)]
        .map((link) => link.getBoundingClientRect())
        .filter((box) => box.height < 24).length;
    }, undefined);
    expect(small).toBe(0);
  }, 60_000);

  it("opens a Needs-you item from the keyboard", async () => {
    const page = await open("mixed", 1920, 940);
    await settled(page);
    await page.evaluate(
      () => document.querySelector<HTMLElement>(".needs-row")?.focus(),
      undefined,
    );
    await page.press("Enter");
    await page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }, undefined);
    const opened = await page.evaluate(
      () => ({
        search: location.search,
        hash: location.hash,
        path: location.pathname,
        flyout: !!document.querySelector(".flyout"),
      }),
      undefined,
    );
    // an ask opens on the Needs you page; any other item still opens the flyout
    expect(
      opened.flyout ||
        opened.search.includes("item") ||
        opened.hash !== "" ||
        opened.path.startsWith("/needs-you"),
    ).toBe(true);
    expect(page.errors()).toEqual([]);
  }, 60_000);

  it("FLIGHT covers the side column at 1920 and the page behind stays usable", async () => {
    const page = await open("mixed", 1920, 940);
    await settled(page);
    await page.click(".dockrail button");
    const covered = await page.evaluate(() => {
      const dock = document.querySelector("#dock")?.getBoundingClientRect();
      const crew = document.querySelector("#agentsP")?.getBoundingClientRect();
      const link = document.querySelector<HTMLElement>("#agentsList .rowlink");
      const box = link?.getBoundingClientRect();
      const hit = box && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        overlapsCrew: !!dock && !!crew && dock.left < crew.right,
        crewReachable: !!link && !!hit && (link === hit || link.contains(hit)),
        inert: ["main", "header.top", "footer.keys"].filter((s) =>
          document.querySelector(s)?.hasAttribute("inert"),
        ),
      };
    }, undefined);
    expect(covered).toEqual({ overlapsCrew: false, crewReachable: true, inert: [] });
    // Nothing focusable is left under the cover.
    expect(
      await page.evaluate(() => {
        const side = document.querySelector<HTMLElement>(".overview-secondary");
        return side ? getComputedStyle(side).visibility : "missing";
      }, undefined),
    ).toBe("hidden");
    // Esc folds it from the page behind too.
    await page.evaluate(
      () => document.querySelector<HTMLElement>("#agentsList .rowlink")?.focus(),
      undefined,
    );
    await page.press("Escape");
    expect(
      await page.evaluate(
        () => document.querySelector("#dock")?.classList.contains("collapsed"),
        undefined,
      ),
    ).toBe(true);
  }, 60_000);

  it("gives FLIGHT its own column when the page is stacked, covering nothing", async () => {
    const page = await open("mixed", 1280, 800);
    await settled(page);
    await page.click(".dockrail button");
    const m = await page.evaluate(() => {
      const dock = document.querySelector("#dock")?.getBoundingClientRect();
      const crew = document.querySelector("#agentsP")?.getBoundingClientRect();
      return {
        cover: !!document.querySelector(".overview-flight-overlay"),
        apart: !!dock && !!crew && crew.right <= dock.left,
      };
    }, undefined);
    expect(m).toEqual({ cover: false, apart: true });
  }, 60_000);

  it("holds the same composition in the light theme", async () => {
    const page = await open("mixed", 2560, 1145, false);
    await settled(page);
    const m = await measure(page);
    expect(m.pageScroll).toBeLessThanOrEqual(0);
    expect(Math.abs(m.primaryBottom - m.secondaryBottom)).toBeLessThanOrEqual(1);
  }, 60_000);
});
