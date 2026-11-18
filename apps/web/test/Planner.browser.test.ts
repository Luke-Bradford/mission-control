// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "planner-shots");

// Mockups are full-size: a 1x1 picture would hide how far they push the decision down the page.
const MOCKUP_SVG = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="${fill}"/></svg>`;
const ASSETS = Object.fromEntries(
  [
    ["d", "#8aa"],
    ["e", "#a8a"],
  ].map(([c, fill]) => [
    `/api/qa-report-assets/${c.repeat(64)}`,
    { contentType: "image/svg+xml", body: MOCKUP_SVG(fill) },
  ]),
);
const picture = (c: string, caption: string) => ({
  url: `/api/qa-report-assets/${c.repeat(64)}`,
  caption,
});
const base = {
  repoId: "shop-app",
  asks: "Failed payment webhooks are dropped, so paid orders stay unpaid.\nRetry them.",
  proposed:
    "Queue each failed webhook and retry with backoff: five tries over an hour. Show the queue in the admin screen so a person can see what is stuck.",
  size: "M",
  risks:
    "A retry could double-charge when the first call did land. The plan checks the payment id first.",
};
const waiting = {
  ...base,
  id: "p1",
  ticket: "shop-app#102",
  title: "Retry failed payment webhooks",
  pictures: [picture("d", "Retry queue in the admin screen"), picture("e", "Empty queue")],
  status: "pending",
};
const sentBack = {
  ...base,
  id: "p2",
  ticket: "shop-app#104",
  title: "Fix the address form on narrow screens",
  pictures: [],
  status: "sent-back",
  note: "Keep the postcode lookup on narrow screens.",
  decidedAt: 1_700_000_000_000,
};
const LONG = `${"A schema-length sentence about the plan. ".repeat(200)}${"x".repeat(400)}`;
const many = {
  pending: Array.from({ length: 50 }, (_, i) => ({
    ...waiting,
    id: `m${i}`,
    ticket: `shop-app#${200 + i}`,
    title: i === 0 ? `${"Very long title ".repeat(20)}end` : `Plan number ${i}`,
  })),
  history: [],
};
const STATES = {
  waiting: { pending: [waiting], history: [] },
  "sent back": { pending: [], history: [sentBack] },
  empty: { pending: [], history: [] },
  "50 waiting": many,
  "long text": {
    pending: [{ ...waiting, asks: LONG, proposed: LONG, risks: LONG }],
    history: [],
  },
} as const;

const SIZES = [
  { width: 1920, height: 940 },
  { width: 2560, height: 1145 },
] as const;

describeRendered("Planner page", () => {
  for (const [state, plans] of Object.entries(STATES)) {
    for (const size of SIZES) {
      for (const colorScheme of ["light", "dark"] as const) {
        it(
          `${state} at ${size.width}x${size.height}, ${colorScheme}: fits, and the plan is not squeezed`,
          async () => {
            mkdirSync(SHOTS, { recursive: true });
            const history = state === "sent back";
            const page = await renderAt({
              page: "test/desktopBrowser.html",
              ...size,
              colorScheme,
              search: `?path=${encodeURIComponent(history ? "/planner?view=history" : "/planner")}`,
              api: {
                ...desktopFixture().api,
                "/api/plans": plans,
              },
              assets: ASSETS,
            });
            try {
              await page.boxes("#page-planner");
              if (state === "empty") {
                expect(
                  await page.evaluate(
                    () => document.querySelector(".uat-empty")?.textContent ?? "",
                    null,
                  ),
                ).toMatch(/No plan is waiting for you/);
              } else {
                const queue = await page.box(".uat-queue");
                const detail = await page.box(".uat-detail");
                // the plan gets the wide column, the queue stays a list
                expect(detail.width).toBeGreaterThan(queue.width * 1.5);
                expect(detail.width).toBeGreaterThan(size.width * 0.5);
                expect(await page.reachable(".plan-parts")).toEqual([true]);
                if (state === "waiting" || state === "50 waiting") {
                  // the risks and the decision are on the first screen, under real-size mockups
                  const onFirstScreen = await page.evaluate(() => {
                    const inView = (el: Element | null) =>
                      !!el && el.getBoundingClientRect().bottom <= window.innerHeight + 0.5;
                    const risks = [...document.querySelectorAll(".plan-parts h3")].find((h) =>
                      /risks/.test(h.textContent ?? ""),
                    );
                    const approve = [...document.querySelectorAll("button")].find(
                      (b) => b.textContent === "Approve",
                    );
                    return {
                      risks: !!risks,
                      approve: inView(approve ?? null),
                      heading: inView(risks ?? null),
                    };
                  }, null);
                  expect(onFirstScreen.risks).toBe(true);
                  expect(onFirstScreen.approve).toBe(true);
                  expect(onFirstScreen.heading).toBe(true);
                  // a long title stays whole in the queue row, and no row runs past the queue
                  expect(
                    await page.evaluate(() => {
                      const q = document.querySelector(".uat-queue")?.getBoundingClientRect();
                      return [...document.querySelectorAll(".uat-queue-row")].every(
                        (r) => !!q && r.getBoundingClientRect().right <= q.right + 0.5,
                      );
                    }, null),
                  ).toBe(true);
                }
                if (state === "waiting") {
                  await page.boxes(".needs-frame img");
                  expect(
                    await page.evaluate(async () => {
                      const imgs = [...document.querySelectorAll<HTMLImageElement>("main img")];
                      const start = performance.now();
                      while (
                        imgs.some((i) => !i.complete || i.naturalWidth === 0) &&
                        performance.now() - start < 2000
                      )
                        await new Promise((r) => setTimeout(r, 50));
                      return imgs.length === 2 && imgs.every((i) => i.naturalWidth > 0);
                    }, null),
                  ).toBe(true);
                  expect(await page.reachable("main button")).not.toContain(false);
                }
              }
              // nothing runs past the window sideways
              expect(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= window.innerWidth,
                  null,
                ),
              ).toBe(true);
              expect(page.errors()).toEqual([]);
              await page.screenshot(
                join(SHOTS, `${state.replace(" ", "-")}-${size.width}-${colorScheme}.png`),
              );
            } finally {
              await page.close();
            }
          },
          BROWSER_TEST_TIMEOUT_MS,
        );
      }
    }
  }
});
