// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GUARD_RULES } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";
import { rulesFixture } from "./rolesRulesFixture.ts";
import { TEMPLATES } from "./templateFixtures.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_ROLES_SHOTS;
const repo = CREW_CONFIG.repos[0]?.id as string;

const api = {
  [RESOURCES.config.path]: {
    ...CREW_CONFIG,
    profiles: { source: "built-in", version: "a".repeat(64), error: null, list: TEMPLATES },
  },
  [RESOURCES.limits.path]: [],
  [RESOURCES.accountStatus.path]: [],
  [RESOURCES.testLock.path]: { holder: null, waiting: [] },
  [RESOURCES.guardHits.path]: {
    hits: [],
    counts: Object.fromEntries(Object.keys(GUARD_RULES).map((r, i) => [r, i % 5])),
  },
  [RESOURCES.repoRules(repo).path]: rulesFixture(repo),
};

/** A protected path far wider than its column: 300 characters with nowhere to break. */
const LONG = `apps/${"a-very-long-folder-name/".repeat(12)}file.ts`;
const longApi = {
  ...api,
  [RESOURCES.repoRules(repo).path]: {
    ...rulesFixture(repo),
    rules: {
      ...rulesFixture(repo).rules,
      protected: { source: "set-here", value: [".github/**", LONG] },
    },
  },
};

const SIZES = [
  [1280, 900],
  [1600, 1000],
  [1920, 940],
  [2560, 1145],
] as const;

describeRendered("Setup › Roles & guards, rendered", () => {
  it(
    "shows Repo rules, Built-in guard and Roles without sideways clipping at 1280, 1600, 1920 and 2560, light and dark",
    async () => {
      for (const [width, height] of SIZES) {
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/setupBrowser.html",
            width,
            height,
            search: "?tab=roles",
            colorScheme,
            api,
          });
          await page.box("#rg-rules [data-key=pick_from]");
          for (const id of ["#rg-rules", "#rg-guard", "#rg-roles"]) {
            const box = await page.box(id);
            expect(box.width, `${id} at ${width}`).toBeGreaterThan(300);
          }
          // the first screen holds the rules, the guard beside them from 1600 px, and the page
          // never scrolls sideways
          const rules = await page.box("#rg-rules");
          const guard = await page.box("#rg-guard");
          if (width >= 1920) expect(guard.x).toBeGreaterThan(rules.x + rules.width - 1);
          expect(
            await page.evaluate(() => {
              const c = document.querySelector(".setup-content") as Element;
              return c.scrollWidth <= c.clientWidth + 1;
            }, null),
          ).toBe(true);
          expect(await page.unclipped("#rg-rules, #rg-guard, #rg-roles")).not.toContain(false);
          // every guard rule shows in full: none is cut short
          expect(
            await page.evaluate(
              () =>
                [...document.querySelectorAll<HTMLElement>("#rg-guard .rg-rule")].filter(
                  (r) => r.scrollHeight > r.clientHeight + 1,
                ).length,
              null,
            ),
            `${width} ${colorScheme}`,
          ).toBe(0);
          // the Seats link and Read prompt button sit in the middle of their row
          const centred = await page.evaluate(() => {
            const bad: string[] = [];
            for (const row of document.querySelectorAll<HTMLElement>("#rg-roles [data-role]")) {
              const r = row.getBoundingClientRect();
              for (const sel of ["td.rg-mid > a", "td.rg-mid > button"]) {
                const el = row.querySelector(sel)?.getBoundingClientRect();
                if (!el) continue;
                const off = Math.abs(el.top + el.height / 2 - (r.top + r.height / 2));
                if (off > 2) bad.push(`${row.dataset.role} ${sel} off by ${off}`);
              }
            }
            return bad;
          }, null);
          expect(centred, `${width} ${colorScheme}`).toEqual([]);
          if (shots && width === 1600) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `roles-guards-1600x1000-${colorScheme}.png`));
          }
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 4,
  );

  it(
    "a rule value too long for its column is reached with Tab and opens in full with Enter",
    async () => {
      const page = await renderAt({
        page: "test/setupBrowser.html",
        width: 1600,
        height: 1000,
        search: "?tab=roles",
        colorScheme: "dark",
        api: longApi,
      });
      const chip = "#rg-rules [data-key=protected] button.rg-chip";
      await page.box(chip);
      const state = () =>
        page.evaluate((css) => {
          const button = document.querySelector(css) as HTMLElement;
          const text = button.querySelector("span") as HTMLElement;
          const panel = document.querySelector("#rg-rules") as HTMLElement;
          return {
            expanded: button.getAttribute("aria-expanded"),
            cut: text.scrollWidth > text.clientWidth + 1,
            height: button.getBoundingClientRect().height,
            text: text.textContent,
            focused: document.activeElement === button,
            inPanel:
              button.getBoundingClientRect().right <= panel.getBoundingClientRect().right + 0.5,
            // the short value beside it fits, so it stays plain text
            plain: document.querySelectorAll("#rg-rules [data-key=protected] span.rg-chip").length,
          };
        }, chip);
      const closed = await state();
      expect(closed).toMatchObject({ expanded: "false", cut: true, plain: 1, inPanel: true });
      expect(closed.height).toBeLessThanOrEqual(24);
      let reached = false;
      for (let i = 0; i < 200 && !reached; i++) {
        await page.press("Tab");
        reached = (await state()).focused;
      }
      expect(reached).toBe(true);
      await page.press("Enter");
      const open = await state();
      // the whole value shows, wrapped inside the panel, and focus stays on the chip
      expect(open).toMatchObject({
        expanded: "true",
        cut: false,
        text: LONG,
        focused: true,
        inPanel: true,
      });
      expect(open.height).toBeGreaterThan(40);
      expect(await page.unclipped("#rg-rules")).not.toContain(false);
      expect(
        await page.evaluate(() => {
          const c = document.querySelector(".setup-content") as Element;
          return c.scrollWidth <= c.clientWidth + 1;
        }, null),
      ).toBe(true);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot(join(shots, "roles-guards-1600x1000-dark-long-value-open.png"));
      }
      await page.press("Enter");
      expect(await state()).toMatchObject({ expanded: "false", cut: true, focused: true });
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "Planned roles shows an arrow that turns when it opens",
    async () => {
      const page = await renderAt({
        page: "test/setupBrowser.html",
        width: 1600,
        height: 1000,
        search: "?tab=roles",
        colorScheme: "dark",
        api,
      });
      await page.box("#rg-roles details.rg-planned summary");
      const arrow = () =>
        page.evaluate(
          () =>
            getComputedStyle(
              document.querySelector("#rg-roles details.rg-planned summary") as Element,
              "::before",
            ).content,
          null,
        );
      expect(await arrow()).toContain("▸");
      await page.click("#rg-roles details.rg-planned summary");
      expect(await arrow()).toContain("▾");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
