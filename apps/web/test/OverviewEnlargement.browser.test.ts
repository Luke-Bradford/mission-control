// @vitest-environment node

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { browserSession, describeRendered, type RenderedPage } from "./browserRunner.ts";
import { type OverviewScenario, overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();

/**
 * Text-only enlargement, not browser zoom and not a device pixel ratio change: the viewport stays
 * at its CSS size and every type-scale token (hud.css `:root`) and line height doubles. The
 * stylesheet stays in the page for the whole test, so scrolling, focus and key presses all run
 * under it.
 */
const ENLARGED_TEXT = `:root {
  --fs-title: 40px; --fs-panel: 28px; --fs: 26px; --fs-s: 24px; --fs-micro: 22px;
  --lh-title: 56px; --lh-panel: 40px; --lh: 40px; --lh-s: 32px; --lh-micro: 32px; --lh-axis: 28px;
}`;

const SHOTS = join(tmpdir(), "overview-enlargement");

async function open(
  scenario: OverviewScenario,
  width: number,
  height: number,
  dark: boolean,
  enlarge: boolean,
) {
  const page = await renderAt({
    page: "test/overviewDensityBrowser.html",
    width,
    height,
    colorScheme: dark ? "dark" : "light",
    api: overviewDensityFixture(scenario).api,
  });
  await page.evaluate(
    async (css) => {
      const deadline = performance.now() + 5000;
      while (
        !document.querySelector("#agentsList .trow:not(.head)") &&
        performance.now() < deadline
      )
        await new Promise((resolve) => requestAnimationFrame(resolve));
      await document.fonts.ready;
      if (css) {
        const style = document.createElement("style");
        style.id = "text-enlargement";
        style.textContent = css;
        document.head.append(style);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    },
    enlarge ? ENLARGED_TEXT : "",
  );
  return page;
}

const measure = (page: RenderedPage) =>
  page.evaluate(() => {
    const region = document.querySelector<HTMLElement>("#agentsList");
    if (!region) throw Error("no Crew table");
    const shown = (el: Element) => el.getBoundingClientRect().width > 0;
    const rows = [...region.querySelectorAll<HTMLElement>(".trow")];
    const head = region.querySelector<HTMLElement>(".trow.head");
    const body = rows.filter((row) => !row.classList.contains("head"));
    const cellsOf = (row: Element) => [...row.children].filter(shown) as HTMLElement[];
    // A cell whose words are wider than its own box paints over its neighbour or is cut.
    const wider = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;
    const headCells = head ? cellsOf(head) : [];
    const stateCells = body.map((row) => cellsOf(row)[0]).filter((c): c is HTMLElement => !!c);
    const numCells = body.flatMap((row) =>
      cellsOf(row).filter((cell) => cell.classList.contains("num")),
    );
    const heights = body.map((row) => row.getBoundingClientRect().height);
    return {
      rowCount: body.length,
      texts: body.map((row) => row.textContent ?? ""),
      stateTitles: stateCells.map((cell) => cell.title),
      stateWords: stateCells.map((cell) => cell.querySelector(".pill > span")?.textContent ?? ""),
      // Where each heading's words sit, as a centre line: held headings must not ride higher.
      headCentres: headCells.map((cell) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const box = range.getBoundingClientRect();
        return box.top + box.height / 2;
      }),
      headTexts: headCells.map((cell) => cell.textContent ?? ""),
      tracks: headCells.map((cell) => Math.round(cell.getBoundingClientRect().width)),
      cuts: {
        head: headCells.filter(wider).length,
        state: stateCells.filter(wider).length,
        pill: stateCells.filter((cell) => {
          const pill = cell.querySelector<HTMLElement>(".pill");
          const word = cell.querySelector<HTMLElement>(".pill > span");
          return (!!pill && wider(pill)) || (!!word && wider(word));
        }).length,
        numbers: numCells.filter(wider).length,
      },
      rowsOverlap: rows.filter((row) => {
        const cells = cellsOf(row).map((cell) => cell.getBoundingClientRect());
        return cells.some((cell, i) => i > 0 && cell.left < (cells[i - 1]?.right ?? 0) - 1);
      }).length,
      headTop: head?.getBoundingClientRect().top ?? Number.NaN,
      regionTop: region.getBoundingClientRect().top,
      tallest: Math.max(...heights),
      tableRow: Number.parseFloat(
        getComputedStyle(
          document.querySelector("#page-overview") ?? document.body,
        ).getPropertyValue("--table-row"),
      ),
      minHeights: body.map((row) => Number.parseFloat(getComputedStyle(row).minHeight)),
      // No reserved scrollbar gutter: the table is as wide inside as outside, and rows fill it.
      gutter: region.offsetWidth - region.clientWidth,
      rowWidths: body.map((row) => row.offsetWidth - region.clientWidth),
      noteText: document.querySelector(".crew-scroll-note")?.textContent ?? "",
      flight: (() => {
        const row = region.querySelector<HTMLElement>(".trow.flight");
        if (!row) return null;
        const tint = getComputedStyle(row).backgroundColor;
        const held = [...row.children]
          .slice(0, 2)
          .map((cell) => getComputedStyle(cell).backgroundImage);
        return { tint, held };
      })(),
      scrollsSideways: region.scrollWidth - region.clientWidth,
      overflowX: getComputedStyle(region).overflowX,
      crewRight: document.querySelector("#agentsP")?.getBoundingClientRect().right ?? Number.NaN,
      viewRight: document.documentElement.clientWidth,
      pageScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  }, undefined);

async function shot(page: RenderedPage, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, `${name}.png`));
}

describeRendered("Overview Crew with enlarged text", () => {
  it.each([
    ["mixed", true],
    ["mixed", false],
    ["long", true],
  ] as const)(
    "keeps headings, state words and readings whole at 200%% text, %s crew, dark=%s",
    async (scenario, dark) => {
      const normal = await open(scenario, 1920, 1080, dark, false);
      const base = await measure(normal);
      const page = await open(scenario, 1920, 1080, dark, true);
      await page.evaluate(
        () => document.querySelector("#text-enlargement")?.id ?? "missing",
        undefined,
      );
      const m = await measure(page);
      expect(page.errors()).toEqual([]);
      expect(m.cuts).toEqual({ head: 0, state: 0, pill: 0, numbers: 0 });
      expect(m.rowsOverlap).toBe(0);
      // Nothing is dropped: the same rows, headings, state words, reasons and readings.
      expect(m.rowCount).toBe(base.rowCount);
      expect(m.rowCount).toBeGreaterThanOrEqual(10);
      expect(m.texts).toEqual(base.texts);
      expect(m.headTexts).toEqual(base.headTexts);
      expect(m.stateWords).toEqual(base.stateWords);
      expect(m.stateTitles).toEqual(base.stateTitles);
      expect(m.stateWords.every((word) => word.length > 0)).toBe(true);
      // The table, not the page, takes the extra width, and says so with a visible scrollbar.
      // Crew keeps inside the page and scrolls within itself. Another panel may still widen the page.
      expect(m.crewRight).toBeLessThanOrEqual(m.viewRight + 1);
      expect(m.scrollsSideways).toBeGreaterThan(0);
      expect(m.overflowX).toBe("auto");
      // The "Scroll ↔" note tells a person the table moves sideways.
      expect(m.noteText).toContain("Scroll ↔");
      await shot(page, `crew-text200-${scenario}-${dark ? "dark" : "light"}-1920x1080`);
    },
    90_000,
  );

  it("shows the loops and every crew row, and its last row and action are reachable", async () => {
    const page = await open("mixed", 1920, 1080, false, true);
    const m = await page.evaluate(() => {
      const region = document.querySelector<HTMLElement>("#agentsList");
      if (!region) throw Error("no Crew table");
      const rows = [...region.querySelectorAll<HTMLElement>(".trow:not(.head)")];
      const last = rows.at(-1);
      if (!last) throw Error("no rows");
      last.scrollIntoView({ block: "end" });
      region.scrollLeft = region.scrollWidth;
      const box = region.getBoundingClientRect();
      const lastCell = [...last.children].filter((c) => c.getBoundingClientRect().width > 0).at(-1);
      const cell = lastCell?.getBoundingClientRect();
      const probe = cell
        ? document.elementFromPoint(cell.left + cell.width / 2, cell.top + cell.height / 2)
        : null;
      return {
        names: rows.map((row) => row.textContent ?? "").join(" "),
        cellInside:
          !!cell &&
          cell.right <= box.right + 1 &&
          cell.left >= box.left &&
          cell.bottom <= box.bottom + 1,
        painted: !!lastCell && !!probe && lastCell.contains(probe),
      };
    }, undefined);
    expect(m.names).toContain("loop-alpha");
    expect(m.names).toContain("loop-beta");
    expect(m.cellInside).toBe(true);
    expect(m.painted).toBe(true);
  }, 90_000);

  it("holds the State and Seat cells and the header while the table scrolls", async () => {
    const page = await open("mixed", 1920, 1080, true, true);
    const m = await page.evaluate(async () => {
      const region = document.querySelector<HTMLElement>("#agentsList");
      if (!region) throw Error("no Crew table");
      const row = region.querySelector<HTMLElement>(".trow:not(.head)");
      const head = region.querySelector<HTMLElement>(".trow.head");
      if (!row || !head) throw Error("no rows");
      const at = (el: Element | undefined) => el?.getBoundingClientRect();
      const before = { state: at(row.children[0])?.left, seat: at(row.children[1])?.left };
      region.scrollLeft = region.scrollWidth;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      region.scrollTop = region.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const after = { state: at(row.children[0])?.left, seat: at(row.children[1])?.left };
      return {
        scrolled: region.scrollLeft,
        before,
        after,
        headStuck:
          Math.abs((at(head)?.top ?? Number.NaN) - region.getBoundingClientRect().top) <= 1,
      };
    }, undefined);
    expect(m.scrolled).toBeGreaterThan(0);
    // Row cells stay where they were at the left edge of the scrolled table.
    expect(m.after.state).toBeCloseTo(m.before.state ?? Number.NaN, 0);
    expect(m.after.seat).toBeCloseTo(m.before.seat ?? Number.NaN, 0);
    expect(m.headStuck).toBe(true);
  }, 90_000);

  it("brings a focused control out from under the held cells and paints it", async () => {
    const page = await open("mixed", 1920, 1080, false, true);
    const m = await page.evaluate(async () => {
      const region = document.querySelector<HTMLElement>("#agentsList");
      if (!region) throw Error("no Crew table");
      const rows = [...region.querySelectorAll<HTMLElement>(".trow:not(.head)")];
      const control = rows
        .flatMap((row) => [...row.querySelectorAll<HTMLElement>("a[href], button")])
        .find((el) => !el.closest(".trow > :nth-child(-n + 2)"));
      if (!control) return null;
      const row = control.closest<HTMLElement>(".trow");
      const held = [...(row?.children ?? [])].slice(0, 2);
      row?.scrollIntoView({ block: "nearest" });
      region.scrollLeft = region.scrollWidth;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      control.focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const box = control.getBoundingClientRect();
      const view = region.getBoundingClientRect();
      const heldRight = Math.max(...held.map((cell) => cell.getBoundingClientRect().right));
      const probe = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        clearOfHeld: box.left >= heldRight - 1,
        insideRight: box.right <= view.right + 1,
        painted: !!probe && control.contains(probe),
        focused: document.activeElement === control,
      };
    }, undefined);
    expect(m).toEqual({ clearOfHeld: true, insideRight: true, painted: true, focused: true });
    await shot(page, "crew-text200-focused-control-light-1920x1080");
  }, 90_000);

  it("opens the complete Agent detail from the focused row link with Enter", async () => {
    const page = await open("mixed", 1920, 1080, false, true);
    const target = await page.evaluate(() => {
      const link = [...document.querySelectorAll<HTMLAnchorElement>("#agentsList a.rowlink")].at(0);
      if (!link) return null;
      link.focus();
      return { focused: document.activeElement === link, path: new URL(link.href).pathname };
    }, undefined);
    expect(target?.focused).toBe(true);
    await page.press("Enter");
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)), undefined);
    expect(await page.evaluate(() => location.pathname, undefined)).toBe(target?.path);
    // The enlargement is still in the document the detail opened in.
    expect(
      await page.evaluate(() => !!document.querySelector("#text-enlargement"), undefined),
    ).toBe(true);
  }, 90_000);
});

describeRendered("Overview Crew held cells and keyboard at enlarged text", () => {
  it("covers the whole row beside and above the held cells while the table is scrolled", async () => {
    const page = await open("mixed", 1920, 1080, false, true);
    const m = await page.evaluate(async () => {
      const region = document.querySelector<HTMLElement>("#agentsList");
      const row = region?.querySelector<HTMLElement>(".trow:not(.head)");
      if (!region || !row) throw Error("no Crew table");
      region.scrollTop = 0;
      region.scrollLeft = 300;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const view = region.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const cellAt = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return [...row.children].findIndex((cell) => !!hit && cell.contains(hit));
      };
      const seat = row.children[1]?.getBoundingClientRect();
      return {
        scrolled: region.scrollLeft,
        // The table's own left edge, mid-row and at the top and bottom of the row.
        left: cellAt(view.left + 4, box.top + box.height / 2),
        leftTop: cellAt(view.left + 4, box.top + 3),
        leftBottom: cellAt(view.left + 4, box.bottom - 3),
        seatTop: seat ? cellAt(seat.left + seat.width / 2, box.top + 3) : -2,
        seatBottom: seat ? cellAt(seat.left + seat.width / 2, box.bottom - 3) : -2,
      };
    }, undefined);
    expect(m.scrolled).toBeGreaterThan(0);
    expect(m).toMatchObject({ left: 0, leftTop: 0, leftBottom: 0, seatTop: 1, seatBottom: 1 });
  }, 90_000);

  it("tabs to the last control, then back up, keeping each in view and clear of the held cells", async () => {
    const page = await open("mixed", 1920, 1080, false, true);
    const found = await page.evaluate(() => {
      const region = document.querySelector<HTMLElement>("#agentsList");
      const controls = [
        ...document.querySelectorAll<HTMLElement>(
          "#agentsList .trow:not(.head) :is(a[href], button)",
        ),
      ];
      const last = controls.at(-1);
      last?.setAttribute("data-last-control", "");
      region?.focus();
      return { count: controls.length, focusedRegion: document.activeElement === region };
    }, undefined);
    expect(found.count).toBeGreaterThan(0);
    expect(found.focusedRegion).toBe(true);
    const state = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const region = document.querySelector<HTMLElement>("#agentsList");
        const control = document.activeElement as HTMLElement | null;
        const row = control?.closest<HTMLElement>(".trow") ?? null;
        if (!region || !control || !row) return null;
        const view = region.getBoundingClientRect();
        const box = control.getBoundingClientRect();
        const head = region.querySelector(".trow.head")?.getBoundingClientRect().bottom ?? 0;
        const held = [...row.children].slice(0, 2);
        const inHeld = held.some((cell) => cell.contains(control));
        const heldRight = Math.max(...held.map((cell) => cell.getBoundingClientRect().right));
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          isLast: control.hasAttribute("data-last-control"),
          rowIndex: [...region.querySelectorAll(".trow")].indexOf(row),
          insideRight: box.right <= view.right + 1,
          clearOfHeld: inHeld || box.left >= heldRight - 1,
          belowHeader: box.top >= head - 1,
          aboveBottom: box.bottom <= view.bottom + 1,
          painted: !!hit && control.contains(hit),
        };
      }, undefined);
    let last: Awaited<ReturnType<typeof state>> = null;
    for (let i = 0; i < 300 && !last?.isLast; i++) {
      await page.press("Tab");
      last = await state();
    }
    expect(last).toMatchObject({
      isLast: true,
      insideRight: true,
      clearOfHeld: true,
      belowHeader: true,
      aboveBottom: true,
      painted: true,
    });
    const lastRow = last?.rowIndex ?? -1;
    let back: Awaited<ReturnType<typeof state>> = null;
    for (let i = 0; i < 300 && (back === null || back.rowIndex === lastRow); i++) {
      await page.press("Shift+Tab");
      back = await state();
    }
    expect(back?.rowIndex).toBeLessThan(lastRow);
    expect(back).toMatchObject({
      insideRight: true,
      clearOfHeld: true,
      belowHeader: true,
      aboveBottom: true,
      painted: true,
    });
  }, 90_000);
});

describeRendered("Overview Crew at normal text keeps its accepted widths", () => {
  const NARROW = [88, 168, 168, 44, 40, 48];
  const WIDE = [88, 168, 224, 52, 52, 52, 40, 60, 48];
  // Work (third track) takes what is left, and Step (fourth) is 104 in both layouts.
  it.each([
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ])(
    "%ix%i: tracks, row height and scrolling are unchanged",
    async (width, height) => {
      const page = await open("mixed", width, height, true, false);
      const m = await measure(page);
      expect(page.errors()).toEqual([]);
      // From 3300 CSS px the interface is zoomed 1.5x, so painted boxes are 1.5x their CSS widths.
      const zoom = width >= 3300 ? 1.5 : 1;
      const tracks = m.tracks.map((px) => Math.round(px / zoom));
      expect(tracks.length === 8 || tracks.length === 11).toBe(true);
      // State reaches 12px left over the row padding and 8px right over the gap to hold its place.
      tracks[0] = (tracks[0] ?? 0) - 20;
      const fixed = tracks.filter((_, i) => i !== 2 && i !== 3);
      expect(fixed).toEqual(tracks.length === 8 ? NARROW : WIDE);
      expect(tracks[3]).toBe(104);
      expect(m.scrollsSideways).toBeLessThanOrEqual(0);
      expect(m.pageScrollX).toBeLessThanOrEqual(0);
      expect(m.cuts).toEqual({ head: 0, state: 0, pill: 0, numbers: 0 });
      // The accepted Overview row is its 40px --table-row plus a 1px border; 32px is the compact
      // token this page does not use. The FLIGHT row, two lines tall, is the tallest at 49px.
      // All headings share one centre line, State and Seat included.
      expect(Math.max(...m.headCentres) - Math.min(...m.headCentres)).toBeLessThanOrEqual(1 * zoom);
      expect(m.tableRow).toBe(40);
      expect(m.minHeights.every((h) => h === m.tableRow)).toBe(true);
      expect(m.tallest / zoom).toBeLessThanOrEqual(49.5);
      // No reserved scrollbar gutter takes width from Crew while it has no vertical overflow.
      expect(m.gutter).toBe(0);
      expect(m.rowWidths.every((w) => w === 0)).toBe(true);
      // The FLIGHT row's held cells paint the row's own tint, not a stronger one.
      expect(m.flight?.held.length).toBe(2);
      for (const image of m.flight?.held ?? []) expect(image).toContain(m.flight?.tint ?? "none");
    },
    90_000,
  );
});
