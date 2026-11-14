// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { auditOverviewApi, overviewFixture } from "./auditOverviewFixtures.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { codeHealthBrowserApi } from "./codeHealthBrowserFixtures.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const SIZES = [
  [1920, 940],
  [2560, 1145],
] as const;

function api(rows = 8) {
  const base = desktopFixture().api;
  const overview = auditOverviewApi(NOW);
  if (rows !== 8)
    for (const window of ["7d", "30d", "90d"] as const)
      overview[`/api/code-health/overview?repo=sample&window=${window}`] = overviewFixture(NOW, {
        window,
        rows,
      });
  return {
    ...base,
    ...codeHealthBrowserApi(NOW),
    ...overview,
    "/api/config": {
      ...(base["/api/config"] as object),
      repos: [{ id: "sample", github: "example/sample" }],
    },
  };
}
async function ready(page: RenderedPage) {
  await page.boxes(".ao-row");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
}
async function capture(page: RenderedPage, name: string) {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  await page.screenshot(join(evidence, `${name}.png`));
}

describeRendered("the Audit overview in a real browser", () => {
  it(
    "shows five ranked rows without page scroll at 1920x940 and 2560x1145, both themes",
    async () => {
      for (const [width, height] of SIZES)
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            search: "?path=/audit",
            colorScheme,
            api: api(),
          });
          try {
            await ready(page);
            const name = `${width}x${height} ${colorScheme}`;
            const m = await page.evaluate(() => {
              const box = (el: Element | null) => el?.getBoundingClientRect();
              const scroller = document.querySelector(".ao-next .ao-scroll");
              const rows = [...document.querySelectorAll(".ao-row")].map((r) => box(r));
              return {
                innerHeight,
                innerWidth,
                docHeight: document.documentElement.scrollHeight,
                docWidth: document.documentElement.scrollWidth,
                pageScrolls: (() => {
                  const ao = document.querySelector<HTMLElement>(".ao");
                  return !!ao && ao.scrollHeight > ao.clientHeight + 1;
                })(),
                scrollerBottom: box(scroller)?.bottom ?? 0,
                scrollerTop: box(scroller)?.top ?? 0,
                rowBottoms: rows.map((r) => r?.bottom ?? 0),
                rowCount: rows.length,
                expanded: document.querySelectorAll(".ao-more").length,
                outsideTop: box(document.querySelector(".ao-outside"))?.top ?? 0,
                sideLeft: box(document.querySelector(".ao-build"))?.left ?? 0,
                small: [...document.querySelectorAll(".ao button,.ao select,.ao a[href]")].filter(
                  (e) => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                  },
                ).length,
              };
            }, undefined);
            expect(m.rowCount, name).toBe(8);
            expect(m.expanded, name).toBe(1);
            for (const bottom of m.rowBottoms.slice(0, 5))
              expect(bottom, `${name}: five rows inside the list`).toBeLessThanOrEqual(
                m.scrollerBottom + 1,
              );
            expect(m.scrollerBottom, name).toBeLessThanOrEqual(m.innerHeight);
            expect(m.pageScrolls, `${name}: page does not scroll`).toBe(false);
            expect(m.docHeight, name).toBeLessThanOrEqual(m.innerHeight);
            expect(m.docWidth, name).toBeLessThanOrEqual(m.innerWidth);
            expect(m.outsideTop, name).toBeGreaterThan(m.scrollerBottom - 1);
            expect(m.small, name).toBe(0);
            await capture(page, `audit-${width}x${height}-${colorScheme}`);
          } finally {
            await page.close();
          }
        }
    },
    BROWSER_TEST_TIMEOUT_MS * 2,
  );

  it(
    "keeps fifty rows and long text reachable inside their own scrollers",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1920,
        height: 940,
        search: "?path=/audit",
        colorScheme: "dark",
        api: api(50),
      });
      try {
        await ready(page);
        expect(await page.boxes(".ao-row")).toHaveLength(50);
        expect((await page.unclipped(".ao-row .rt")).every(Boolean)).toBe(true);
        expect((await page.reachable(".ao-row .rt", ".ao-next")).every(Boolean)).toBe(true);
        const docOk = await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
          undefined,
        );
        expect(docOk).toBe(true);
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
