import type { CrewRow, LimitRow } from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { seedFromSearch } from "../src/demo/random.ts";
import { getState, playNext, setSceneSeed } from "../src/demo/simulator.ts";

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
    expect(rows().some((r) => r.loop?.parked?.startsWith("merge held by"))).toBe(true);
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
