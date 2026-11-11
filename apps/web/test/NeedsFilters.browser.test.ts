// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { brief, HOUR, item, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR;

/** Hours until FLIGHT applies its default; the older question 4 is due after question 2. */
const DEADLINES: Record<number, number> = { 2: 1, 4: 3 };

const question = (n: number, over = {}) =>
  item({
    key: `question:q${n}`,
    kind: "question",
    escalationId: null,
    ticket: `shop-app#${4000 + n}`,
    repoId: n % 2 ? "shop-app" : "other-app",
    text: `Question ${n}: which option should the team take for item ${n}?`,
    at: NOW - (n + 1) * HOUR,
    brief: brief({ recommendedOptionId: "a", options: [{ id: "a", label: "A", answer: "A" }] }),
    ...over,
  });

function api(opts: { alert: boolean; count?: number }) {
  const questions = Array.from({ length: opts.count ?? 14 }, (_, i) =>
    question(i + 1, DEADLINES[i + 1] ? { defaultDueAt: NOW + DEADLINES[i + 1] * HOUR } : {}),
  );
  const alerts = opts.alert
    ? [
        item({
          key: "note:hub-update-held",
          kind: "approval",
          alert: true,
          agentId: null,
          escalationId: null,
          ticket: null,
          text: "The hub update is held until you release it.",
        }),
      ]
    : [];
  const wake = item({
    key: "flight:wake:r1:3",
    kind: "message",
    owner: "flight",
    text: "Wake reminder: FLIGHT left a wake undecided.",
  });
  return {
    ...desktopFixture().api,
    "/api/attention": [...alerts, wake, ...questions],
    "/api/attention/held": [],
    "/api/notifications": { open: [], handledToday: [] },
  };
}

const ready = async (page: RenderedPage) => {
  await page.boxes("#page-needs .needs-row");
  await page.evaluate(async () => {
    await document.fonts.ready;
  }, undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
};

/** Set a control the way a person does, so React sees the change. */
const setControl = (page: RenderedPage, label: string, value: string) =>
  page.evaluate(
    ({ label, value }) => {
      const el = [...document.querySelectorAll<HTMLElement>(".needs-control")]
        .find((l) => l.textContent?.startsWith(label))
        ?.querySelector<HTMLInputElement | HTMLSelectElement>("input,select");
      if (!el) throw new Error(`no control ${label}`);
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
      el.dispatchEvent(
        new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    },
    { label, value },
  );

const rows = (page: RenderedPage) =>
  page.evaluate(
    () => [...document.querySelectorAll(".needs-list .needs-row-text")].map((e) => e.textContent),
    undefined,
  );

describeRendered("Needs you filters, orders and alerts", () => {
  it(
    "the Alerts chip appears with an alert, opens it, and is absent without one",
    async () => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 900,
        api: api({ alert: true }),
      });
      try {
        await ready(page);
        expect(
          await page.evaluate(() => document.querySelector(".needs-count")?.textContent, undefined),
        ).toBe("14 open questions");
        await page.click("[data-testid=alerts-chip]");
        expect(
          await page.evaluate(() => decodeURIComponent(location.pathname), undefined),
        ).toContain("note:hub-update-held");
        expect(
          await page.evaluate(
            () => document.body.textContent?.includes("Wake reminder"),
            undefined,
          ),
        ).toBe(false);
      } finally {
        await page.close();
      }
      const quiet = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 900,
        api: api({ alert: false }),
      });
      try {
        await ready(quiet);
        expect(
          await quiet.evaluate(
            () => document.querySelector("[data-testid=alerts-chip]") === null,
            undefined,
          ),
        ).toBe(true);
      } finally {
        await quiet.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "filters by text and repo, and orders oldest, newest and soonest deadline",
    async () => {
      const page = await renderAt({
        page: "test/needsBrowser.html",
        width: 1600,
        height: 900,
        api: api({ alert: false }),
      });
      try {
        await ready(page);
        await setControl(page, "Search", "item 7:");
        await setControl(page, "Search", "Question 7");
        expect(await rows(page)).toHaveLength(1);
        await setControl(page, "Search", "");
        await setControl(page, "Repo", "other-app");
        expect((await rows(page)).length).toBe(7);
        await setControl(page, "Repo", "");
        await setControl(page, "Order", "newest");
        expect((await rows(page))[0]).toContain("Question 1:");
        await setControl(page, "Order", "oldest");
        expect((await rows(page))[0]).toContain("Question 14:");
        await setControl(page, "Order", "deadline");
        // FLIGHT-default group: question 2 is due first, though question 4 is older
        const due = await rows(page);
        expect(due.findIndex((t) => t?.includes("Question 2:"))).toBeLessThan(
          due.findIndex((t) => t?.includes("Question 4:")),
        );
        await setControl(page, "Order", "default");
        const dflt = await rows(page);
        expect(dflt.findIndex((t) => t?.includes("Question 4:"))).toBeLessThan(
          dflt.findIndex((t) => t?.includes("Question 2:")),
        );
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "captures busy Needs you in light and dark",
    async () => {
      for (const scheme of ["light", "dark"] as const) {
        for (const [width, height] of [
          [1280, 800],
          [1600, 900],
          [1920, 940],
          [1600, 700],
        ] as const) {
          const page = await renderAt({
            page: "test/needsBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api({ alert: true, count: 50 }),
          });
          try {
            await ready(page);
            await page.boxes(".needs-controls");
            const list = await page.box(".needs-list");
            expect(
              list.y + list.height,
              `${width}x${height}: list inside viewport`,
            ).toBeLessThanOrEqual(height + 1);
            if (SHOTS) {
              mkdirSync(SHOTS, { recursive: true });
              await page.screenshot(join(SHOTS, `needs-filters-${width}x${height}-${scheme}.png`));
            }
          } finally {
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );
});
