import type { CrewRow, LimitRow } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedFromSearch } from "../src/demo/random.ts";
import { getState, playNext, setSceneSeed } from "../src/demo/simulator.ts";
import { NOW } from "./fixtures.ts";
import { demoSeed } from "./overviewDensityFixtures.ts";

const BEATS = 45;
const rows = () => (getState().api["/api/crew?shape=summary"] as { rows: CrewRow[] }).rows;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 13, 12));
});
afterEach(() => {
  setSceneSeed(undefined);
  vi.useRealTimers();
});

/** What a viewer could tell two scenes apart by, after `beats` beats from `seed`. */
function play(seed: number, beats = BEATS) {
  setSceneSeed(seed);
  for (let i = 0; i < beats; i++) playNext();
  const s = getState();
  return JSON.stringify({
    tickets: s.tickets,
    states: rows().map((r) => [r.id, r.hudState, r.loop?.phase, r.note]),
    flags: [...s.prFlags],
    plan: [s.plan.arrives, s.plan.answered, [...s.plan.incidents]],
    asks: (s.api["/api/attention"] as { key: string }[]).map((q) => q.key),
  });
}

it("the same seed plays the same scene, and another seed plays another", () => {
  expect(play(7, 30)).toBe(play(7, 30));
  expect(play(7, 30)).not.toBe(play(8, 30));
  expect(play(7)).toBe(play(7));
});

it("builds an uneven, repeatable day with the awkward cases in view", () => {
  const first = demoSeed(17);
  const again = demoSeed(17);
  const other = demoSeed(18);
  expect(JSON.stringify(first.rows)).toBe(JSON.stringify(again.rows));
  expect(JSON.stringify(first.rows)).not.toBe(JSON.stringify(other.rows));

  const rows = first.rows;
  expect((first.api["/api/repos"] as { id: string }[]).map((repo) => repo.id)).toEqual([
    "mission-control",
    "eBull",
    "autonomy-engine",
  ]);
  expect(first.api["/api/boards/autonomy-engine"]).toEqual([]);
  for (const repoId of ["mission-control", "eBull", "autonomy-engine"])
    expect(first.api[`/api/repos/${repoId}/rules`]).toBeDefined();
  expect(first.api["/api/flight/memory?repo=mission-control"]).toBeDefined();
  expect(rows[1]?.hudState).toBe("running");
  const reworked = first.api["/api/tickets/shop-app/108"] as {
    prs: { rounds: unknown[]; ci: { checks: { name: string }[] }[] }[];
  };
  expect(reworked.prs[0]?.rounds).toHaveLength(3);
  expect(
    reworked.prs[0]?.ci.flatMap((run) => run.checks).some((check) => check.name.includes("re-run")),
  ).toBe(true);
  expect(new Set(rows.map((row) => row.hudState)).size).toBeGreaterThanOrEqual(5);
  expect(
    rows.every((row, index) => {
      const previous = rows[index - 1];
      return (
        !previous ||
        `${row.hudState}:${row.run?.costUsd}` !== `${previous.hudState}:${previous.run?.costUsd}`
      );
    }),
  ).toBe(true);
  expect(rows.some((row) => row.run && NOW - row.run.startedAt >= 6 * 60 * 60 * 1000)).toBe(true);
  expect(rows.some((row) => row.hudState === "parked")).toBe(true);
  expect(rows.some((row) => row.note?.includes("FLIGHT"))).toBe(true);
  expect(rows.some((row) => row.hudState === "error")).toBe(true);
  expect(
    (first.api["/api/machine"] as { latest: { diskFreeBytes: number } }).latest.diskFreeBytes,
  ).toBeLessThanOrEqual(20 * 2 ** 30);
});

it("takes its seed from the address, and falls back to 1", () => {
  expect(seedFromSearch("?seed=42")).toBe(42);
  expect(seedFromSearch("?seed=nope")).toBe(1);
  expect(seedFromSearch("")).toBe(1);
});

it.each(Array.from({ length: 25 }, (_, i) => i + 1))(
  "seed %i shows every state a busy crew has",
  (seed) => {
    setSceneSeed(seed);
    for (let i = 0; i < BEATS; i++) playNext();
    const s = getState();
    const states = rows().map((r) => r.hudState);
    expect(states).toContain("idle");
    expect(states).toContain("stalled");
    expect(states).toContain("stopped");
    expect(states).toContain("error");
    expect(rows().some((r) => r.loop?.hold?.reason?.startsWith("merge held by"))).toBe(true);
    expect(rows().some((r) => r.loop?.tries?.n === 2 && r.loop.step === "review")).toBe(true);
    expect(rows().find((r) => r.run?.status === "failed")?.hudState).toBe("error");
    expect((s.api["/api/limits"] as LimitRow[]).some((l) => l.used >= l.stopAt)).toBe(true);
    const prs = s.api["/api/repos/shop-app/prs"] as {
      ci: string | null;
      mergeable: string | null;
    }[];
    expect(prs.some((p) => p.ci === "failing")).toBe(true);
    expect(prs.some((p) => p.mergeable === "CONFLICTING")).toBe(true);
    // Small and odd figures, and a long title.
    expect(rows().some((r) => (r.ticketTitle?.length ?? 0) > 100)).toBe(true);
    expect(rows().some((r) => r.digest?.toolCalls === 0)).toBe(true);
  },
);

it.each(Array.from({ length: 25 }, (_, i) => i + 1))(
  "seed %i opens with an idle seat, a stuck one and a red PR already there",
  (seed) => {
    setSceneSeed(seed);
    const s = getState();
    const states = rows().map((r) => r.hudState);
    expect(states).toContain("idle");
    expect(states).toContain("stalled");
    expect(s.prFlags.size).toBeGreaterThanOrEqual(1);
  },
);

it("the next scene does not start from an all-running crew", () => {
  setSceneSeed(3);
  for (let i = 0; i < BEATS + 1; i++) playNext();
  expect(getState().loops).toBe(1);
  expect(rows().map((r) => r.hudState)).toContain("stalled");
});
