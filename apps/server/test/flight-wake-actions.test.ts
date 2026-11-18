import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLIGHT_NON_ACTING_TOOLS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noActionReasons, wakeActionSummary } from "../src/flight/wake-actions.ts";
import { Store } from "../src/store.ts";

const MIN = 60_000;
const T = 1_793_000_000_000;
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-flight-wake-actions-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("FLIGHT wake actions", () => {
  it("counts a wake as acted only for a state-changing call before the next wake", () => {
    store.addFlightWake("f1", T, ["prs"]);
    store.addFlightWake("f1", T + 10 * MIN, ["prs"]);
    store.addFlightWake("f1", T + 20 * MIN, ["prs"]);
    store.recordToolCall({
      at: T + MIN,
      runId: "f1",
      tool: "flight_state",
      written: 0,
      returned: 0,
    });
    store.recordToolCall({
      at: T + 2 * MIN,
      runId: "f1",
      tool: "log_decision",
      written: 0,
      returned: 0,
    });
    store.recordToolCall({
      at: T + 11 * MIN,
      runId: "f1",
      tool: "merge_pr",
      written: 0,
      returned: 0,
    });
    store.recordToolCall({
      at: T + 21 * MIN,
      runId: "other",
      tool: "merge_pr",
      written: 0,
      returned: 0,
    });
    const wakes = store.flightWakeActions(T, T + 30 * MIN, FLIGHT_NON_ACTING_TOOLS);
    expect(wakes.map((wake) => wake.acted)).toEqual([false, true, false]);
    expect(wakeActionSummary(wakes, [])).toMatchObject({ wakes: 3, noAction: 2, share: 2 / 3 });
  });

  it("batches past 80% with 10 wakes, never an immediate reason", () => {
    const wakes = [
      ...Array.from({ length: 10 }, (_, n) => ({
        runId: "f",
        at: n,
        reasons: ["prs"],
        rode: [],
        immediate: [],
        acted: n === 0,
      })),
      ...Array.from({ length: 10 }, (_, n) => ({
        runId: "f",
        at: n,
        reasons: ["stopped"],
        rode: [],
        immediate: [],
        acted: n < 2,
      })),
      ...Array.from({ length: 9 }, (_, n) => ({
        runId: "f",
        at: n,
        reasons: ["t"],
        rode: [],
        immediate: [],
        acted: false,
      })),
      ...Array.from({ length: 10 }, (_, n) => ({
        runId: "f",
        at: n,
        reasons: ["q"],
        rode: [],
        immediate: [],
        acted: false,
      })),
      ...Array.from({ length: 10 }, (_, n) => ({
        runId: "f",
        at: n,
        reasons: [],
        rode: ["items"],
        immediate: [],
        acted: false,
      })),
    ];
    expect(noActionReasons(wakes)).toEqual(["prs"]);
  });

  it("does not learn from wakes an immediate fact caused", () => {
    const wake = (acted: boolean, immediate: string[], reasons = ["prs"]) => ({
      runId: "f",
      at: 0,
      reasons,
      rode: [],
      immediate,
      acted,
    });
    expect(
      noActionReasons([
        ...Array.from({ length: 10 }, () => wake(false, [])),
        ...Array.from({ length: 5 }, () => wake(true, ["prs"])),
      ]),
    ).toEqual(["prs"]);
    expect(
      noActionReasons(Array.from({ length: 10 }, () => wake(false, [], ["discussions"]))),
    ).toEqual([]);
  });
});
