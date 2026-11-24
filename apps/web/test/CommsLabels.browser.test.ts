// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { CONFIG, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();
const api = {
  "/api/config": CONFIG,
  "/api/crew?shape=summary": {
    rows: [
      ["flight-1", "FLIGHT"],
      ["guido-1", "GUIDO"],
      ["guido-2", "GUIDO"],
      ["retro-1", "RETRO"],
      ["retro-cx", "RETRO"],
      ["inco-1", "INCO"],
      ["inco-cx", "INCO"],
      ["fao-1", "FAO"],
    ].map(([id, role], index) =>
      seatRow({ id, role: role as "GUIDO", index, hudState: "idle", run: null }),
    ),
    firstRunToday: null,
  },
  "/api/attention": [],
  "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
  "/api/comms/crew": { messages: [], hasMore: false },
  "/api/comms/flight": { messages: [] },
  "/api/comms/mentions": { mentions: [] },
  "/api/comms/pins": { messages: [] },
  "/api/comms/read": { ok: true },
  "/api/comms/feed": { messages: [] },
  "/api/comms/open": { items: [] },
  "/api/comms/chatter": { pairs: [] },
  "/api/comms/traffic": { hours: [] },
  "/api/comms/metrics": { p95BySeat: [], bySeat: [] },
};
describeRendered("Comms role labels", () => {
  it.each([
    { width: 1280, height: 1000 },
    { width: 1600, height: 1000 },
    { width: 1920, height: 1000 },
    { width: 1600, height: 700 },
  ])(
    "keeps both RETRO names readable at $width × $height in light and dark",
    async ({ width, height }) => {
      for (const theme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/commsBrowser.html",
          width,
          height,
          colorScheme: theme,
          api,
        });
        await page.box(".cm-seat");
        // the name tags are placed once the map has its size; wait until both RETRO tags are painted and still
        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const started = performance.now();
              let last = "";
              let stable = 0;
              const tag = (id: string) =>
                document.querySelector<HTMLElement>(`.cm-seat[data-seat="${id}"] .cm-lab`);
              const wait = () => {
                const nodes = ["retro-1", "retro-cx"].map(tag);
                const visible = nodes.every((e) => {
                  if (!e || e.hidden) return false;
                  const box = e.getBoundingClientRect();
                  return (
                    box.width > 10 && box.height > 5 && Number(getComputedStyle(e).opacity) > 0.1
                  );
                });
                const positions = nodes.map((e) => e?.style.top ?? "").join("|");
                stable = visible && positions === last ? stable + 1 : 0;
                last = positions;
                if (stable >= 5) return resolve();
                if (performance.now() - started > 10000)
                  return reject(Error("RETRO labels did not become visible and settle"));
                requestAnimationFrame(wait);
              };
              wait();
            }),
          null,
        );
        const labels = await page.evaluate(() => {
          return ["retro-1", "retro-cx"].map((id) => {
            const e = document.querySelector<HTMLElement>(`.cm-seat[data-seat="${id}"] .cm-lab`);
            if (!e) throw Error(`no tag for ${id}`);
            const r = e.getBoundingClientRect();
            return {
              text: e.firstChild?.textContent ?? "",
              size: parseFloat(getComputedStyle(e).fontSize),
              x: r.x,
              y: r.y,
              right: r.right,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
            };
          });
        }, null);
        expect(labels).toHaveLength(2);
        expect(
          labels.every((label) => label.size >= 11 && label.width > 10 && label.height > 5),
        ).toBe(true);
        const [a, b] = labels;
        if (!a || !b) throw Error("labels");
        expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
        if (width >= 1600)
          expect((await page.box(".comms-right")).width).toBeGreaterThanOrEqual(420);
        const shots = process.env.MC_MAP_PERFORMANCE_SHOTS;
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot(
            join(shots, `comms-labels-${width}${height === 700 ? "x700" : ""}-${theme}.png`),
          );
        }
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
