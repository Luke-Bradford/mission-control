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
type RepoWeeks = NonNullable<ReturnType<typeof crewTelemetry>["repoWeeks"]>;
const LONG_TITLE =
  "Telemetry throughput ticket with a deliberately long board-card title that must remain readable without hiding the merged date, cycle time, or cost";
const LONG_TICKET = "repository-with-a-schema-length-name-that-must-remain-visible#1900";

function throughputApi(repoWeeks?: RepoWeeks): Record<string, unknown> {
  const base = crewTelemetryApi();
  const data = crewTelemetry();
  const days = (data.throughput as { day: string }[]).map((d) => d.day);
  const tickets = Array.from({ length: 24 }, (_, i) => ({
    ticket: i === 0 ? LONG_TICKET : `mission-control#${1900 + i}`,
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
    ...(repoWeeks === undefined ? {} : { repoWeeks }),
  };
  for (const r of ["1h", "6h", "24h", "7d"]) base[`/api/telemetry?range=${r}`] = withSeries;
  return base;
}

const api = (repoWeeks?: RepoWeeks) => ({ ...desktopFixture().api, ...throughputApi(repoWeeks) });

function repoWeeksFixture(repositories = 3, withLongValue = true): RepoWeeks {
  return Array.from({ length: repositories }, (_, index) => {
    const zeroMerge = index === 1;
    const longValue = withLongValue && index === 2;
    return {
      repoId: longValue
        ? "repository-with-a-deliberately-long-name-that-must-remain-reachable-in-the-scoreboard"
        : `crew-repo-${index + 1}`,
      baseline: {
        mergedPrsPerWeek: { min: 76, max: 100 },
        tokensPerWeek: { min: 1_300_000_000, max: 1_700_000_000 },
      },
      weeks: ["2026-10-29", "2026-11-05", "2026-11-12", "2026-11-19"].map((week) => ({
        week,
        mergedPrs: zeroMerge ? 0 : 101,
        tokensPerMergedPr: zeroMerge
          ? { claude: null, codex: null }
          : { claude: 20_000_000, codex: 9_000_000 },
        reviewRoundsPerPr: zeroMerge ? null : 1.4,
        medianReadyToMergeHours: zeroMerge ? null : 6.5,
        noSeatWorkingHours: zeroMerge ? null : 2,
      })),
    };
  });
}

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
        const table = await page.evaluate((longTicket) => {
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
          const ticket = [...panel.querySelectorAll("tbody a")].find(
            (link) => link.textContent === longTicket,
          ) as HTMLElement;
          return {
            panelLeft: panelBox.left,
            panelRight: panelBox.right,
            headers,
            values,
            ticketText: ticket.textContent,
            ticketClientWidth: ticket.clientWidth,
            ticketScrollWidth: ticket.scrollWidth,
          };
        }, LONG_TICKET);
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
        expect(table.ticketText).toBe(LONG_TICKET);
        expect(table.ticketScrollWidth).toBeLessThanOrEqual(table.ticketClientWidth + 1);
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

  it(
    "explains an empty repository scoreboard",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1280,
        height: 600,
        colorScheme: "dark",
        api: api([]),
        search: "?path=/telemetry%3Ftab%3Dthroughput%26view%3Dtable",
      });
      try {
        await ready(page);
        expect(page.errors()).toEqual([]);
        const text = await page.evaluate(
          () => document.querySelector("#tRepoScoreboard")?.textContent,
          undefined,
        );
        expect(text).toContain("No repository telemetry is configured yet.");
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );

  for (const [width, height, scheme] of [
    [1280, 600, "dark"],
    [1280, 600, "light"],
    [1600, 1000, "dark"],
    [1600, 1000, "light"],
    [1920, 1000, "dark"],
    [1920, 1000, "light"],
  ] as const) {
    it(
      `keeps every crew repository in the first scoreboard view at ${width}x${height}, ${scheme}`,
      async () => {
        const page = await renderAt({
          page: "test/desktopBrowser.html",
          width,
          height,
          colorScheme: scheme,
          api: api(repoWeeksFixture(3, false)),
          search: "?path=/telemetry%3Ftab%3Dthroughput%26view%3Dtable",
        });
        try {
          await ready(page);
          const scoreboard = await page.evaluate(() => {
            const panel = document.querySelector("#tRepoScoreboard") as HTMLElement;
            const scroll = panel.querySelector(".repo-scoreboard-scroll") as HTMLElement;
            const rows = [...panel.querySelectorAll(".repo-scoreboard-repo")] as HTMLElement[];
            const headers = [...panel.querySelectorAll("thead th")].map((cell) => {
              const box = cell.getBoundingClientRect();
              return { left: box.left, right: box.right };
            });
            const cells = [...panel.querySelectorAll("tbody tr:first-child > *")].map((cell) => {
              const box = cell.getBoundingClientRect();
              return { left: box.left, right: box.right };
            });
            const scrollBox = scroll.getBoundingClientRect();
            return {
              count: rows.length,
              cue: panel.querySelector(".repo-scoreboard-cue")?.textContent,
              headers,
              cells,
              rowsVisible: rows.every(
                (row) => row.getBoundingClientRect().bottom <= scrollBox.bottom + 1,
              ),
              rowBottoms: rows.map((row) => row.getBoundingClientRect().bottom),
              scrollBottom: scrollBox.bottom,
              text: panel.textContent,
            };
          }, undefined);
          expect(page.errors()).toEqual([]);
          expect(scoreboard.count).toBe(3);
          expect(scoreboard.cue).toContain("3 repositories · all visible");
          expect(scoreboard.rowsVisible, JSON.stringify(scoreboard)).toBe(true);
          expect(scoreboard.text).toContain("No merged PRs");
          expect(scoreboard.text).toContain("crew-repo-3");
          expect(scoreboard.headers).toHaveLength(6);
          expect(scoreboard.cells).toHaveLength(6);
          for (const [index, header] of scoreboard.headers.entries()) {
            const cell = scoreboard.cells[index];
            expect(Math.abs(header.left - cell.left), `column ${index} left`).toBeLessThanOrEqual(
              1,
            );
            expect(
              Math.abs(header.right - cell.right),
              `column ${index} right`,
            ).toBeLessThanOrEqual(1);
          }
        } finally {
          await page.close();
        }
      },
      BROWSER_TEST_TIMEOUT_MS,
    );
  }

  it(
    "keeps many repositories scrollable by keyboard without hiding their long values",
    async () => {
      const page = await renderAt({
        page: "test/desktopBrowser.html",
        width: 1280,
        height: 600,
        colorScheme: "dark",
        api: api(repoWeeksFixture(12)),
        search: "?path=/telemetry%3Ftab%3Dthroughput%26view%3Dtable",
      });
      try {
        await ready(page);
        const scoreboard = await page.evaluate(() => {
          const panel = document.querySelector("#tRepoScoreboard") as HTMLElement;
          const scroll = panel.querySelector(".repo-scoreboard-scroll") as HTMLElement;
          scroll.focus();
          const outline = getComputedStyle(scroll).outlineStyle;
          scroll.scrollTop = scroll.scrollHeight;
          const final = panel.querySelector(".repo-scoreboard-repo:last-child") as HTMLElement;
          const scrollBox = scroll.getBoundingClientRect();
          return {
            count: panel.querySelectorAll(".repo-scoreboard-repo").length,
            cue: panel.querySelector(".repo-scoreboard-cue")?.textContent,
            outline,
            finalVisible: final.getBoundingClientRect().bottom <= scrollBox.bottom + 1,
            text: panel.textContent,
          };
        }, undefined);
        expect(page.errors()).toEqual([]);
        expect(scoreboard.count).toBe(12);
        expect(scoreboard.cue).toContain("12 repositories · scroll to compare all");
        expect(scoreboard.outline).not.toBe("none");
        expect(scoreboard.finalVisible).toBe(true);
        expect(scoreboard.text).toContain(
          "repository-with-a-deliberately-long-name-that-must-remain-reachable-in-the-scoreboard",
        );
      } finally {
        await page.close();
      }
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
