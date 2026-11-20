// @vitest-environment node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { telemetryPath } from "../src/router.ts";
import {
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
  type RenderedPage,
} from "./browserRunner.ts";
import { desktopFixture } from "./desktopFixtures.ts";
import { HOUR, MIN, NOW } from "./fixtures.ts";
import { crewTelemetry, crewTelemetryApi } from "./telemetryCrewFixture.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const GIB = 2 ** 30;

/** A day of five-minute samples: load swells while two full suites hold the test lock. */
function machine() {
  const lockAt = (at: number) =>
    [
      [NOW - 5 * HOUR, NOW - 4.5 * HOUR],
      [NOW - 2 * HOUR, NOW - 1.5 * HOUR],
    ].some(([from, to]) => at >= (from as number) && at <= (to as number));
  return Array.from({ length: 288 }, (_, i) => {
    const at = NOW - (287 - i) * 5 * MIN;
    const load = lockAt(at) ? 1 : 0;
    const wave = 0.5 + 0.5 * Math.sin(i / 17);
    return {
      at,
      cpuPct: 15 + wave * 25 + load * 45,
      memPct: 52 + wave * 10 + load * 20,
      swapPct: 4 + load * 9,
      pressurePct: 18 + wave * 8 + load * 22,
      agentGb: 5 + wave * 3,
      testRunGb: load * 7,
    };
  });
}

function api() {
  const routes = { ...desktopFixture().api, ...crewTelemetryApi() };
  const data = { ...crewTelemetry(), machine: machine() };
  for (const r of ["1h", "6h", "24h", "7d"]) routes[`/api/telemetry?range=${r}`] = data;
  routes[RESOURCES.machine.path] = {
    latest: {
      at: NOW,
      cpuPct: 38,
      cores: 12,
      memUsedBytes: 21 * GIB,
      memTotalBytes: 32 * GIB,
      memoryPressureFreePct: 41,
      diskFreeBytes: 300 * GIB,
      diskTotalBytes: 900 * GIB,
      swapUsedBytes: 1 * GIB,
      swapTotalBytes: 8 * GIB,
      agents: null,
    },
    warning: null,
    maxSeats: 4,
    seats: 2,
    perSessionMax: 2,
    transcripts: null,
  };
  routes[RESOURCES.testLockHistory.path] = {
    runs: [
      {
        runId: "a",
        seatId: "inco-1",
        command: "just test",
        queuedAt: NOW - 5 * HOUR - 2 * MIN,
        startedAt: NOW - 5 * HOUR,
        endedAt: NOW - 4.5 * HOUR,
        outcome: "done",
        ticket: null,
      },
      {
        runId: "b",
        seatId: "dev-2",
        command: "just test",
        queuedAt: NOW - 2 * HOUR - MIN,
        startedAt: NOW - 2 * HOUR,
        endedAt: NOW - 1.5 * HOUR,
        outcome: "done",
        ticket: null,
      },
    ],
    today: { runs: 2, waitMs: 3 * MIN },
    usualMs: {},
  };
  routes[RESOURCES.testLock.path] = { holder: null, waiting: [] };
  return routes;
}

async function ready(page: RenderedPage) {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  for (const id of ["#tMach", "#mMem", "#mPressure", "#mAgentMem"]) await page.boxes(id);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
}

describeRendered("Telemetry, Machine tab, in a browser", () => {
  for (const scheme of ["dark", "light"] as const) {
    for (const [width, height] of [
      [1600, 1000],
      [2560, 1250],
    ] as const) {
      it(
        `fits one screen at ${width}x${height}, ${scheme}`,
        async () => {
          const page = await renderAt({
            page: "test/desktopBrowser.html",
            width,
            height,
            colorScheme: scheme,
            api: api(),
            search: `?path=${encodeURIComponent(telemetryPath("machine"))}`,
          });
          try {
            await ready(page);
            const g = await page.evaluate(() => {
              const main = document.querySelector("main") as HTMLElement;
              const box = (id: string) => document.querySelector(id)?.getBoundingClientRect();
              const cpu = box("#tMach") as DOMRect;
              const mem = box("#mMem") as DOMRect;
              const press = box("#mPressure") as DOMRect;
              const agent = box("#mAgentMem") as DOMRect;
              const plot = (id: string) =>
                (document.querySelector(`${id} svg`) as SVGElement).getBoundingClientRect();
              return {
                pageScroll: document.documentElement.scrollHeight - innerHeight,
                mainScroll: main.scrollHeight - main.clientHeight,
                mainBottom: main.getBoundingClientRect().bottom,
                bottoms: [cpu, mem, press, agent].map((b) => b.bottom),
                cpu,
                mem,
                press,
                agent,
                plotHeights: ["#tMach", "#mMem", "#mPressure", "#mAgentMem"].map(
                  (id) => plot(id).height,
                ),
                cpuLines: document.querySelectorAll("#tMach path.line").length,
                memLines: document.querySelectorAll("#mMem path.line").length,
                bands: [
                  document.querySelectorAll("#tMach rect.band").length,
                  document.querySelectorAll("#mMem rect.band").length,
                ],
                tiles: document.querySelectorAll(".summary .stat").length,
              };
            }, undefined);
            expect(page.errors()).toEqual([]);
            expect(g.pageScroll).toBeLessThanOrEqual(0);
            expect(g.mainScroll).toBeLessThanOrEqual(0);
            for (const b of g.bottoms) expect(b).toBeLessThanOrEqual(g.mainBottom + 1);
            // CPU sits directly over Memory used, the two sharing one column and one width
            expect(Math.abs(g.cpu.left - g.mem.left)).toBeLessThanOrEqual(1);
            expect(Math.abs(g.cpu.width - g.mem.width)).toBeLessThanOrEqual(1);
            expect(g.mem.top).toBeGreaterThanOrEqual(g.cpu.bottom - 1);
            expect(g.press.left).toBeGreaterThan(g.cpu.right - 1);
            expect(g.agent.top).toBeGreaterThanOrEqual(g.press.bottom - 1);
            // every chart keeps a plot tall enough to read
            for (const h of g.plotHeights) expect(h).toBeGreaterThanOrEqual(80);
            expect([g.cpuLines, g.memLines]).toEqual([1, 1]);
            expect(g.bands).toEqual([2, 2]);
            expect(g.tiles).toBe(6);
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(
                join(evidence, `telemetry-machine-${width}x${height}-${scheme}.png`),
              );
            }
          } finally {
            await page.close();
          }
        },
        BROWSER_TEST_TIMEOUT_MS,
      );
    }
  }
});
