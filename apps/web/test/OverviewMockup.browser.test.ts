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
        expect((await page.reachable(".loops", "#crew")).every(Boolean)).toBe(true);
        expect(
          await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>(".crewBody");
            const last = document.querySelector<HTMLElement>("#crewRows .crewrow:last-child");
            if (!body || !last) return false;
            body.scrollTop = body.scrollHeight;
            return (
              getComputedStyle(body).overflowY !== "hidden" &&
              last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1
            );
          }, null),
        ).toBe(true);
        expect(
          await page.evaluate(
            () =>
              [...document.querySelectorAll<HTMLElement>(".guardLabel")].every(
                (label) =>
                  getComputedStyle(label).fontSize === "12px" &&
                  label.textContent?.toLowerCase().includes("guard"),
              ),
            null,
          ),
        ).toBe(true);
        expect(
          await page.evaluate(
            () =>
              [...document.querySelectorAll<HTMLElement>(".guardLabel")].every((label) => {
                const chart = label.closest(".chart");
                return Boolean(
                  chart &&
                    label.getBoundingClientRect().right <= chart.getBoundingClientRect().right + 1,
                );
              }),
            null,
          ),
        ).toBe(true);
        expect(
          await page.evaluate(() => {
            const quota = document.querySelector<HTMLElement>(".quota");
            const last = document.querySelector<HTMLElement>(".quotaRow:last-child .meter");
            if (!quota || !last) return false;
            quota.scrollTop = quota.scrollHeight;
            return last.getBoundingClientRect().bottom <= quota.getBoundingClientRect().bottom + 1;
          }, null),
        ).toBe(true);
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
