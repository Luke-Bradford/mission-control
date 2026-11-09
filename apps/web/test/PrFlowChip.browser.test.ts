// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG } from "./fixtures.ts";

const { renderAt } = browserSession();
const shots = process.env.MC_PR_FLOW_CHIP_SHOTS;
const api = { "/api/config": CONFIG };

describeRendered("Board PR chips name the PR flow's stage and owner", () => {
  it.each(["light", "dark"] as const)(
    "at 1600x1000 in %s",
    async (theme) => {
      const page = await renderAt({
        page: "test/prFlowChipBrowser.html",
        width: 1600,
        height: 1000,
        colorScheme: theme,
        api,
      });
      await page.boxes(".flow-chip-cases [data-case]");
      const text = await page.evaluate(
        () =>
          Object.fromEntries(
            [...document.querySelectorAll<HTMLElement>("[data-case]")].map((c) => [
              c.dataset.case,
              c.textContent ?? "",
            ]),
          ),
        null,
      );
      expect(text["controller-check"]).toContain("Held · controller check");
      expect(text["controller-check"]).not.toContain("operator");
      expect(text.operator).toContain("Held · operator");
      expect(text.sync).toContain("Held · sync");
      expect(text.sync).not.toContain("Ready to merge");
      expect(text.merge).toContain("Ready to merge");
      expect(await page.unclipped(".flow-chip-cases, .kcard")).not.toContain(false);
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot(join(shots, `pr-flow-chips-${theme}.png`));
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
