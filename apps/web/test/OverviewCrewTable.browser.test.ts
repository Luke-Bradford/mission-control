// @vitest-environment node

import type { Crew, CrewRow } from "@mc/core";
import { expect, it } from "vitest";
import {
  type Box,
  BROWSER_TEST_TIMEOUT_MS,
  browserSession,
  describeRendered,
} from "./browserRunner.ts";
import { CONFIG, crewRow, item, METRICS_VIEW, NOW, OVERVIEW, seatRow } from "./fixtures.ts";

const { renderAt } = browserSession();

const LONG =
  "apps/server/test/live/skills-live-check.ts stub report_evidence MCP tool Skill call ".repeat(5);
const PARK = { kind: "review", reason: "RETRO-CX found blocking issues in 3 reviews" } as const;
const loop = (text: string) => ({
  phase: "working" as const,
  text,
  prNumber: null,
  parked: null,
  profile: "build",
  step: "implement",
  steps: [
    { name: "implement", phase: "working" as const },
    { name: "ci", phase: "ci" as const },
  ],
});

const crew: Crew = {
  rows: [
    seatRow({
      id: "guido-1",
      ticketTitle: LONG,
      loop: loop(LONG),
      note: LONG,
      hudState: "running",
    }),
    crewRow({
      id: "guido-2",
      ticket: null,
      ticketTitle: null,
      note: LONG,
      hudState: "idle",
      run: null,
    }),
    crewRow({ id: "inco-1", ticketTitle: "Short", loop: loop("Editing"), hudState: "running" }),
    // parked on RETRO's findings: the Loop cell offers the waiver beside its step bar
    crewRow({
      id: "retro-1",
      loop: { ...loop("Waiting"), phase: "parked", parked: PARK.reason },
      hudState: "parked",
    }),
    // a parked current run plus two parked set-aside runs: one menu lists all three waivers
    crewRow({
      id: "retro-2",
      loop: { ...loop("Waiting"), phase: "parked", parked: PARK.reason },
      hudState: "parked",
      run: { ...(crewRow().run as NonNullable<CrewRow["run"]>), id: "r-20" },
      asideRuns: ["r-21", "r-22"].map((runId) => ({
        runId,
        ticket: null,
        ticketTitle: null,
        loop: { ...loop("Waiting"), phase: "parked", parked: PARK.reason },
      })),
    }),
  ],
  firstRunToday: null,
};

const api = {
  "/api/overview": OVERVIEW,
  "/api/metrics": METRICS_VIEW,
  "/api/overview/timeline": { from: NOW - 3_600_000, to: NOW, lanes: [] },
  "/api/crew": crew,
  "/api/runs/r-12/loop": {
    loop: { phase: "parked", parked: PARK, pushFor: "c74cdfc0123456789", prNumber: null },
  },
  ...Object.fromEntries(
    ["r-20", "r-21", "r-22"].map((id, i) => [
      `/api/runs/${id}/loop`,
      { loop: { phase: "parked", parked: PARK, pushFor: `c74cdf${i}0123456789`, prNumber: null } },
    ]),
  ),
  "/api/attention": [
    item({ key: "ask:guido-1", kind: "decision", agentId: "guido-1", text: LONG, ticket: null }),
  ],
  "/api/machine": { latest: null, warning: null, maxSeats: 8, seats: 0, perSessionMax: 0 },
  "/api/limits": [],
  "/api/limits/github": { queries: {}, pollCost: null },
  "/api/health": [],
  "/api/activity": [],
  "/api/settings/away": { on: false, until: "", may: {} },
  "/api/config": CONFIG,
  "/api/test-lock": { holder: null, waiting: [] },
  "/api/crew/status": { enabled: true, note: null },
  "/api/repos/shop-app/prs?linked=1": [],
};

describeRendered("Overview Crew table with very long text, rendered", () => {
  it.each([1100, 1280, 1366, 1600])(
    "keeps every cell inside its own row at %ipx",
    async (width) => {
      const page = await renderAt({ page: "test/overviewBrowser.html", width, height: 1000, api });
      const rowBoxes = await page.boxes("#agentsList .trow:not(.head)");
      const cellBoxes = await page.boxes("#agentsList .trow:not(.head) > [role=cell]");
      expect(rowBoxes.length).toBeGreaterThanOrEqual(3);
      const rowHeight = rowBoxes[0].height;
      for (const row of rowBoxes) expect(row.height).toBeCloseTo(rowHeight, 0);
      // every cell sits inside some row's box, so nothing spills over a neighbour
      for (const [i, cell] of cellBoxes.entries()) {
        const row = rowBoxes.find((r) => cell.y >= r.y - 0.5 && cell.y < r.y + r.height);
        expect(row, `cell ${i} starts in a row`).toBeDefined();
        const r = row as (typeof rowBoxes)[number];
        expect(cell.y + cell.height, `cell ${i} bottom`).toBeLessThanOrEqual(r.y + r.height + 0.5);
      }
      // an element wider than its cell must be cut by a clipping ancestor that stays inside the cell
      const spill = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head) *")]
            .filter((el) => {
              const cell = el.closest<HTMLElement>("[role=cell]");
              if (!cell || el === cell) return false;
              const b = cell.getBoundingClientRect();
              const a = el.getBoundingClientRect();
              if (a.width === 0 || (a.right <= b.right + 0.5 && a.bottom <= b.bottom + 0.5))
                return false;
              for (let n = el.parentElement; n; n = n.parentElement) {
                const r = n.getBoundingClientRect();
                if (getComputedStyle(n).overflow !== "visible" && r.right <= b.right + 0.5)
                  return false;
                if (n === cell) break;
              }
              return true;
            })
            .map(
              (el) => `${el.tagName}.${el.className} in ${el.closest("[role=cell]")?.className}`,
            ),
        undefined,
      );
      expect(spill).toEqual([]);
      // nothing inside a crew row hangs below it, unless an ancestor inside the row clips it
      const hanging = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head)")].flatMap(
            (row) => {
              const bottom = row.getBoundingClientRect().bottom + 0.5;
              return [...row.querySelectorAll<HTMLElement>("*")]
                .filter((el) => {
                  const r = el.getBoundingClientRect();
                  if (r.height === 0 || r.bottom <= bottom) return false;
                  for (let n = el.parentElement; n && n !== row; n = n.parentElement)
                    if (
                      getComputedStyle(n).overflow !== "visible" &&
                      n.getBoundingClientRect().bottom <= bottom
                    )
                      return false;
                  return true;
                })
                .map((el) => `${el.tagName}.${el.className}: ${el.textContent?.slice(0, 40)}`);
            },
          ),
        undefined,
      );
      expect(hanging).toEqual([]);
      expect(await page.boxes("#agentsList .waive-compact button")).toHaveLength(1);
      // three parked runs on one seat give one menu in the row, with an action for each run
      const [menu] = await page.boxes("#agentsList .waive-compact select");
      const menuRow = (await page.boxes("#agentsList .trow:not(.head)")).find(
        (r) => menu.y >= r.y && menu.y < r.y + r.height,
      ) as Box;
      expect(menu.y + menu.height).toBeLessThanOrEqual(menuRow.y + menuRow.height + 0.5);
      expect(
        await page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLOptionElement>("#agentsList .waive-compact option")]
              .filter((o) => o.value)
              .map((o) => o.value),
          undefined,
        ),
      ).toEqual(["r-20", "r-21", "r-22"]);
      // the crew seat's Work cell carries Answer, Interrupt and End, each whole and apart
      const buttons = await page.boxes("#agentsList .work-cell .need button");
      const cell = await page.box("#agentsList .work-cell:has(.need)");
      expect(buttons.length).toBeGreaterThanOrEqual(3);
      for (const [i, b] of buttons.entries()) {
        expect(b.x, `button ${i} left`).toBeGreaterThanOrEqual(cell.x - 0.5);
        expect(b.x + b.width, `button ${i} right`).toBeLessThanOrEqual(cell.x + cell.width + 0.5);
        for (const o of buttons.slice(i + 1))
          expect(b.x + b.width, `button ${i} clear of the next`).toBeLessThanOrEqual(o.x + 0.5);
      }
      // Agent, State and Work (with its Needs controls) lay their content on one visual line
      const stacked = await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "#agentsList .trow:not(.head) :is(.agent-identity, .state-cell, .work-cell)",
            ),
          ]
            .filter((cell) => {
              const leaves = [...cell.querySelectorAll<HTMLElement>("*")]
                .filter((el) => el.children.length === 0)
                .map((el) => el.getBoundingClientRect())
                .filter((r) => r.width > 0 && r.height > 0);
              if (leaves.length < 2) return false;
              return (
                Math.max(...leaves.map((r) => r.top)) >= Math.min(...leaves.map((r) => r.bottom))
              );
            })
            .map((cell) => cell.className),
        undefined,
      );
      expect(stacked).toEqual([]);
      // free text is cut on one line with an ellipsis, not wrapped
      const wrapped = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>("#agentsList .trow:not(.head) .ellip")]
            .filter((el) => {
              const s = getComputedStyle(el);
              return (
                s.whiteSpace !== "nowrap" ||
                s.overflow !== "hidden" ||
                s.textOverflow !== "ellipsis"
              );
            })
            .map((el) => el.className),
        undefined,
      );
      expect(wrapped).toEqual([]);
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
