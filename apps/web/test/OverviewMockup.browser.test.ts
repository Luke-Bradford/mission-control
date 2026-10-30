// @vitest-environment node

import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";

const { renderAt } = browserSession();

describeRendered("Overview v2 mockup in a browser", () => {
  for (const [width, height] of [
    [1280, 1000],
    [1600, 1000],
    [1920, 1000],
    [1600, 700],
  ]) {
    it(
      `keeps the log and Board controls reachable at ${width}x${height}`,
      async () => {
        const page = await renderAt({ page: "test/overviewMockupBrowser.html", width, height });
        expect((await page.reachable(".log", ".bottom")).every(Boolean)).toBe(true);
        expect(
          await page.evaluate(() => {
            const log = document.querySelector<HTMLElement>(".log");
            return Boolean(
              log &&
                (log.scrollHeight <= log.clientHeight ||
                  getComputedStyle(log).overflowY !== "hidden"),
            );
          }, null),
        ).toBe(true);
        expect((await page.reachable(".pipeline .more", ".pipeline")).every(Boolean)).toBe(true);
        expect(
          await page.evaluate(() => {
            const sub = document.querySelector(".sub");
            return sub ? getComputedStyle(sub).fontSize : "";
          }, null),
        ).toBe("12px");
        await page.close();
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
