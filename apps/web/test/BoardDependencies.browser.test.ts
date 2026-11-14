// @vitest-environment node

import type { BoardItem, ChainNode, DependencyChain } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { boardItem, HOUR, prView } from "./fixtures.ts";

const { renderAt } = browserSession();

const node = (ref: string, over: Partial<ChainNode> = {}): ChainNode => ({
  ref,
  title: null,
  edge: "depends",
  waitedMs: 5 * HOUR + 20 * 60_000,
  alsoWaitsOn: [],
  children: [],
  ...over,
});
const chains: DependencyChain[] = [
  {
    repoId: "shop-app",
    root: node("PR 1432", {
      edge: null,
      children: [
        node("shop-app#11", { alsoWaitsOn: ["shop-app#2", "PR 1500"] }),
        node("shop-app#12"),
      ],
    }),
    state: "moving",
    reason: "",
    owner: "retro-1",
    seatId: null,
    longestWaitMs: 5 * HOUR,
    frees: ["shop-app#12", "shop-app#11"],
    stillWaiting: [],
  },
];
const items: BoardItem[] = [
  boardItem({
    issueNumber: 10,
    title: "Fictional root ticket that holds up two others",
    status: "In review",
    state: "in review",
  }),
  boardItem({
    issueNumber: 11,
    title: "Fictional ready ticket with a Depends on line",
    status: "Todo",
    state: "planned",
    after: { issues: [10], prs: [] },
  }),
  boardItem({
    issueNumber: 12,
    title: "Fictional second dependent",
    status: "Todo",
    state: "planned",
    after: { issues: [10], prs: [] },
  }),
];

const SIZES = [
  [1920, 1080],
  [2560, 1440],
] as const;

async function board(width: number, height: number, colorScheme: "light" | "dark") {
  const desk = desktopFixture();
  const page = await renderAt({
    page: "test/desktopBrowser.html",
    width,
    height,
    colorScheme,
    search: "?path=%2Fboard",
    api: {
      ...desk.api,
      "/api/boards/shop-app": items,
      "/api/repos/shop-app/prs?linked=1&shape=summary": [
        prView({ number: 1432, ticket: "shop-app#10" }),
      ],
      "/api/dependencies": chains,
    },
  });
  await page.evaluate(async () => {
    const end = performance.now() + 5000;
    while (!document.querySelector("[data-chip=waits]") && performance.now() < end)
      await new Promise((r) => requestAnimationFrame(r));
    await document.fonts.ready;
  }, undefined);
  return page;
}

describeRendered("Board dependency chips, rendered", () => {
  it.each(SIZES.flatMap(([w, h]) => (["light", "dark"] as const).map((t) => [w, h, t] as const)))(
    "chips read whole and the Depends on tickets sit in Blocked at %ix%i %s",
    async (width, height, theme) => {
      const page = await board(width, height, theme);
      const read = await page.evaluate(
        () => ({
          waits: [...document.querySelectorAll("[data-chip=waits]")].map((e) => e.textContent),
          unblocks: [...document.querySelectorAll("[data-chip=unblocks]")].map(
            (e) => e.textContent,
          ),
          blocked: [
            ...(
              [...document.querySelectorAll(".kcol")].find((c) =>
                c.querySelector(".kh")?.textContent?.startsWith("Blocked"),
              ) ?? document.body
            ).querySelectorAll(".kcard[data-card]"),
          ].map((e) => e.getAttribute("data-card")),
        }),
        undefined,
      );
      expect(read.waits).toEqual([
        "Waits on PR 1432 · In review · 5h 20m +2",
        "Waits on PR 1432 · In review · 5h 20m",
      ]);
      expect(read.unblocks).toEqual(["Unblocks 2"]);
      expect(read.blocked.sort()).toEqual(["shop-app#11", "shop-app#12"]);
      expect(await page.unclipped("[data-chip]")).toEqual([true, true, true]);
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "chips wrap inside a 210 px card and never clip",
    async () => {
      const page = await board(1920, 1080, "dark");
      await page.evaluate(() => {
        for (const c of document.querySelectorAll<HTMLElement>(".kcard"))
          c.style.cssText += "width:210px;max-width:210px;min-width:210px;";
      }, undefined);
      const cards = await page.boxes(".kcard:has([data-chip])");
      const chips = await page.boxes(".kcard [data-chip]");
      expect(chips.length).toBe(3);
      expect(cards.length).toBe(3);
      for (const chip of chips) {
        expect(
          cards.some((c) => chip.x >= c.x - 0.5 && chip.x + chip.width <= c.x + c.width + 0.5),
        ).toBe(true);
      }
      expect(await page.unclipped("[data-chip]")).toEqual([true, true, true]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
