import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunDigest } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightWakeCost, flightWakeWaits } from "../src/flight/cost.ts";
import { flightView } from "../src/flight/state.ts";
import { runSpend } from "../src/spend/spend.ts";
import { MAX_OPEN_RUN_AGE_MS, Store } from "../src/store.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = 1_793_000_000_000;
const CREW = new Set(["flight-1", "guido-1"]);

const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 2,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "main", model: "opus", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "main", model: "opus", area: [] },
        ],
      },
    ],
  },
};

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-financial-facts-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const run = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: ++seq,
  startedAt: NOW - 2 * DAY,
  endedAt: NOW - 1,
  status: "ok",
  sessionId: "cli",
  model: "opus",
  branch: null,
  ticket: null,
  costUsd: 1,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});
const usage = (runId: string, entries: [number | null, number][], extra: object = {}) =>
  store.setDigest(runId, {
    ...extra,
    attemptUsage: entries.map(([at, tokens], i) => ({ id: `m${i}`, at, tokens })),
  } as RunDigest);

/** A fixture holding every case the figures treat apart. */
function seed(): void {
  store.upsertRun(run("f-usage", "flight-1", { costUsd: 10 }));
  usage("f-usage", [
    [NOW - 40 * MIN, 100],
    [NOW - 9 * MIN, 300],
    [null, 50],
    [NOW + 5 * MIN, 50],
  ]);
  store.upsertRun(run("f-empty", "flight-1", { costUsd: 3, startedAt: NOW - DAY }));
  usage("f-empty", []);
  store.upsertRun(run("f-nodigest", "flight-1", { costUsd: null, startedAt: NOW - 3 * DAY }));
  store.upsertRun(
    run("g-live", "guido-1", {
      status: "running",
      endedAt: null,
      startedAt: NOW - 3 * MIN,
      costUsd: 4,
    }),
  );
  store.upsertRun(
    run("g-live2", "guido-1", {
      status: "running",
      endedAt: null,
      startedAt: NOW - 2 * MIN,
      costUsd: 2,
    }),
  );
  store.upsertRun(
    run("g-unknown", "guido-1", {
      status: "ok",
      endedAt: null,
      startedAt: NOW - DAY,
      costUsd: 5,
    }),
  );
  store.upsertRun(
    run("g-stale", "guido-1", {
      status: "running",
      endedAt: null,
      startedAt: NOW - MAX_OPEN_RUN_AGE_MS - DAY,
      costUsd: 99,
    }),
  );
  store.upsertRun(
    run("g-zero", "guido-1", { startedAt: NOW - DAY, endedAt: NOW - DAY, costUsd: 6 }),
  );
  store.upsertRun(run("g-edge", "guido-1", { startedAt: NOW - 7 * DAY, endedAt: NOW - 6 * DAY }));
  usage("g-edge", [[NOW - 7 * DAY, 10]]);
  store.upsertRun(run("other", "somebody", { costUsd: 50 }));
  store.addFlightWake("f-usage", NOW - 30 * MIN, ["items", "free"]);
  store.addFlightWake("f-usage", NOW - 10 * MIN, ["q"]);
  store.addFlightWake("f-usage", NOW - 5 * MIN, []);
}

describe("the narrow financial read", () => {
  it("holds the runs and spend a full read of the same runs does", () => {
    seed();
    const since = NOW - 7 * DAY;
    const narrow = store.financialRuns(since, NOW + 1, new Set([...CREW, "somebody"]));
    const full = store.runsOverlapping(since, NOW + 1);
    expect(narrow.map((r) => r.id)).toEqual(full.map((r) => r.id));
    expect(narrow.map((r) => r.id)).not.toContain("g-stale");
    const digests = store.digests(full.map((r) => r.id));
    for (const [i, r] of full.entries()) {
      const n = narrow[i];
      expect(n).toMatchObject({
        agentId: r.agentId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        status: r.status,
        costUsd: r.costUsd,
      });
      expect(n?.attemptUsage.map((u) => [u.at, u.tokens])).toEqual(
        (digests.get(r.id)?.attemptUsage ?? []).map((u) => [u.at, u.tokens]),
      );
      expect(runSpend(n as NonNullable<typeof n>, n, since, NOW, DAY)).toEqual(
        runSpend(r, digests.get(r.id), since, NOW, DAY),
      );
    }
  });

  it("leaves out runs of agents that were not asked for", () => {
    seed();
    const ids = store.financialRuns(NOW - 7 * DAY, NOW + 1, new Set(["flight-1"])).map((r) => r.id);
    expect(ids.sort()).toEqual(["f-empty", "f-nodigest", "f-usage"]);
  });
});

describe("the figures read the narrow facts once", () => {
  it("decodes no run row or digest through the full readers", () => {
    seed();
    const runs = vi.spyOn(store, "runsOverlapping");
    const digests = vi.spyOn(store, "digests");
    const narrow = vi.spyOn(store, "financialRuns");
    flightWakeCost(store, NOW, "flight-1", CREW);
    flightWakeWaits(store, NOW, "flight-1", "mc");
    expect(runs).not.toHaveBeenCalled();
    expect(digests).not.toHaveBeenCalled();
    expect(narrow).toHaveBeenCalledTimes(2);
  });

  it("is read once, with the wakes, for a whole flightView", () => {
    seed();
    const narrow = vi.spyOn(store, "financialRuns");
    const wakes = vi.spyOn(store, "flightWakes");
    const view = flightView(config, store, NOW);
    expect(narrow).toHaveBeenCalledTimes(1);
    expect(wakes.mock.calls.filter(([since]) => since === NOW - 14 * DAY)).toHaveLength(1);
    expect(view.wakeCost).toEqual(flightWakeCost(store, NOW, "flight-1", CREW));
    expect(view.wakeWaits).toEqual(flightWakeWaits(store, NOW, "flight-1", "mc"));
  });

  it("shows a changed run, digest or wake on the next request in the same second", () => {
    seed();
    const before = flightView(config, store, NOW);
    store.upsertRun(run("f-usage", "flight-1", { costUsd: 20 }));
    usage("f-usage", [
      [NOW - 40 * MIN, 100],
      [NOW - 9 * MIN, 100],
    ]);
    store.addFlightWake("f-usage", NOW - 9 * MIN, ["new"]);
    const after = flightView(config, store, NOW);
    expect(after.wakeCost?.totalUsd).not.toBe(before.wakeCost?.totalUsd);
    expect(after.wakeCost?.byReason.map((r) => r.reason)).toContain("new");
    expect(after.wakeWaits).toEqual(flightWakeWaits(store, NOW, "flight-1", "mc"));
  });
});
