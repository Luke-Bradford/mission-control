import type { CrewRow, MapDelta } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityValues } from "../src/overview/agentActivity.ts";
import { NOW } from "./fixtures.ts";

type Sim = typeof import("../src/demo/simulator.ts");
type Source = typeof import("../src/demo/source.ts");
type Emitted = { type: string; data: unknown };

function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  visibility("visible");
  vi.useRealTimers();
  vi.resetModules();
});

async function fresh(): Promise<{ sim: Sim; source: Source }> {
  vi.resetModules();
  return {
    sim: await import("../src/demo/simulator.ts"),
    source: await import("../src/demo/source.ts"),
  };
}

describe("the scene", () => {
  it("is 45 beats a loop, 4 seconds apart, with at most 2 topics a beat", async () => {
    const { sim } = await fresh();
    expect(sim.DEMO_SCENE).toHaveLength(45);
    expect(sim.DEMO_BEAT_MS).toBe(4000);
    for (const beat of sim.DEMO_SCENE) expect(beat.topics.length).toBeLessThanOrEqual(2);
    // A 3-minute loop.
    expect(sim.DEMO_SCENE.length * sim.DEMO_BEAT_MS).toBe(180_000);
  });

  it("plays twice on a frozen clock to the same events and the same answers", async () => {
    const play = async () => {
      vi.setSystemTime(NOW);
      const { sim, source } = await fresh();
      const events: Emitted[] = [];
      const off = sim.connect("/api/stream?map=shop-app", (type, data) =>
        events.push({ type, data }),
      );
      for (let i = 0; i < 46; i++) await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS);
      const answers = [
        "/api/crew?shape=summary",
        "/api/overview",
        "/api/activity",
        "/api/comms/crew",
        "/api/boards/shop-app",
        "/api/repos/shop-app/map",
      ].map((path) => source.answer(path).clone().text());
      const texts = await Promise.all(answers);
      off();
      return { events, texts };
    };
    const first = await play();
    const second = await play();
    expect(first.events.length).toBeGreaterThan(100);
    expect(second).toEqual(first);
  });

  it("sends Map frames in order, each one applying to the snapshot it follows", async () => {
    const { sim } = await fresh();
    const frames: MapDelta[] = [];
    const off = sim.connect("/api/stream?map=shop-app", (type, data) => {
      if (type === "map") frames.push(data as MapDelta);
    });
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 20);
    off();
    const types = new Set(frames.map((f) => f.type));
    expect(types).toContain("call.start");
    expect(types).toContain("call.end");
    expect(types).toContain("edit");
    for (let i = 1; i < frames.length; i++)
      expect((frames[i] as MapDelta).seq).toBe((frames[i - 1] as MapDelta).seq + 1);
  });

  it("starts over at the loop's end: every topic once, an invalidate, and a Map seq that only rises", async () => {
    const { sim } = await fresh();
    const events: Emitted[] = [];
    const off = sim.connect("/api/stream?map=shop-app", (type, data) =>
      events.push({ type, data }),
    );
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 45);
    const before = events.filter((e) => e.type === "map").length;
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS);
    const after = events.slice(events.length - 8);
    expect(after.some((e) => e.type === "map" && (e.data as MapDelta).type === "invalidate")).toBe(
      true,
    );
    const topics = after
      .filter((e) => e.type === "changed")
      .map((e) => (e.data as { topic: string }).topic);
    expect(new Set(topics)).toEqual(
      new Set(["agents", "boards", "limits", "attention", "machine"]),
    );
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 3);
    const seqs = events.filter((e) => e.type === "map").map((e) => (e.data as MapDelta).seq);
    expect(seqs.length).toBeGreaterThan(before);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    off();
  });
});

describe("tokens burning", () => {
  it("shows tokens in every working seat's last hour, even off a minute mark, and more as beats play", async () => {
    vi.setSystemTime(NOW + 37_123);
    const { sim } = await fresh();
    const rows = () => (sim.getState().api["/api/crew?shape=summary"] as { rows: CrewRow[] }).rows;
    const total = (row: CrewRow) =>
      activityValues(row.digest, Date.now()).reduce((a, b) => a + b, 0);
    expect(
      rows()
        .filter((r) => r.hudState === "running")
        .every((r) => total(r) > 0),
    ).toBe(true);
    const off = sim.connect("/api/stream", () => {});
    const before = total(rows().find((r) => r.id === "dev-1") as CrewRow);
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 20);
    expect(total(rows().find((r) => r.id === "dev-1") as CrewRow)).toBeGreaterThan(before);
    off();
  });
});

describe("the timer", () => {
  it("is one timer, at most 15 beats a minute, and 2 topics a beat", async () => {
    const { sim, source } = await fresh();
    const events: Emitted[] = [];
    const off = sim.connect("/api/stream", (type, data) => events.push({ type, data }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(1);
    const changed = events.filter((e) => e.type === "changed");
    expect(changed.length).toBeLessThanOrEqual(15 * 2);
    expect(sim.getState().beat).toBeLessThanOrEqual(14);
    expect(source.demoMisses()).toEqual([]);
    off();
  });

  it("stops while the tab is hidden and continues at the next beat when it shows again", async () => {
    const { sim } = await fresh();
    const events: Emitted[] = [];
    const off = sim.connect("/api/stream", (type, data) => events.push({ type, data }));
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 3);
    const beat = sim.getState().beat;
    visibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    const count = events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.length).toBe(count);
    expect(sim.getState().beat).toBe(beat);
    visibility("visible");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS);
    expect(sim.getState().beat).toBe(beat + 1);
    off();
  });

  it("drops the state and the timer when the last stream leaves, so the next starts at beat 0", async () => {
    const { sim } = await fresh();
    const a = sim.connect("/api/stream", () => {});
    const b = sim.connect("/api/stream?map=shop-app", () => {});
    await vi.advanceTimersByTimeAsync(sim.DEMO_BEAT_MS * 2);
    a();
    expect(vi.getTimerCount()).toBe(1);
    b();
    expect(vi.getTimerCount()).toBe(0);
    expect(sim.getState().beat).toBe(-1);
  });

  it("moves at the harness's pace when asked", async () => {
    const { sim } = await fresh();
    const off = sim.connect("/api/stream", () => {});
    sim.setBeatMs(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sim.getState().beat).toBeGreaterThanOrEqual(9);
    off();
  });
});
