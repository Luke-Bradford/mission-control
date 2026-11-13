// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { EVIDENCE_PAGE_PATHS } from "@mc/core";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;

/** One long, unbroken title: where text can only fit by being cut, it must say so with an ellipsis. */
const LONG_TITLE = `Unbroken${"x".repeat(300)}`;

/** The default desktop fixture, plus what it lacks: a Live log seat link and a very long title. */
function polishApi() {
  const api = desktopFixture().api;
  const crew = api["/api/crew?shape=summary"] as { rows: Record<string, unknown>[] };
  crew.rows[1] = { ...crew.rows[1], ticketTitle: LONG_TITLE };
  api["/api/activity"] = [
    {
      runId: "run-1",
      at: NOW - 60_000,
      who: "guido-1",
      kind: "run-start",
      text: "started shop-app#101",
      ref: "shop-app#101",
      url: null,
      status: null,
      prs: [],
      summary: null,
    },
    {
      at: NOW - 120_000,
      who: "guido-2",
      kind: "state",
      text: LONG_TITLE,
      ref: null,
      url: null,
      status: null,
      prs: [],
      summary: null,
    },
  ];
  return api;
}

describeRendered("Polish list, part two: fit at 1920x940", () => {
  it(
    "clips no text without an ellipsis on any evidence page",
    async () => {
      const clipped: string[] = [];
      for (const path of Object.values(EVIDENCE_PAGE_PATHS)) {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1920,
          height: 940,
          search: `?path=${encodeURIComponent(path)}`,
          api: polishApi(),
        });
        try {
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }, undefined);
          const found = await page.evaluate(() => {
            const out: string[] = [];
            const hides = (v: string) => v === "hidden" || v === "clip";
            const scrolls = (v: string) => v === "auto" || v === "scroll";
            for (const el of document.querySelectorAll<HTMLElement>("body *")) {
              if (el.closest(".sr-only")) continue;
              const own = [...el.childNodes].filter(
                (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
              );
              if (own.length === 0) continue;
              const range = document.createRange();
              range.setStartBefore(own[0] as Node);
              range.setEndAfter(own[own.length - 1] as Node);
              const text = range.getBoundingClientRect();
              if (text.width === 0 || text.height === 0) continue;
              let xScrolls = false;
              let yScrolls = false;
              let ellipsis = false;
              let clippedBy: Element | null = null;
              for (let a: HTMLElement | null = el; a && a !== document.body; a = a.parentElement) {
                const s = getComputedStyle(a);
                if (s.textOverflow === "ellipsis") ellipsis = true;
                if (s.getPropertyValue("-webkit-line-clamp") !== "none") ellipsis = true;
                if (scrolls(s.overflowX)) xScrolls = true;
                if (scrolls(s.overflowY)) yScrolls = true;
                const box = a.getBoundingClientRect();
                // the text is cut where it passes a box that hides what overflows it
                const past =
                  (!xScrolls &&
                    hides(s.overflowX) &&
                    (text.right > box.right + 1 || text.left < box.left - 1)) ||
                  (!yScrolls &&
                    hides(s.overflowY) &&
                    (text.bottom > box.bottom + 1 || text.top < box.top - 1));
                if (past) {
                  clippedBy = a;
                  break;
                }
              }
              if (clippedBy && !ellipsis) {
                out.push(
                  `${el.tagName.toLowerCase()}.${el.className}: ${el.textContent?.trim().slice(0, 40)}`,
                );
              }
            }
            return out;
          }, undefined);
          clipped.push(...found.map((f) => `${path} ${f}`));
        } finally {
          await page.close();
        }
      }
      expect(clipped).toEqual([]);
    },
    BROWSER_TEST_TIMEOUT_MS * 8,
  );

  for (const scheme of ["light", "dark"] as const) {
    it(
      `makes every Overview control at least 24x24, the Live log seat links included, and keeps the chat clear of its right column: ${scheme}`,
      async () => {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1920,
          height: 940,
          colorScheme: scheme,
          api: polishApi(),
        });
        try {
          await page.boxes("#page-overview");
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }, undefined);
          const result = await page.evaluate(() => {
            const visible = (el: Element) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            };
            const controls = [
              ...document.querySelectorAll(
                "#page-overview button, #page-overview a[href], #page-overview summary, #page-overview input, #page-overview select",
              ),
            ].filter(visible);
            const small = controls
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return r.width < 24 || r.height < 24;
              })
              .map((el) => `${el.tagName.toLowerCase()}: ${el.textContent?.trim().slice(0, 40)}`);
            const right = document.querySelector(".overview-secondary")?.getBoundingClientRect();
            const covering = [
              ...document.querySelectorAll<HTMLElement>(".comms-bell, #dock, .dockrail"),
            ]
              .filter(visible)
              .filter((el) => {
                const r = el.getBoundingClientRect();
                return (
                  right !== undefined &&
                  r.left < right.right &&
                  r.right > right.left &&
                  r.top < right.bottom &&
                  r.bottom > right.top
                );
              })
              .map((el) => el.className || el.id);
            return {
              small,
              covering,
              seatLinks: document.querySelectorAll("#actList .log-who a[href]").length,
            };
          }, undefined);
          // the seat link is only measured if the fixture draws one
          expect(result.seatLinks).toBeGreaterThan(0);
          expect(result.small).toEqual([]);
          expect(result.covering).toEqual([]);
          expect(page.errors()).toEqual([]);
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "keeps a very long private path inside the ticket pane at 1600 px",
    async () => {
      const path = `file:///Users/someone/Dev/some-project/docs/prototype/${"nested/".repeat(40)}mockup.html?state=${"x".repeat(120)}`;
      const api = polishApi();
      api["/api/boards/shop-app/items/3349"] = {
        number: 3349,
        title: "Quote cache",
        url: "https://github.com/octo-org/shop-app/issues/3349",
        state: "open",
        body: `Prototype: ${path}`,
        bodyTruncated: false,
        prototypeProblem: "links a prototype outside docs/prototype/.",
        labels: [],
        milestone: null,
        subIssues: [],
        pullRequests: [],
      };
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1600,
        height: 900,
        search: `?path=${encodeURIComponent("/board/shop-app/3349")}`,
        api,
      });
      try {
        await page.boxes(".tprivate");
        const fit = await page.evaluate(() => {
          const pane = document.querySelector(".tdetail") as HTMLElement;
          const note = document.querySelector(".tprivate") as HTMLElement;
          return {
            paneScroll: pane.scrollWidth,
            paneClient: pane.clientWidth,
            noteRight: note.getBoundingClientRect().right,
            paneRight: pane.getBoundingClientRect().right,
          };
        }, undefined);
        expect(fit.paneScroll).toBe(fit.paneClient);
        expect(fit.noteRight).toBeLessThanOrEqual(fit.paneRight);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot(join(evidence, "ticket-private-link-1600.png"));
        }
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
