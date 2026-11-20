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
import { desktopFixture } from "./desktopFixtures.ts";
import { HOUR, NOW } from "./fixtures.ts";
import { crewTelemetry, crewTelemetryApi } from "./telemetryCrewFixture.ts";

const { renderAt } = browserSession();
const evidence = process.env.MC_QA_EVIDENCE_DIR;
const DAY = 24 * HOUR;
const LONG_TITLE =
  "Telemetry throughput ticket with a deliberately long board-card title that must remain readable without hiding the merged date, cycle time, or cost";

function throughputApi(): Record<string, unknown> {
  const base = crewTelemetryApi();
  const data = crewTelemetry();
  const days = (data.throughput as { day: string }[]).map((d) => d.day);
  const tickets = Array.from({ length: 24 }, (_, i) => ({
    ticket: `mission-control#${1900 + i}`,
    title: i === 0 ? LONG_TITLE : `Telemetry ticket ${1900 + i}`,
    size: (["XS", "S", "M", "L", "XL"] as const)[i % 5],
    readyAt: NOW - (7 - (i % 7)) * DAY - 30 * HOUR,
    startedAt: null,
    mergedAt: NOW - (6 - (i % 7)) * DAY - HOUR,
    doneAt: NOW - (6 - (i % 7)) * DAY + ((i * 7) % 30) * HOUR - 30 * HOUR + 31 * HOUR,
  }));
  const withSeries = {
    ...data,
    cycleTime: {
      rows: [
        { size: "XS", p50Ms: 3 * HOUR, p85Ms: 7 * HOUR, tickets: 9 },
        { size: "S", p50Ms: 9 * HOUR, p85Ms: 20 * HOUR, tickets: 21 },
        { size: "M", p50Ms: 18 * HOUR, p85Ms: 44 * HOUR, tickets: 14 },
        { size: "L", p50Ms: 40 * HOUR, p85Ms: 70 * HOUR, tickets: 6 },
        { size: "XL", p50Ms: null, p85Ms: null, tickets: 0 },
      ],
      excluded: 2,
    },
    tokensByTicket: tickets.map((k, i) => ({
      ticket: k.ticket,
      tokens: 1000,
      costUsd: 3,
      totalCostUsd: 4 + i,
    })),
    quality: { ...data.quality, commitsPerRun: 3.4 },
    series: {
      ...(data.series as object),
      tickets,
      ticketsInProgress: days.map((day, i) => ({ day, tickets: i < 2 ? null : 2 + ((i * 3) % 5) })),
    },
  };
  for (const r of ["1h", "6h", "24h", "7d"]) base[`/api/telemetry?range=${r}`] = withSeries;
  return base;
}

const api = () => ({ ...desktopFixture().api, ...throughputApi() });

async function ready(page: RenderedPage) {
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)), undefined);
  if (page.errors().length) throw new Error(page.errors().join("; "));
  await page.boxes("#page-telemetry");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, undefined);
}

async function geometry(page: RenderedPage) {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const mainBottom = main.getBoundingClientRect().bottom;
    const panels = ["tMerged", "tCycleTicket", "tCycleSize", "tWip"].map((id) => {
      const el = document.getElementById(id);
      const r = el?.getBoundingClientRect();
      const body = el?.querySelector(".pb") as HTMLElement | null;
      const bodyStyle = body ? getComputedStyle(body) : null;
      return {
        id,
        found: !!el,
        top: r?.top ?? 0,
        bottom: r?.bottom ?? 0,
        h: r?.height ?? 0,
        // the chart and its legend show whole, with no hidden overflow
        bodyScroll: body ? body.scrollHeight - body.clientHeight : 0,
        bodyContentHeight: body
          ? body.clientHeight -
            Number.parseFloat(bodyStyle?.paddingTop ?? "0") -
            Number.parseFloat(bodyStyle?.paddingBottom ?? "0")
          : 0,
        chartHeight: (el?.querySelector(".chart") as HTMLElement | null)?.clientHeight ?? 0,
        legendHeight: (el?.querySelector(".legend") as HTMLElement | null)?.clientHeight ?? 0,
      };
    });
    return {
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      mainScroll: main.scrollHeight - main.clientHeight,
      mainBottom,
      panels,
      legendMean: document.querySelector("#tMerged .legend")?.textContent ?? "",
    };
  }, undefined);
}

describeRendered("Telemetry, Throughput tab, in a browser", () => {
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
            search: "?path=/telemetry%3Ftab%3Dthroughput",
          });
          try {
            await ready(page);
            const g = await geometry(page);
            expect(page.errors()).toEqual([]);
            expect(g.pageScroll).toBeLessThanOrEqual(0);
            expect(g.mainScroll).toBeLessThanOrEqual(0);
            for (const p of g.panels) {
              expect(p.found, p.id).toBe(true);
              expect(p.bottom, p.id).toBeLessThanOrEqual(g.mainBottom + 1);
              expect(p.h, p.id).toBeGreaterThanOrEqual(240);
              expect(p.bodyScroll, `${p.id} clips`).toBeLessThanOrEqual(1);
              if (["tMerged", "tCycleTicket", "tWip"].includes(p.id))
                expect(p.chartHeight, `${p.id} chart height`).toBeGreaterThanOrEqual(
                  p.bodyContentHeight - p.legendHeight - 24,
                );
            }
            expect(g.legendMean).toContain("14-day mean");
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot(
                join(evidence, `telemetry-throughput-${width}x${height}-${scheme}.png`),
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

  it(
    "keeps every Tickets field reachable at 1280px and discloses a long title by keyboard",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1280,
        height: 1000,
        colorScheme: "dark",
        api: api(),
        search: "?path=/telemetry%3Ftab%3Dthroughput%26view%3Dtable",
      });
      try {
        await ready(page);
        const table = await page.evaluate(() => {
          const panel = document.querySelector("#tTickets") as HTMLElement;
          const panelBox = panel.getBoundingClientRect();
          const headers = [...panel.querySelectorAll("th")].map((header) => {
            const box = header.getBoundingClientRect();
            return { text: header.textContent, left: box.left, right: box.right };
          });
          const row = panel.querySelector("tbody tr") as HTMLElement;
          const values = [...row.querySelectorAll("td")].map((cell) => {
            const box = cell.getBoundingClientRect();
            return { text: cell.textContent, left: box.left, right: box.right };
          });
          return {
            panelLeft: panelBox.left,
            panelRight: panelBox.right,
            headers,
            values,
          };
        }, undefined);
        expect(page.errors()).toEqual([]);
        expect(table.headers.map((header) => header.text)).toEqual([
          "Ticket",
          "Title",
          "Size",
          "Merged",
          "Cycle",
          "~Cost",
        ]);
        for (const field of [...table.headers, ...table.values]) {
          expect(field.left).toBeGreaterThanOrEqual(table.panelLeft);
          expect(field.right).toBeLessThanOrEqual(table.panelRight + 1);
        }
        await page.evaluate(() => {
          (
            document.querySelector(
              '.ticket-title-disclosure summary[aria-label*="Telemetry throughput"]',
            ) as HTMLElement
          ).focus();
        }, undefined);
        await page.press("Enter");
        const disclosure = await page.evaluate(() => {
          const title = document.querySelector(
            '.ticket-title-disclosure:has(summary[aria-label*="Telemetry throughput"])',
          ) as HTMLDetailsElement;
          return { open: title.open, text: title.textContent };
        }, undefined);
        expect(disclosure.open).toBe(true);
        expect(disclosure.text).toContain(LONG_TITLE);
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot(join(evidence, "telemetry-throughput-table-1280x1000-dark.png"));
        }
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  for (const scheme of ["dark", "light"] as const) {
    it(
      `renders the Tickets table at 1600x1000, ${scheme}`,
      async () => {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width: 1600,
          height: 1000,
          colorScheme: scheme,
          api: api(),
          search: "?path=/telemetry%3Ftab%3Dthroughput%26view%3Dtable",
        });
        try {
          await ready(page);
          expect(page.errors()).toEqual([]);
          expect(await page.box("#tTickets")).toBeDefined();
          expect(await page.boxes("#tTickets th")).toHaveLength(6);
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot(
              join(evidence, `telemetry-throughput-table-1600x1000-${scheme}.png`),
            );
          }
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }
});
