// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, METRICS_VIEW, NOW, OVERVIEW } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "overview-shots");

const api = {
  "/api/overview": OVERVIEW,
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew?shape=summary": { rows: [], firstRunToday: null },
  "/api/attention": [],
  "/api/machine": {
    latest: null,
    warning: null,
    maxSeats: 8,
    seats: 0,
    perSessionMax: 0,
    transcripts: {
      totalBytes: 12.3 * 2 ** 20,
      oldestAt: Date.now() - 3 * 3_600_000,
      seats: [{ seatId: "fao-1", bytes: 8 * 2 ** 20, files: 3 }],
    },
  },
  "/api/limits": [],
  "/api/limits/github": { queries: {}, pollCost: null },
  "/api/health": [],
  "/api/activity": [],
  "/api/settings/away": { on: false, until: "", may: {} },
  "/api/config": CONFIG,
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true, note: null },
  "/api/repos/shop-app/prs?linked=1&shape=summary": [],
};

describeRendered("Overview transcript footprint in a browser", () => {
  it.each([1366, 1600, 1920])(
    "fits at %i wide and records a screenshot",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      const page = await renderAt({
        page: "test/overviewBrowser.html",
        width,
        height: 1000,
        api,
      });
      const row = await page.box("#machP .transcript-footprint");
      expect(row.width).toBeGreaterThan(0);
      await page.screenshot(join(SHOTS, `overview-transcripts-${width}.png`));
      expect(
        await page.evaluate(
          () => document.querySelector<HTMLElement>("#machP .transcript-footprint")?.title,
          undefined,
        ),
      ).toBe("fao-1 8.0 MB · 3 files");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
