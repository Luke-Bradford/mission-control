// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "planner-shots");

// The harness serves a PNG for a QA report asset route, so a plan picture uses one.
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
const STATES = {
  waiting: { pending: [waiting], history: [] },
  "sent back": { pending: [], history: [sentBack] },
  empty: { pending: [], history: [] },
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
