// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

const PAGE = "test/setupRolesGuardsMockupBrowser.html";
const REPOS = ["demo-app", "demo-site"] as const;
const THEMES = ["light", "dark"] as const;
const STATES = ["normal", "loading", "empty", "long", "error", "stale", "disconnected", "conflict"];
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [1280, 900],
  [1600, 1000],
  [1920, 940],
  [2560, 1145],
];

/** Runs in the page, so it uses nothing from this file. */
const measure = () => {
  const root = document.scrollingElement ?? document.documentElement;
  const panels = [...document.querySelectorAll<HTMLElement>(".panel")];
  return {
    panels: panels.length,
    sideways: root.scrollWidth - root.clientWidth,
    clipped: panels
      .filter((p) => p.scrollWidth > p.clientWidth + 1 || p.scrollHeight > p.clientHeight + 1)
      .map((p) => p.id || p.className),
    small: [...document.querySelectorAll<HTMLElement>("main *, .drawer *")]
      .filter(
        (el) =>
          [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) &&
          Number.parseFloat(getComputedStyle(el).fontSize) < 11,
      )
      .map((el) => el.className),
  };
};

describeRendered("Setup Roles & guards mockup in a browser", () => {
  it(
    "renders each repo and state at the design sizes",
    async () => {
      const cases: Array<[string, number, number, "light" | "dark", string]> = [];
      for (const repo of REPOS)
        for (const theme of THEMES)
          for (const [w, h] of SIZES) cases.push([repo, w, h, theme, "normal"]);
      for (const state of STATES) cases.push(["demo-app", 1920, 940, "dark", state]);
      for (const [repo, width, height, theme, state] of cases) {
        const page = await renderAt({
          page: PAGE,
          width,
          height,
          search: `?repo=${repo}&state=${state}&theme=${theme}`,
          colorScheme: theme,
        });
        const where = `${repo} ${state} ${theme} ${width}x${height}`;
        await page.boxes(".panel");
        expect(page.errors(), `${where}: script errors`).toEqual([]);
        const report = await page.evaluate(measure, null);
        expect(report.panels, `${where}: panels`).toBe(3);
        expect(report.sideways, `${where}: sideways scroll`).toBeLessThanOrEqual(0);
        expect(report.clipped, `${where}: clipped panels`).toEqual([]);
        expect(report.small, `${where}: text under 11px`).toEqual([]);
        if (width === 1920 && state === "normal") {
          const group = await page.box(".group");
          expect(group.y + group.height, `${where}: first group in view`).toBeLessThanOrEqual(
            height,
          );
        }
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 6,
  );

  it(
    "keeps a bad check and returns focus when the drawer closes",
    async () => {
      const page = await renderAt({
        page: PAGE,
        width: 1920,
        height: 940,
        search: "?repo=demo-site&state=normal&theme=dark",
        colorScheme: "dark",
      });
      await page.boxes(".panel");
      await page.click('[data-edit="checks"]');
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-key="checks"] input');
        if (input) input.value = "pnpm -s lint && pnpm -s test";
      }, null);
      await page.click('[data-key="checks"] [data-add]');
      const small = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>(".editor button")]
            .map((b) => b.getBoundingClientRect())
            .filter((r) => r.width < 24 || r.height < 24).length,
        null,
      );
      expect(small, "editor controls under 24px").toBe(0);
      const shown = await page.evaluate(
        () => ({
          error: document.querySelector('[data-key="checks"] .field-error')?.textContent,
          value: document.querySelector<HTMLInputElement>('[data-key="checks"] input')?.value,
        }),
        null,
      );
      expect(shown.error).toContain("no &&");
      expect(shown.value).toBe("pnpm -s lint && pnpm -s test");
      await page.click('[data-prompt="3"]');
      await page.press("Escape");
      const focus = await page.evaluate(
        () => ({
          hidden: document.querySelector<HTMLElement>("#drawer")?.hidden,
          on: document.activeElement?.getAttribute("data-prompt"),
        }),
        null,
      );
      expect(focus).toEqual({ hidden: true, on: "3" });
      expect(page.errors()).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
