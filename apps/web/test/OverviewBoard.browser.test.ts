// @vitest-environment node

import { expect, it } from "vitest";
import { SCROLL_SLACK_PX } from "../src/overview/useListFit.ts";
import { browserSession, describeRendered, type RenderedPage } from "./browserRunner.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();

async function open(width: number, height: number, dark = true) {
  const page = await renderAt({
    page: "test/overviewDensityBrowser.html",
    width,
    height,
    colorScheme: dark ? "dark" : "light",
    api: overviewDensityFixture("busy").api,
  });
  await page.evaluate(async () => {
    const deadline = performance.now() + 5000;
    while (!document.querySelector(".board-card") && performance.now() < deadline)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, undefined);
  return page;
}

/** Every card or row whose box is not inside its container's box (a part of it is cut off). */
const cut = (page: RenderedPage, container: string, item: string) =>
  page.evaluate(
    ({ container, item }) =>
      [...document.querySelectorAll(container)].flatMap((box) => {
        const outer = box.getBoundingClientRect();
        return [...box.querySelectorAll(item)]
          .filter((child) => {
            const r = child.getBoundingClientRect();
            return r.height > 0 && (r.bottom > outer.bottom + 1 || r.top < outer.top - 1);
          })
          .map((child) => child.textContent?.slice(0, 40) ?? "");
      }),
    { container, item },
  );

describeRendered("Overview Board at the real sizes", () => {
  it.each([
    [1920, 940],
    [2560, 1145],
    [2560, 1250],
  ])(
    "shows whole cards and log rows at %ix%i, with no scrollbar for a sliver",
    async (width, height) => {
      const page = await open(width, height);
      expect(page.errors()).toEqual([]);
      expect(await cut(page, ".board-cards", ".board-card")).toEqual([]);
      expect(await cut(page, "#actList", ".arow")).toEqual([]);
      // A card whose ticket is in Done is not in review as well.
      const reviewTickets = await page.evaluate(
        () =>
          [...document.querySelectorAll(".board-stage.review .board-ticket")].map(
            (el) => el.textContent,
          ),
        undefined,
      );
      expect(reviewTickets).not.toContain("#231");
      // No list scrolls for less than the slack.
      const overflows = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("#page-overview *")]
            .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY))
            .map((el) => el.scrollHeight - el.clientHeight)
            .filter((over) => over > 1),
        undefined,
      );
      for (const over of overflows) expect(over).toBeGreaterThanOrEqual(SCROLL_SLACK_PX);
    },
    60_000,
  );

  it("shows at least three whole cards in each busy stage at 1920x940", async () => {
    const page = await open(1920, 940);
    const counts = await page.evaluate(
      () =>
        [...document.querySelectorAll(".board-stage:not(.empty)")].map((stage) => ({
          name: stage.getAttribute("aria-label"),
          total: Number(stage.querySelector("h3 .num")?.textContent),
          cards: stage.querySelectorAll(".board-card").length,
        })),
      undefined,
    );
    for (const stage of counts) {
      // A stage with fewer tickets than three shows them all.
      expect(stage.cards, stage.name ?? "").toBeGreaterThanOrEqual(Math.min(3, stage.total));
    }
  }, 60_000);

  it("leaves no body on an empty stage and gives it only its head's width", async () => {
    const page = await open(1920, 940);
    const merging = await page.evaluate(() => {
      const stage = document.querySelector(".board-stage.merging") as HTMLElement;
      const ready = document.querySelector(".board-stage.ready") as HTMLElement;
      return {
        body: stage.querySelector(".board-cards"),
        text: stage.textContent,
        width: stage.getBoundingClientRect().width,
        busy: ready.getBoundingClientRect().width,
      };
    }, undefined);
    expect(merging.body).toBeNull();
    expect(merging.text).not.toContain("No tickets here");
    expect(merging.width).toBeLessThan(merging.busy / 2);
  }, 60_000);

  it("keeps the stage heads apart at 1600x1000", async () => {
    const page = await open(1600, 1000);
    const heads = await page.evaluate(
      () =>
        [...document.querySelectorAll(".board-stage > h3 > *")].map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
      undefined,
    );
    for (const [i, a] of heads.entries())
      for (const b of heads.slice(i + 1)) {
        const apart =
          a.right <= b.left + 0.5 ||
          b.right <= a.left + 0.5 ||
          a.bottom <= b.top + 0.5 ||
          b.bottom <= a.top + 0.5;
        expect(apart).toBe(true);
      }
  }, 60_000);
});
