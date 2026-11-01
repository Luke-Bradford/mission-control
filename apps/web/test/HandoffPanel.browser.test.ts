// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { handoffFixture } from "./handoffFixture.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_HANDOFF_SHOTS;
describeRendered("Saved ticket handoff", () => {
  it.each(
    [1280, 1600, 1920].flatMap((width) =>
      ["light", "dark"].map((theme) => ({ width, theme: theme as "light" | "dark" })),
    ),
  )(
    "fits $width in $theme with a reachable complete note",
    async ({ width, theme }) => {
      const page = await renderAt({
        page: "test/handoffBrowser.html",
        width,
        height: 1000,
        colorScheme: theme,
        api: {
          "/api/runs/old/handoff": {
            ...handoffFixture,
            messages: Array.from({ length: 6 }, (_, i) => ({
              from: "flight",
              at: i,
              text: "Recorded progress and the remaining checks. ".repeat(30),
            })),
          },
        },
      });
      await page.boxes(".agent-handoff summary");
      await page.click(".agent-handoff summary");
      expect(await page.unclipped(".agent-handoff, .handoff-body, .handoff-link")).not.toContain(
        false,
      );
      expect(
        await page.evaluate(() => {
          const note = document.querySelector<HTMLElement>(".handoff-body");
          note?.focus();
          if (!note) return false;
          note.scrollTop = note.scrollHeight;
          return (
            document.activeElement === note &&
            note.scrollTop > 0 &&
            document.documentElement.scrollWidth <= innerWidth
          );
        }, null),
      ).toBe(true);
      for (const link of await page.boxes(".handoff-link"))
        expect(link.height).toBeGreaterThanOrEqual(24);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot(join(shots, `handoff-${width}-${theme}.png`));
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
