// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { CONFIG, NOW, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();
const SHOTS = process.env.MC_SHOT_DIR ?? join(process.env.TMPDIR ?? "/tmp", "comms-rails-shots");
const ROLES = ["GUIDO", "RETRO", "INCO", "FAO", "OPS"] as const;

/** A crew of `n` seats (FLIGHT first), the links between neighbours and two open questions. */
function crewApi(n: number) {
  const ids = [
    "flight-1",
    ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => `seat-${i + 1}`),
  ];
  const rows = ids.map((id, index) =>
    seatRow({
      id,
      index,
      role: index === 0 ? "FLIGHT" : (ROLES[index % ROLES.length] as "GUIDO"),
      hudState: index % 3 === 0 ? "running" : "idle",
      run: null,
    }),
  );
  const links = ids.flatMap((from, i) => [
    {
      from,
      to: ids[(i + 1) % ids.length] as string,
      count: 2 + (i % 7),
      lastId: `c:${i}`,
      lastAt: NOW,
      lastText: `Message ${i}`,
    },
    { from, to: i === 0 ? "CAPCOM" : "flight-1", count: 1 + (i % 4) },
  ]);
  return {
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows, firstRunToday: null },
    "/api/attention": [],
    "/api/flight": { seat: { id: "flight-1" }, decisions: [] },
    "/api/comms/crew": { messages: [], hasMore: false },
    "/api/comms/flight": { messages: [] },
    "/api/comms/mentions": { mentions: [] },
    "/api/comms/pins": { messages: [] },
    "/api/comms/read": { ok: true },
    "/api/comms/links": { links: links.filter((l) => l.from !== l.to) },
    "/api/comms/chatter": { pairs: [] },
    "/api/comms/traffic": { hours: [] },
    "/api/comms/metrics": { p95BySeat: [], bySeat: [] },
    "/api/comms/open": {
      items: [
        {
          id: "o1",
          label: "question",
          from: ids[1] ?? "flight-1",
          to: "flight-1",
          ticket: "#1",
          waitedMs: 14 * 60_000,
          question: "Which branch?",
        },
        {
          id: "o2",
          label: "blocker",
          from: ids[2] ?? "flight-1",
          to: "CAPCOM",
          ticket: null,
          waitedMs: 190 * 60_000,
        },
      ],
    },
    "/api/comms/feed": {
      messages: ids.slice(0, 6).map((from, i) => ({
        id: `f${i}`,
        from,
        to: "flight-1",
        at: NOW - i * 60_000,
        text: `Feed message ${i}`,
      })),
    },
  };
}

/** The chart's names, seats and rail rows as measured in the page. */
const measure = (page: RenderedPage) =>
  page.evaluate(() => {
    const names = [
      ...document.querySelectorAll<SVGTextElement>(".comms-node:not(.hub) .comms-node-name"),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        text: e.textContent ?? "",
        size: parseFloat(getComputedStyle(e).fontSize),
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
      };
    });
    const hits = [
      ...document.querySelectorAll<SVGRectElement>(".comms-node:not(.hub) .comms-node-hit"),
    ].map((e) => e.getBoundingClientRect().height);
    const scroll = document.querySelector(".comms-rails-scroll");
    const canvas = document.querySelector(".comms-rails-canvas")?.getBoundingClientRect();
    return {
      names,
      hits,
      nodes: document.querySelectorAll(".comms-node").length,
      scrolls: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : false,
      canvasW: canvas?.width ?? 0,
      canvasH: canvas?.height ?? 0,
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      pane: document.querySelector(".comms-chart-pane") !== null,
      chip: document.querySelector(".comms-filter-chip")?.textContent ?? null,
    };
  }, null);

const overlaps = (names: { x: number; y: number; right: number; bottom: number }[]) =>
  names.some((a, i) =>
    names
      .slice(i + 1)
      .some((b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom),
  );

describeRendered("Comms chart, rendered", () => {
  it.each([1, 3, 9, 20, 50])(
    "keeps %i participants readable in the panel, in light and dark",
    async (n) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await renderAt({
          page: "test/commsBrowser.html",
          width: 1600,
          height: 1000,
          colorScheme,
          api: crewApi(n),
        });
        await page.box(".comms-rails svg");
        await page.box(".comms-node");
        const m = await measure(page);
        expect(m.nodes).toBe(n + 2);
        expect(m.names.every((name) => name.size >= 11)).toBe(true);
        // Every seat has a row at least 24px tall, and no two names overlap.
        expect(m.hits.every((h) => h >= 24 - 0.5)).toBe(true);
        if (n > 1) expect(overlaps(m.names)).toBe(false);
        // Past what the panel can hold the rails scroll inside it, never off the page.
        expect(
          (await page.reachable(".comms-rails-scroll", ".comms-graph-panel")).every(Boolean),
        ).toBe(true);
        await page.screenshot(join(SHOTS, `panel-${n}-${colorScheme}.png`));
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it.each([
    { width: 1920, height: 940 },
    { width: 2560, height: 1250 },
  ])(
    "fills a $width × $height window with and without a filter",
    async ({ width, height }) => {
      mkdirSync(SHOTS, { recursive: true });
      for (const focus of ["", "?focus=seat:seat-2"]) {
        const page = await renderAt({
          page: "test/commsBrowser.html",
          width,
          height,
          search: `?at=${encodeURIComponent(`/comms/chart${focus}`)}`,
          api: crewApi(20),
        });
        await page.box(".comms-rails svg");
        const m = await measure(page);
        expect(m.nodes).toBe(22);
        // The chart takes the window: wide, and as tall as the rows need up to the window.
        expect(m.canvasW).toBeGreaterThan(m.viewW * (focus ? 0.55 : 0.85));
        // Full names at 20 seats: none cut with an ellipsis.
        expect(m.names.some((name) => name.text.endsWith("…"))).toBe(false);
        expect(overlaps(m.names)).toBe(false);
        expect(m.pane).toBe(focus !== "");
        if (focus) {
          expect(m.chip).toContain("SEAT-2");
          expect((await page.reachable(".comms-chart-pane")).every(Boolean)).toBe(true);
        }
        await page.screenshot(join(SHOTS, `full-${width}-${focus ? "filtered" : "all"}.png`));
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "narrows to a seat and a link by click and clears by Escape",
    async () => {
      const page = await renderAt({
        page: "test/commsBrowser.html",
        width: 1920,
        height: 940,
        search: `?at=${encodeURIComponent("/comms/chart")}`,
        api: crewApi(9),
      });
      await page.box(".comms-node");
      await page.click('.comms-node[data-id="seat-2"]');
      await page.box(".comms-filter-chip");
      expect(await page.evaluate(() => window.location.search, null)).toContain(
        "focus=seat%3Aseat-2",
      );
      expect(
        await page.evaluate(() => document.querySelectorAll(".comms-node.dim").length > 0, null),
      ).toBe(true);
      await page.press("Escape");
      expect(
        await page.evaluate(() => document.querySelector(".comms-filter-chip") === null, null),
      ).toBe(true);
      // Links cross, so one link's wide hit area can sit over another: send the click to the link itself.
      await page.evaluate(
        () =>
          document
            .querySelector(".comms-edge")
            ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
        null,
      );
      await page.box(".comms-filter-chip");
      expect(await page.evaluate(() => window.location.search, null)).toContain("focus=pair");
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  it(
    "holds a steady frame rate at 50 participants in the panel and full screen",
    async () => {
      for (const [at, width, height] of [
        ["/comms/crew", 1600, 1000],
        ["/comms/chart", 1920, 940],
      ] as const) {
        const page = await renderAt({
          page: "test/commsBrowser.html",
          width,
          height,
          search: `?at=${encodeURIComponent(at)}`,
          api: crewApi(50),
        });
        await page.box(".comms-node");
        // Busy: sweep the pointer over every seat and flip All / Open every few frames for 3 seconds.
        const frames = await page.evaluate(
          () =>
            new Promise<number[]>((resolve) => {
              const seats = [...document.querySelectorAll<SVGElement>(".comms-node")];
              const switches = [
                ...document.querySelectorAll<HTMLButtonElement>(".comms-metric button"),
              ];
              const deltas: number[] = [];
              const started = performance.now();
              let last = started;
              let i = 0;
              const tick = (now: number) => {
                deltas.push(now - last);
                last = now;
                i++;
                seats[i % seats.length]?.dispatchEvent(
                  new MouseEvent("mouseover", { bubbles: true }),
                );
                seats[i % seats.length]?.dispatchEvent(new MouseEvent("mouseenter"));
                if (i % 20 === 0) switches[(i / 20) % 2]?.click();
                if (now - started < 3000) requestAnimationFrame(tick);
                else resolve(deltas);
              };
              requestAnimationFrame(tick);
            }),
          null,
        );
        const sorted = [...frames].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
        console.info(
          `comms chart 50 seats ${at}: ${frames.length} frames, median ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)}ms, p95 ${p95.toFixed(1)}ms`,
        );
        expect(p95).toBeLessThan(50);
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
