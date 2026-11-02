// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CREW_CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();
const at = Date.UTC(2026, 10, 2, 12);
const pause = (count: number) => ({
  seats: "all",
  reason: "Keep new tickets paused",
  by: "operator",
  at: at - 1000,
  liftedBy: "FLIGHT",
  except: Array.from({ length: count }, (_, i) => ({
    seat: `guido-${i + 1}`,
    runId: `guido-${i + 1}:20261102-120000${i ? `-${"long-id".repeat(30)}` : ""}`,
    by: "FLIGHT",
    at,
    reason: "Finish this approved run only. ".repeat(i ? 30 : 1).slice(0, 500),
  })),
});

describeRendered("Crew pause run exceptions", () => {
  it(
    "shows an unavailable pause without offering a write",
    async () => {
      const page = await renderAt({
        page: "test/crewPauseBrowser.html",
        width: 1280,
        colorScheme: "dark",
        api: { "/api/config": CREW_CONFIG },
      });
      await page.box('.crew-pause [role="alert"]');
      expect(
        await page.evaluate(
          () => document.querySelector(".crew-pause button")?.hasAttribute("disabled"),
          null,
        ),
      ).toBe(true);
      expect(await page.unclipped(".crew-pause")).not.toContain(false);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "keeps one, empty and fifty long run rows inspectable at required widths and themes",
    async () => {
      const shots = join(process.env.TMPDIR ?? "/tmp", "crew-pause-1188-shots");
      mkdirSync(shots, { recursive: true });
      for (const [width, height] of [
        [1280, 900],
        [1600, 1000],
        [1920, 1080],
        [1600, 700],
      ]) {
        for (const colorScheme of ["light", "dark"] as const) {
          for (const count of [0, 1, 50]) {
            const page = await renderAt({
              page: "test/crewPauseBrowser.html",
              width,
              height,
              colorScheme,
              api: { "/api/config": CREW_CONFIG, "/api/settings/crew-pause": pause(count) },
            });
            await page.click(".crew-pause > button");
            await page.box(".crew-pause-form");
            const facts = await page.evaluate(
              () => ({
                width: document.documentElement.scrollWidth,
                text: document.querySelector(".crew-pause-audit")?.textContent,
                rows: document.querySelectorAll(".crew-pause-audit li").length,
                scroll: (() => {
                  const e = document.querySelector(".crew-pause-form");
                  return !!e && e.scrollHeight > e.clientHeight;
                })(),
              }),
              null,
            );
            expect(facts.width).toBeLessThanOrEqual(width);
            expect(facts.rows).toBe(count);
            expect(facts.text).toContain(
              count ? "Run guido-1:20261102-120000" : "No run exceptions.",
            );
            expect(await page.unclipped(".crew-pause-form")).not.toContain(false);
            expect(
              await page.reachable(".crew-pause-form button, .crew-pause-audit summary"),
            ).not.toContain(false);
            if (count === 50) expect(facts.scroll).toBe(true);
            if (count === 1)
              await page.screenshot(
                join(shots, `crew-pause-${width}x${height}-${colorScheme}.png`),
              );
            await page.close();
          }
        }
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
