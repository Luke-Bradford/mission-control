// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { ticketQaReportFixture } from "./qaReportFixture.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "ticket-page-shots");
const SIZES = [
  { width: 1280, height: 1000 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1000 },
  { width: 1600, height: 700 },
] as const;

const LONG = "A very long unbroken sentence about the cache ".repeat(12);
const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    at: 1_800_000_000_000 - i * 60_000,
    kind: "comms",
    id: `c${i}`,
    from: "flight-1",
    to: "inco-1",
    label: null,
    text: i === 0 ? LONG : `message ${i}`,
  }));
const ticket = (n: number) => ({
  repoId: "shop-app",
  number: 3349,
  url: "https://github.com/octo-org/shop-app/issues/3349",
  title: "Quote cache",
  state: "open",
  status: "In progress",
  priority: "p1",
  size: "M",
  labels: ["perf"],
  outcome: LONG,
  doneWhen: Array.from({ length: n > 0 ? 12 : 2 }, (_, i) => ({
    text: `Item ${i} ${LONG}`,
    checked: i % 2 === 0,
  })),
  body: "x",
  bodyTruncated: false,
  githubError: null,
  runs: [],
  prs: [],
  timeline: events(n),
  nextBefore: null,
});
const qaPr = {
  number: 40,
  title: "Delivered cache",
  url: "https://github.com/octo-org/shop-app/pull/40",
  state: "merged",
  repoId: "shop-app",
};
const SCENARIOS = {
  empty: ticket(0),
  many: ticket(50),
  closedQa: {
    ...ticket(0),
    state: "closed",
    linkedPullRequests: [qaPr],
    prs: [
      {
        ...qaPr,
        branch: "feature/cache",
        isDraft: false,
        headSha: "a".repeat(40),
        createdAt: 1000,
        mergedAt: 2000,
        rounds: [],
        ci: [],
      },
    ],
  },
};

describeRendered("The ticket page in a browser", () => {
  it.each(SIZES)(
    "shows the form and timeline without clipping, at $width×$height",
    async ({ width, height }) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        for (const [name, body] of Object.entries(SCENARIOS)) {
          const page = await renderAt({
            page: "test/ticketBrowser.html",
            width,
            height,
            colorScheme,
            api: {
              "/api/tickets/shop-app/3349": body,
              "/api/config": {
                operator: { timezone: "UTC" },
                repos: [{ id: "shop-app", github: "octo-org/shop-app" }],
              },
              "/api/qa-reports?repoId=shop-app&prNumber=40": {
                reports: [ticketQaReportFixture()],
              },
            },
          });
          const label = `${name} ${colorScheme}`;
          await page.box(".tk-form");
          expect(
            (await page.unclipped(".tk-form .pb, .tk-timeline .pb")).every(Boolean),
            label,
          ).toBe(true);
          expect(
            (await page.reachable(".tk-done li", ".tk-form .pb")).every(Boolean),
            `${label} done`,
          ).toBe(true);
          if (name === "many") {
            expect(
              (await page.reachable(".tk-event", ".tk-timeline .pb")).every(Boolean),
              `${label} events`,
            ).toBe(true);
            const sums = await page.boxes(".tk-more > summary");
            expect(sums.length, label).toBeGreaterThan(0);
            expect(
              sums.every((b) => b.height >= 24 && b.width >= 24),
              `${label} targets`,
            ).toBe(true);
          } else if (name === "empty") {
            await page.box(".tk-timeline .muted"); // the empty line is shown
          }
          if (name === "closedQa") {
            const link = await page.box(".ticket-qa-link");
            expect(link.height).toBeGreaterThanOrEqual(24);
            expect((await page.box(".tk-prs a")).height).toBeGreaterThanOrEqual(24);
            expect((await page.reachable(".ticket-qa-link", ".tk-form .pb")).every(Boolean)).toBe(
              true,
            );
            expect((await page.unclipped(".ticket-qa")).every(Boolean)).toBe(true);
          }
          const form = await page.box(".tk-form");
          const line = await page.box(".tk-timeline");
          expect(form.x, label).toBeLessThan(line.x);
          await page.screenshot(
            join(SHOTS, `ticket-${name}-${colorScheme}-${width}x${height}.png`),
          );
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );
});
