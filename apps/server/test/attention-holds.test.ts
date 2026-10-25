import { afterAll, afterEach, expect, it } from "vitest";
import { evaluateHolds, holdItem, holds, releaseHold } from "../src/attention-holds.ts";
import { Store } from "../src/store.ts";

const store = new Store(":memory:");
afterAll(() => store.close());
afterEach(() => store.setSetting("attention-holds", "{}"));
it("persists a reason and supports one-click manual release", () => {
  holdItem(store, "ask:1", "Waiting", { kind: "manual" }, "operator", 10);
  expect(holds(store)["ask:1"]?.reason).toBe("Waiting");
  releaseHold(store, "ask:1", 20);
  expect(holds(store)["ask:1"]?.releasedAt).toBe(20);
});
it.each([
  [{ kind: "date", at: 20 }, false, false],
  [{ kind: "ticket", ticket: "demo#1" }, true, false],
  [{ kind: "crew" }, false, true],
] as const)("releases %j only when its condition is met", (condition, merged, resumed) => {
  holdItem(store, "ask:1", "Waiting", condition, "operator", 10);
  expect(
    evaluateHolds(
      store,
      15,
      () => false,
      () => false,
    ),
  ).toBe(false);
  expect(
    evaluateHolds(
      store,
      20,
      () => merged,
      () => resumed,
    ),
  ).toBe(true);
  expect(holds(store)["ask:1"]?.releasedAt).toBe(20);
});
it("never automatically releases a manual hold", () => {
  holdItem(store, "ask:1", "Waiting", { kind: "manual" }, "operator", 10);
  expect(
    evaluateHolds(
      store,
      100,
      () => true,
      () => true,
    ),
  ).toBe(false);
});
