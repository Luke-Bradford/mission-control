// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItem, CrewRow, OverviewSummary } from "@mc/core";
import { expect, it } from "vitest";
import { SCROLL_SLACK_PX } from "../src/overview/useListFit.ts";
import { browserSession, describeRendered, type RenderedPage } from "./browserRunner.ts";
import { item } from "./fixtures.ts";
import { overviewDensityFixture } from "./overviewDensityFixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;

/** Saves a screenshot when the run is collecting QA evidence; the files are named by size and state. */
async function capture(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}

async function open(
  width: number,
  height: number,
  options: {
    dark?: boolean;
    scenario?: "busy" | "empty";
    wideBusy?: boolean;
    /** A row paused by this issue; `decision` adds a loop-owned decision to its card. */
    pausedBy?: { by: string; decision: boolean };
  } = {},
) {
  const fixture = overviewDensityFixture(options.scenario ?? "busy");
  let api: Record<string, unknown> = fixture.api;
  if (options.pausedBy) {
    const { by, decision } = options.pausedBy;
    const crew = api["/api/crew?shape=summary"] as { rows: CrewRow[] };
    const target = crew.rows.find((r) => r.id === "dev-1");
    if (!target) throw new Error("the density fixture has no dev-1 row");
    const paused: CrewRow = {
      ...target,
      hudState: "parked",
      paused: true,
      pausedBy: by,
      pausedByUrl: `https://github.com/acme/${by.replace("#", "/issues/")}`,
    };
    const attention = (api["/api/attention"] as AttentionItem[]).filter(
      (entry) => entry.agentId !== target.id,
    );
    if (decision)
      attention.push(
        item({
          key: `esc:${by}`,
          escalationId: by,
          ticket: by,
          owner: "loop",
          kind: "decision",
          agentId: target.id,
        }),
      );
    api = {
      ...api,
      "/api/crew?shape=summary": {
        ...crew,
        rows: crew.rows.map((r) => (r === target ? paused : r)),
      },
      "/api/attention": attention,
    };
  }
  if (options.wideBusy) {
    // In review holds 8 tickets and Merging 3: the case that used to leave review no card.
    const base = fixture.api["/api/overview"] as OverviewSummary;
    const card = (ticket: number) => ({
      ...base.pipeline[3].cards[0],
      ticket,
      // Its own pull request: one that is in Done would take the card out of review.
      pr: 2000 + ticket,
      title: `Ticket ${ticket}`,
    });
    const summary: OverviewSummary = {
      ...base,
      pipeline: base.pipeline.map((stage) =>
        stage.stage === "review"
          ? { ...stage, count: 8, cards: Array.from({ length: 8 }, (_, i) => card(300 + i)) }
          : stage.stage === "merging"
            ? {
                ...stage,
                count: 3,
                oldestAt: base.pipeline[3].oldestAt,
                cards: [310, 311, 312].map(card),
              }
            : stage,
      ),
    };
    api = { ...api, "/api/overview": summary, "/api/overview?session=demo": summary };
  }
  const page = await renderAt({
    page: "test/overviewDensityBrowser.html",
    width,
    height,
    colorScheme: options.dark === false ? "light" : "dark",
    api,
  });
  await page.evaluate(async () => {
    const deadline = performance.now() + 5000;
    while (!document.querySelector("#agentsList .trow:not(.head)") && performance.now() < deadline)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, undefined);
  return page;
}

/**
 * Every card or row that shows but is cut by its container's foot: it starts inside the box and ends
 * past it. A row wholly below the box in a list that scrolls is out of view, not cut.
 */
const cut = (page: RenderedPage, container: string, item: string) =>
  page.evaluate(
    ({ container, item }) =>
      [...document.querySelectorAll(container)].flatMap((box) => {
        const outer = box.getBoundingClientRect();
        return [...box.querySelectorAll(item)]
          .filter((child) => {
            const r = child.getBoundingClientRect();
            return (
              r.height > 0 &&
              r.top < outer.bottom &&
              (r.bottom > outer.bottom + 1 || r.top < outer.top - 1)
            );
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

  it("measures again when a card grows after it was measured", async () => {
    const page = await open(1920, 940);
    // A taller meta line, as when more checks register or an owner joins.
    await page.evaluate(async () => {
      const card = document.querySelector(".board-stage.progress .board-card");
      const extra = document.createElement("div");
      extra.style.height = "60px";
      card?.append(extra);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, undefined);
    expect(await cut(page, ".board-cards", ".board-card")).toEqual([]);
  }, 60_000);

  it.each([
    [2560, 1145],
    [2560, 1250],
  ])(
    "gives In review and Merging each their own whole cards at %ix%i with 8 and 3 tickets",
    async (width, height) => {
      const page = await open(width, height, { wideBusy: true });
      const shown = await page.evaluate(
        () => ({
          review: document.querySelectorAll(".board-stage.review .board-card").length,
          merging: document.querySelectorAll(".board-stage.merging .board-card").length,
        }),
        undefined,
      );
      expect(shown.review).toBeGreaterThanOrEqual(2);
      expect(shown.merging).toBeGreaterThanOrEqual(1);
      expect(await cut(page, ".board-cards", ".board-card")).toEqual([]);
    },
    60_000,
  );

  it.each([
    [1920, 940],
    [2560, 1145],
    [2560, 1250],
  ])(
    "saves screenshots at %ix%i, busy and quiet, FLIGHT folded and open",
    async (width, height) => {
      for (const scenario of ["busy", "empty"] as const) {
        const page = await open(width, height, { scenario });
        // From 2200 px the dock is open by default; below, it starts folded.
        if (width < 2200) {
          await capture(page, `overview-board-${width}x${height}-${scenario}-folded`);
          await page.click(".dockrail button");
          await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)), undefined);
        }
        await capture(page, `overview-board-${width}x${height}-${scenario}-open`);
        expect(page.errors()).toEqual([]);
      }
    },
    120_000,
  );

  const LONG_REPO = `${"long-repository-name-".repeat(6)}x`.slice(0, 114);
  it.each([
    ["a short repo", "shop-app#4321", false],
    ["a 120-character repo", `${LONG_REPO}#4321`, false],
    ["a loop-owned decision on the card", "shop-app#4321", true],
  ] as const)(
    "shows the pause line for %s as a 24 px link, clipped with its full text in the title",
    async (name, by, decision) => {
      for (const width of [1280, 1600])
        for (const dark of [false, true]) {
          const page = await open(width, 900, { dark, pausedBy: { by, decision } });
          const found = await page.evaluate((ref) => {
            const link = document.querySelector<HTMLElement>(
              `#agentsList .work-cell a[href$="/issues/4321"]`,
            );
            if (!link) return null;
            link.scrollIntoView({ block: "center" });
            const line = link.closest<HTMLElement>("span.ellip");
            const cell = link.closest<HTMLElement>(".work-cell");
            const box = link.getBoundingClientRect();
            const room = cell?.getBoundingClientRect();
            // A part is visible when it has width and sits inside the cell, so no clip hides it.
            const shown = (part: Element | null | undefined) => {
              const rect = part?.getBoundingClientRect();
              return (
                !!rect &&
                !!room &&
                rect.width > 0 &&
                rect.left >= room.left &&
                rect.right <= room.right + 0.5
              );
            };
            const parts = [...(line?.children ?? [])];
            const pauseLabel = parts.find((part) => part.textContent?.trim() === "Paused by");
            const last = parts.find((part) => part.textContent?.includes("last #"));
            const refText = link.querySelector<HTMLElement>(".pause-ref");
            const middle = (part: Element | null | undefined) => {
              const rect = part?.getBoundingClientRect();
              return rect ? rect.top + rect.height / 2 : Number.NaN;
            };
            return {
              refCut: !!refText && refText.scrollWidth > refText.clientWidth,
              // the link's text is level with the words beside it
              levelGap: Math.abs(middle(refText) - middle(pauseLabel)),
              labelShown: shown(pauseLabel),
              lastShown: shown(last),
              lastText: last?.textContent ?? "",
              width: box.width,
              height: box.height,
              startsInside: !!room && box.left >= room.left && box.left < room.right,
              clipped: !!line && line.scrollWidth > line.clientWidth,
              title: line?.title ?? "",
              cell: cell?.textContent ?? "",
              href: link.getAttribute("href"),
              target: link.getAttribute("target"),
              ref,
            };
          }, by);
          const label = `${name} at ${width} ${dark ? "dark" : "light"}`;
          expect(found, label).not.toBeNull();
          expect(found?.width, label).toBeGreaterThanOrEqual(24);
          expect(found?.height, label).toBeGreaterThanOrEqual(24);
          expect(found?.startsInside, label).toBe(true);
          expect(found?.target, label).toBe("_blank");
          expect(found?.cell, label).toContain("Paused by");
          // The long reference shortens by itself; "Paused by" and "· last #N" stay whole.
          expect(found?.labelShown, label).toBe(true);
          expect(found?.lastShown, label).toBe(true);
          expect(found?.lastText, label).toMatch(/last #\d+/);
          expect(found?.levelGap, label).toBeLessThanOrEqual(2);
          if (name === "a 120-character repo") expect(found?.refCut, label).toBe(true);
          // When the line is cut with an ellipsis, the tooltip still holds the whole reference.
          if (found?.clipped) expect(found.title, label).toContain(by);
          if (decision) expect(found?.cell, label).toContain("Decision for");
          await capture(
            page,
            `overview-paused-by-${name.replace(/[^a-z0-9]+/gi, "-")}-${width}-${dark ? "dark" : "light"}`,
          );
          expect(page.errors(), label).toEqual([]);
        }
    },
    180_000,
  );
});
