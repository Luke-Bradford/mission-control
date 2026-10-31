// @vitest-environment node

import { type LoopTry, pushChecksText, type RunLoopView } from "@mc/core";
import { expect, it } from "vitest";
import { RESOURCES } from "../src/data.ts";
import { BROWSER_TEST_TIMEOUT_MS, browserSession, describeRendered } from "./browserRunner.ts";
import { crewRow, MIN, NOW } from "./fixtures.ts";

const { renderAt } = browserSession();

const RUN = "r-12";
const SEAT = "inco-1";
const SHA = "c74cdfc1234567";
// What GUIDO-1 showed on #1015: the developer's reply and RETRO's findings, about 2,000 characters.
const PARK = `RETRO-CX reviewed c74cdfc and found 1 issue to resolve before this PR can merge. ${"Please address each finding below, or explain why it should not change. ".repeat(12)}\n\n1. [Important] apps/web/src/overview/overview.css:36 — the grid clips\n   Why: ${"the rows shrink to nothing when the window is short. ".repeat(10)}`;
const REFUSAL = pushChecksText("80001f8abcdef", [{ command: "pnpm -s test", state: "missing" }]);

const at = (index: number) => NOW - 600 * MIN + index * 20 * MIN;
const tryOf = (
  step: LoopTry["step"],
  n: number,
  index: number,
  outcome: LoopTry["outcome"],
  reason: string | null = null,
): LoopTry => ({
  step,
  fix: false,
  n,
  tokens: 400,
  startedAt: at(index),
  endedAt: at(index) + 10 * MIN,
  outcome,
  reason,
});
const tries: LoopTry[] = [
  ...Array.from({ length: 6 }, (_, i) => tryOf("working", i + 1, i, "pass")),
  ...Array.from({ length: 15 }, (_, i) => tryOf("ci", i + 1, 6 + i, "fail", REFUSAL)),
  tryOf("review", 1, 21, "parked", PARK),
];
const view: RunLoopView = {
  runId: RUN,
  loop: {
    phase: "parked",
    pushFor: SHA,
    prNumber: 77,
    parked: { kind: "review", reason: PARK, ended: false },
  } as RunLoopView["loop"] & object,
  events: [],
  tries,
  round: 3,
  budget: null,
  review: null,
};
const row = crewRow({
  id: SEAT,
  kind: "crew",
  hudState: "idle",
  loop: { phase: "parked", text: `Blocked: ${PARK}`, parked: PARK, prNumber: 77 },
});
const api = {
  [RESOURCES.runLoop(RUN).path]: view,
  [RESOURCES.runs(SEAT).path]: [],
  [RESOURCES.crew.path]: { rows: [row], firstRunToday: null },
  [RESOURCES.crewDetail(SEAT).path]: row,
  [RESOURCES.attention.path]: [],
  [RESOURCES.limits.path]: [],
};

describeRendered("The Agent page's Loop panel, rendered", () => {
  it.each([
    [1280, 1400, "light"],
    [1280, 1400, "dark"],
    [1600, 1400, "light"],
    [1600, 1400, "dark"],
  ] as const)(
    "shows no text block over 3 lines in the header or the panel at %ix%i, %s",
    async (width, height, scheme) => {
      const page = await renderAt({
        page: "test/traceBrowser.html",
        width,
        height,
        colorScheme: scheme,
        api,
      });
      await page.box("#loopP .vstep");
      const tall = await page.evaluate(() => {
        const lines = (el: Element) => {
          const style = getComputedStyle(el);
          const lh = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
          return el.getBoundingClientRect().height / lh;
        };
        return [...document.querySelectorAll("#loopP *, #ahead .doing, #ahead .doing *")]
          .filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() !== "")
          .filter((el) => lines(el) > 3.2)
          .map((el) => `${el.className}: ${(el.textContent ?? "").slice(0, 40)}`);
      }, null);
      expect(tall).toEqual([]);
      const text = await page.evaluate(() => document.querySelector("#loopP")?.textContent, null);
      expect(text).toContain("waiting: 1 finding held on c74cdfc");
      expect(text).not.toContain("the grid clips");
      const header = await page.evaluate(() => document.querySelector("#ahead")?.textContent, null);
      expect(header).toContain("Parked · review findings on c74cdfc · 1 held");
      expect(header).not.toContain("the grid clips");
      expect(await page.reachable("#loopP .vstep")).not.toContain(false);
      if (process.env.MC_SHOT_DIR) {
        await page.screenshot(`${process.env.MC_SHOT_DIR}/loop-${width}-${scheme}.png`);
      }
      await page.close();
    },
    BROWSER_TEST_TIMEOUT_MS,
  );
});
