import type { HealthRow } from "@mc/core";
import { describe, expect, it } from "vitest";
import { HEALTH_FRESHNESS_MS, healthContent, TopicGate } from "../src/topic-gate.ts";

describe("TopicGate", () => {
  it("passes a topic the first time, then only when its content changed", () => {
    let value: unknown = { a: 1 };
    const gate = new TopicGate({ agents: () => value });
    expect(gate.changed("agents")).toBe(true);
    expect(gate.changed("agents")).toBe(false);
    value = { a: 2 };
    expect(gate.changed("agents")).toBe(true);
    expect(gate.changed("agents")).toBe(false);
  });

  it("builds nothing while the topic's basis is unchanged, and again once it moves or is reset", () => {
    let basis = "a";
    let builds = 0;
    const gate = new TopicGate({ agents: () => ++builds }, { agents: () => basis });
    expect(gate.changed("agents")).toBe(true);
    expect(gate.changed("agents")).toBe(false);
    expect(builds).toBe(1);
    basis = "b";
    expect(gate.changed("agents")).toBe(true);
    expect(builds).toBe(2);
    gate.reset();
    expect(gate.changed("agents")).toBe(true);
    expect(builds).toBe(3);
  });

  it("always passes a topic with no content function", () => {
    const gate = new TopicGate({});
    expect(gate.changed("boards")).toBe(true);
    expect(gate.changed("boards")).toBe(true);
  });

  it("passes a topic whose content function throws, and forgets its hash", () => {
    let boom = false;
    const gate = new TopicGate({
      agents: () => {
        if (boom) throw new Error("x");
        return 1;
      },
    });
    expect(gate.changed("agents")).toBe(true);
    boom = true;
    expect(gate.changed("agents")).toBe(true);
    boom = false;
    expect(gate.changed("agents")).toBe(true);
  });
});

describe("healthContent", () => {
  const row = (over: Partial<HealthRow> = {}): HealthRow => ({
    collector: "github",
    ok: true,
    error: null,
    at: 1_000,
    lastOkAt: 1_000,
    failingSince: null,
    ...over,
  });

  it("ignores the recorded time and lastOkAt within one step", () => {
    expect(healthContent([row({ at: 5_000, lastOkAt: 5_000 })])).toEqual(healthContent([row()]));
  });

  it("differs when lastOkAt crosses a step", () => {
    expect(healthContent([row({ lastOkAt: HEALTH_FRESHNESS_MS + 1 })])).not.toEqual(
      healthContent([row()]),
    );
  });

  it("differs when ok or error differ", () => {
    expect(healthContent([row({ ok: false })])).not.toEqual(healthContent([row()]));
    expect(healthContent([row({ error: "boom" })])).not.toEqual(healthContent([row()]));
  });
});
