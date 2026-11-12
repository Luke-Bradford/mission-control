// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rosterApi, rosterRows } from "./agentRosterFixture.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { NOW } from "./fixtures.ts";

const { renderAt } = browserSession();

/** The operator's real CSS viewports (docs/design/system.md): the control room fits both. */
const SIZES = [
  [1920, 940],
  [2560, 1145],
] as const;
const SCROLLERS = [".roster-list", "#stream", ".side-body"];

/** Nine seats and a busy chosen seat: many long activity rows, so the list has to scroll. */
function busyApi() {
  const rows = rosterRows(9);
  const api = rosterApi(rows);
  for (const r of rows) {
    api[`/api/agents/${r.id}/runs?limit=50`] = [];
  }
  api["/api/agents/flight-1/stream?limit=20"] = {
    runId: null,
    events: Array.from({ length: 80 }, (_, i) => ({
      id: `1:${i}`,
      at: NOW,
      kind: i % 3 === 0 ? "msg" : "think",
      text: `Row ${i}: ${"a long line of activity that wraps ".repeat(4)}`,
    })),
    tasks: [],
    truncated: false,
    more: false,
  };
  return api;
}

describeRendered("Agents control room in a browser", () => {
  for (const [width, height] of SIZES) {
    for (const theme of ["dark", "light"] as const) {
      it(
        `fits one screen at ${width}x${height}, ${theme}: only the roster, the list and the tab body scroll`,
        async () => {
          const page = await renderAt({
            page: "test/agentV2Browser.html",
            width,
            height,
            colorScheme: theme,
            search: `?at=${encodeURIComponent("/agent/flight-1")}`,
            api: busyApi(),
          });
          await page.box("#streamP");
          const r = await page.evaluate((scrollers) => {
            const doc = document.documentElement;
            const cut = (e: Element) =>
              e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== "auto";
            const composer = document.querySelector("#agentInput")?.getBoundingClientRect();
            return {
              pageScrollsY: doc.scrollHeight > innerHeight + 1,
              pageScrollsX: doc.scrollWidth > innerWidth + 1,
              composerBox: composer ? [composer.top, composer.bottom, innerHeight] : null,
              composerInView: !!composer && composer.bottom <= innerHeight && composer.top >= 0,
              listScrolls: (() => {
                const s = document.querySelector<HTMLElement>("#stream");
                return !!s && s.scrollHeight > s.clientHeight + 1;
              })(),
              nameCut: [...document.querySelectorAll(".idb-name h2, .seat-name, .pill")]
                .filter(cut)
                .map((e) => e.textContent),
              scrollers: scrollers.map((s) => !!document.querySelector(s)),
            };
          }, SCROLLERS);
          const where = `${width}x${height}, ${theme}`;
          expect(r.pageScrollsY, `${where}: the page does not scroll`).toBe(false);
          expect(r.pageScrollsX, `${where}: nor sideways`).toBe(false);
          expect(
            r.composerInView,
            `${where}: the message box is on screen (top, bottom, window: ${JSON.stringify(r.composerBox)})`,
          ).toBe(true);
          expect(r.listScrolls, `${where}: the activity list is what scrolls`).toBe(true);
          expect(r.nameCut, `${where}: names and states are never cut`).toEqual([]);
          const shots = process.env.MC_AGENT_CONTROL_SHOTS;
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot(join(shots, `control-room-${width}x${height}-${theme}.png`));
          }
          await page.close();
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    "an idle page asks for no list again on a timer",
    async () => {
      const page = await renderAt({
        page: "test/agentV2Browser.html",
        width: 1920,
        height: 940,
        search: `?at=${encodeURIComponent("/agent/flight-1")}`,
        api: busyApi(),
      });
      await page.box("#streamP");
      const before = page.requests().length;
      await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 7000)), null);
      const timed = page
        .requests()
        .slice(before)
        .filter((q) => q.method === "GET" && q.path.startsWith("/api/"));
      expect(
        timed.map((q) => q.path),
        "no request while idle",
      ).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
