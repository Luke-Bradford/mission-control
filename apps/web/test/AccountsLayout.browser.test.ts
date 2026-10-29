// @vitest-environment node

import type { LimitRow } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import {
  type Box,
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
} from "./browserRunner.ts";
import { CONFIG, limit5h, limit7d } from "./fixtures.ts";

const { renderAt } = browserSession();

// A full 5h bar, and a 7d bar past its projection, whose forecast is as long as the cell allows.
const limits: LimitRow[] = [
  limit5h({ accountId: "claude-main", used: 100 }),
  limit7d({ accountId: "claude-main", used: 100, projected: 140 }),
  limit7d({ accountId: "codex-main", used: 69, projected: 103, fullAt: null }),
];

const api = {
  [RESOURCES.config.path]: CONFIG,
  [RESOURCES.limits.path]: limits,
  [RESOURCES.accountStatus.path]: [],
};

const within = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

describeRendered("Setup Accounts usage layout, rendered", () => {
  it.each([1280, 1920])(
    "keeps every usage bar inside its quota cell at %ipx",
    async (width) => {
      const page = await renderAt({ page: "test/accountsBrowser.html", width, api });
      const cells = await page.boxes("td.account-quota");
      const tracks = await page.boxes("td.account-quota .meter .track");
      const meters = await page.boxes("td.account-quota .meter");
      const forecasts = await page.boxes("td.account-quota .quota-forecast");

      // two accounts × (5h, 7d) cells; a track per cell, a forecast per 7d cell
      expect(cells).toHaveLength(4);
      expect(tracks).toHaveLength(4);
      expect(forecasts).toHaveLength(2);
      for (const [index, cell] of cells.entries()) {
        expect(cell.width).toBeGreaterThan(0);
        expect(tracks[index].width).toBeGreaterThan(0);
        expect(within(tracks[index], cell), `track ${index} in its cell`).toBe(true);
        expect(within(meters[index], cell), `meter ${index} in its cell`).toBe(true);
      }
      for (const [index, forecast] of forecasts.entries()) {
        expect(within(forecast, cells[index * 2 + 1]), `forecast ${index} in its cell`).toBe(true);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
