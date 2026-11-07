// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { tokenAuditFixture } from "./tokenAuditFixture.ts";

const api = {
  "/api/config": {
    operator: { id: "operator" },
    repos: [{ id: "shop-app", github: "x/shop-app" }],
  },
  "/api/audit/tokens?days=7": tokenAuditFixture(),
};

/** The viewports the operator's screens give the page (browser content area). */
const SIZES = [
  { width: 1920, height: 940 },
  { width: 2560, height: 1145 },
] as const;
/** When set, each render also saves a PNG here, for the operator's review of the mockup. */
const SHOTS = process.env.MC_AUDIT_TOKENS_SHOTS;

const { renderAt } = browserSession();

describeRendered("Audit Tokens tab in a browser", () => {
  it.each(SIZES)(
    "fits $width×$height in light and dark: every figure shows, nothing clips, controls are 24 px",
    async ({ width, height }) => {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/tokenAuditBrowser.html",
          width,
          height,
          colorScheme,
          api,
        });
        try {
          await page.click("#ch-tab-tokens");
          await page.boxes(".ta-fig");
          const m = await page.evaluate(
            () => ({
              sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              figs: [...document.querySelectorAll(".ta-fig")].map((e) => e.textContent ?? ""),
              small: [...document.querySelectorAll("button,a[href],select")]
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
                })
                .map((e) => e.textContent),
              clipped: [...document.querySelectorAll(".ta .panel, .ta-fig")]
                .filter((e) => e.scrollWidth > e.clientWidth)
                .map((e) => e.className),
            }),
            undefined,
          );
          expect(m.sideways, `${colorScheme}: sideways scroll`).toBeLessThanOrEqual(0);
          expect(m.small, `${colorScheme}: small controls`).toEqual([]);
          expect(m.clipped, `${colorScheme}: clipped boxes`).toEqual([]);
          for (const fig of m.figs) expect(fig).toMatch(/last 7 days|Turn on audit/);
          if (SHOTS)
            await page.screenshot(
              join(SHOTS, `audit-tokens-${width}x${height}-${colorScheme}.png`),
            );
        } finally {
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "opens the run trace from a heaviest-run row, and from nothing else",
    async () => {
      const page = await renderAt({
        page: "test/tokenAuditBrowser.html",
        width: 1920,
        height: 940,
        api,
      });
      try {
        await page.click("#ch-tab-tokens");
        await page.boxes(".ta-table");
        const hrefs = await page.evaluate(
          () => [...document.querySelectorAll(".ta a[href]")].map((a) => a.getAttribute("href")),
          undefined,
        );
        expect(hrefs).toEqual(["/agent/inco-1?trace=run-4821", "/agent/flight-1?trace=run-4790"]);
        await page.click('.ta a[href$="run-4821"]');
        const at = await page.evaluate(() => location.pathname + location.search, undefined);
        expect(at).toBe("/agent/inco-1?trace=run-4821");
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
