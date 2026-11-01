// @vitest-environment node

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();
const SHOTS = join(process.env.TMPDIR ?? "/tmp", "comms-length-shots");
const WIDTHS = [1280, 1600, 1920] as const;

const senders = (n: number, idLength = 8) =>
  Array.from({ length: n }, (_, i) => ({
    seatId: `${"s".repeat(idLength)}-${i}`,
    p95: 200 + ((i * 173) % 1300),
    n: i + 1,
  }));

const SCENARIOS = {
  empty: [],
  eight: senders(8),
  fifty: senders(50),
  longId: senders(3, 300),
};

describeRendered("The Comms right column with message lengths in a browser", () => {
  it.each(WIDTHS)(
    "keeps the graph's content inside its panel and every sender reachable, at %i",
    async (width) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        for (const [name, p95BySeat] of Object.entries(SCENARIOS)) {
          const page = await renderAt({
            page: "test/commsLengthBrowser.html",
            width,
            height: 1000,
            colorScheme,
            api: {
              "/api/comms/links": { links: [] },
              "/api/comms/traffic": { hours: [] },
              "/api/comms/chatter": { pairs: [] },
              "/api/comms/metrics": { from: 0, to: 1, p95BySeat },
            },
          });
          await page.box(".comms-length-panel");
          const clear = await page.evaluate(() => {
            const panel = document.querySelector(".comms-graph-panel");
            if (!panel) return false;
            const bottom = panel.getBoundingClientRect().bottom;
            return [...panel.querySelectorAll("*")].every(
              (el) => el.getBoundingClientRect().bottom <= bottom + 0.5,
            );
          }, null);
          expect(clear, `${name} ${colorScheme}: graph content overflows its panel`).toBe(true);
          if (p95BySeat.length > 0) {
            expect((await page.reachable(".comms-length-list li")).every(Boolean)).toBe(true);
          }
          expect((await page.unclipped(".comms-length-panel")).every(Boolean)).toBe(true);
          await page.screenshot(join(SHOTS, `comms-length-${name}-${colorScheme}-${width}.png`));
          await page.close();
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS * 3,
  );
});
