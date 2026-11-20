// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { boardItem, HOUR, NOW, prView } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;

const items = [
  boardItem({ issueNumber: 1, title: "Nobody has this one", size: "L", status: "In Progress" }),
  boardItem({ issueNumber: 2, title: "Its PR was closed", status: "Blocked", state: "blocked" }),
  boardItem({
    issueNumber: 3,
    title: "In review, nothing on it",
    status: "In review",
    state: "review",
  }),
  boardItem({ issueNumber: 4, title: "Has an open PR", status: "In review", state: "review" }),
];
const prs = [
  prView({ number: 12, ticket: "shop-app#2", state: "closed", updatedAt: NOW - 30 * HOUR }),
  prView({ number: 14, ticket: "shop-app#4" }),
];

describeRendered("Board cards with nothing working on them, rendered", () => {
  it.each([
    [1920, 940, "light"],
    [1920, 940, "dark"],
    [2560, 1145, "light"],
    [2560, 1145, "dark"],
  ] as const)(
    "say why in one whole line at %ix%i %s",
    async (width, height, scheme) => {
      const fixture = desktopFixture();
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width,
        height,
        colorScheme: scheme,
        search: `?path=${encodeURIComponent("/board")}`,
        api: {
          ...fixture.api,
          "/api/boards/shop-app": items,
          "/api/repos/shop-app/prs?linked=1&shape=summary": prs,
        },
      });
      await page.evaluate(async () => {
        const end = performance.now() + 8000;
        while (!document.querySelector(".kcard") && performance.now() < end)
          await new Promise((r) => requestAnimationFrame(r));
        await document.fonts.ready;
      }, undefined);
      const lines = await page.evaluate(
        () =>
          [...document.querySelectorAll(".kcard")].map((c) => ({
            ref: (c as HTMLElement).dataset.card,
            text: c.querySelector(".overlay")?.textContent ?? "",
          })),
        undefined,
      );
      const by = Object.fromEntries(lines.map((l) => [l.ref, l.text]));
      expect(by["shop-app#1"]).toMatch(/^Nobody on it since \d+ \w+$/);
      expect(by["shop-app#2"]).toMatch(/^PR closed \d+ \w+, nothing open/);
      expect(by["shop-app#3"]).toMatch(/^Nobody on it since/);
      expect(by["shop-app#4"]).not.toMatch(/Nobody|nothing open/);
      expect(JSON.stringify(by)).not.toContain("Handed off");
      expect(await page.unclipped(".kcard .overlay > .xs")).not.toContain(false);
      expect(page.errors()).toEqual([]);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot(join(evidence, `board-idle-${width}-${scheme}.png`));
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
