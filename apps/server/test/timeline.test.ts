import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEW_LOOP,
  parkedEventText,
  type Run,
  type SeatSessionRow,
  TIMELINE_TICKS_MAX,
  TIMELINE_WINDOW_MS,
} from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { foldTranscript } from "../src/streamjson.ts";
import { overviewTimeline } from "../src/timeline.ts";

const NOW = 10_000_000;
const FROM = NOW - TIMELINE_WINDOW_MS;
const config: CcConfig = {
  poll: { usageMinutes: 5, githubSeconds: 60 },
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [
    {
      id: "loop",
      repoId: "repo",
      kind: "ta-loop",
      accountId: "a",
      stateDir: "/tmp/ta",
      worktree: "/tmp/wt",
      launchdLabel: "x",
    },
  ],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "session",
        repoId: "repo",
        checkout: "/tmp/wt",
        seats: [
          { id: "dev", role: "DEV", accountId: "a", model: "opus", area: [] },
          { id: "retro", role: "RETRO", accountId: "a", model: "opus", area: [] },
        ],
      },
    ],
  },
};
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-timeline-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const run = (over: Partial<Run> = {}): Run => ({
  id: "r",
  agentId: "dev",
  repoId: "repo",
  seq: 1,
  startedAt: FROM - 1000,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP },
  ...over,
});
const seat = (state: SeatSessionRow["state"] = "running") =>
  store.setSeatSession({
    seatId: "dev",
    runId: "r",
    cliSessionId: null,
    state,
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });
const view = () => overviewTimeline(config, store, NOW);

it("keeps empty lanes in crew order in an empty window", () => {
  store.addAgentEvent({ agentId: "dev", at: FROM - 20, from: "idle", to: "running", text: "" });
  store.addAgentEvent({ agentId: "dev", at: FROM - 10, from: "running", to: "idle", text: "" });
  expect(view()).toEqual({
    from: FROM,
    to: NOW,
    lanes: ["loop", "dev", "retro"].map((agentId) => ({ agentId, spans: [], ticks: [] })),
  });
});

it("combines turns, CI tries, lock holds and reviews on their own lanes", () => {
  store.upsertRun(run());
  store.addAgentEvent({ agentId: "dev", at: FROM + 10, from: "idle", to: "running", text: "" });
  store.addAgentEvent({ agentId: "dev", at: FROM + 20, from: "running", to: "idle", text: "" });
  store.addLoopEvent("reported", "r", "reported; pushing", FROM + 30);
  store.addLoopEvent("passed", "r", "CI passed on abc", FROM + 40);
  store.addLockHold({
    runId: "r",
    toolUseId: "t",
    seatId: "dev",
    command: "test",
    since: FROM + 50,
  });
  store.deleteLockHold("r", "t", FROM + 60);
  const id = store.requestReview({
    authorRunId: "r",
    repoId: "repo",
    seatId: "retro",
    prNumber: 1,
    sha: "abc",
    epoch: 0,
    attempt: 1,
    round: 1,
    at: FROM + 65,
  }) as number;
  store.setReviewState(id, ["queued"], "starting", { at: FROM + 70 });
  store.setReviewState(id, ["starting"], "running", { at: FROM + 75, runId: "review-run" });
  store.setReviewState(id, ["running"], "failed", { at: FROM + 80, failure: "stopped" });
  expect(view().lanes[1]?.spans).toEqual([
    { kind: "turn", from: FROM + 10, to: FROM + 20 },
    { kind: "checks", from: FROM + 30, to: FROM + 40 },
    { kind: "lock", from: FROM + 50, to: FROM + 60 },
  ]);
  expect(view().lanes[2]?.spans).toEqual([{ kind: "review", from: FROM + 70, to: FROM + 80 }]);
});

it("clips both edges and preserves an open span, including a turn begun before the window", () => {
  seat();
  store.upsertRun(run());
  store.addAgentEvent({ agentId: "dev", at: FROM - 100, from: "idle", to: "running", text: "" });
  store.addLockHold({
    runId: "r",
    toolUseId: "t",
    seatId: "dev",
    command: "test",
    since: FROM - 100,
  });
  store.deleteLockHold("r", "t", NOW + 100);
  store.addLoopEvent("reported", "r", "reported; pushing", FROM - 50);
  store.addLoopEvent("passed", "r", "CI passed on abc", NOW + 50);
  expect(view().lanes[1]?.spans).toEqual([
    { kind: "turn", from: FROM, to: null },
    { kind: "lock", from: FROM, to: NOW },
    { kind: "checks", from: FROM, to: NOW },
  ]);
});

it("takes the newest 300 in-window ticks across all runs, including ended runs", () => {
  for (let i = 0; i < 2; i++) {
    const r = run({ id: `r${i}`, endedAt: i === 0 ? NOW - 1 : null });
    store.upsertRun(r);
    store.setDigest(r.id, {
      ...foldTranscript(null, [], NOW).digest,
      toolStarts: [FROM - 1, NOW + 1, ...Array.from({ length: 200 }, (_, n) => FROM + i * 200 + n)],
    });
  }
  const ticks = view().lanes[1]?.ticks;
  expect(ticks).toHaveLength(TIMELINE_TICKS_MAX);
  expect(ticks).toEqual(Array.from({ length: 300 }, (_, n) => FROM + 100 + n));
});

it("does not infer an observed loop turn from a stalled-to-running event", () => {
  store.addAgentEvent({ agentId: "loop", at: FROM + 10, from: "stalled", to: "running", text: "" });
  expect(view().lanes[0]?.spans).toEqual([]);
});

it("takes observed loop turns from runs, including ended and open runs", () => {
  store.upsertRun(
    run({ id: "ended", agentId: "loop", loop: null, startedAt: FROM - 10, endedAt: FROM + 20 }),
  );
  store.upsertRun(run({ id: "open", agentId: "loop", loop: null, startedAt: FROM + 30 }));
  expect(view().lanes[0]?.spans).toEqual([
    { kind: "turn", from: FROM, to: FROM + 20 },
    { kind: "turn", from: FROM + 30, to: null },
  ]);
});

it("replaces a lost turn end when a newer turn starts", () => {
  store.addAgentEvent({ agentId: "dev", at: FROM + 10, from: "idle", to: "running", text: "" });
  store.addAgentEvent({ agentId: "dev", at: FROM + 30, from: "idle", to: "running", text: "" });
  store.addAgentEvent({ agentId: "dev", at: FROM + 40, from: "running", to: "idle", text: "" });
  expect(view().lanes[1]?.spans).toEqual([{ kind: "turn", from: FROM + 30, to: FROM + 40 }]);
});

it.each(["idle", "stopped", "error", "parked", "starting", null] as const)(
  "drops a turn with a lost end when the current seat state is %s",
  (state) => {
    if (state !== null) seat(state);
    store.addAgentEvent({ agentId: "dev", at: FROM + 10, from: "idle", to: "running", text: "" });
    expect(view().lanes[1]?.spans).toEqual([]);
  },
);

it.each(["idle", "stopped", "error", "parked"] as const)(
  "ends turns on %s after stalled and waiting states",
  (end) => {
    store.addAgentEvent({ agentId: "dev", at: FROM + 10, from: "idle", to: "running", text: "" });
    store.addAgentEvent({
      agentId: "dev",
      at: FROM + 20,
      from: "running",
      to: "stalled",
      text: "",
    });
    store.addAgentEvent({
      agentId: "dev",
      at: FROM + 30,
      from: "stalled",
      to: "waiting",
      text: "",
    });
    store.addAgentEvent({ agentId: "dev", at: FROM + 40, from: "waiting", to: end, text: "" });
    expect(view().lanes[1]?.spans).toEqual([{ kind: "turn", from: FROM + 10, to: FROM + 40 }]);
  },
);

it("omits parked CI tries", () => {
  store.upsertRun(run());
  store.addLoopEvent("reported", "r", "reported; pushing", FROM + 10);
  store.addLoopEvent("parked", "r", parkedEventText("needs help"), FROM + 20);
  expect(view().lanes[1]?.spans).toEqual([]);
});

it("drops spans ending exactly at the left edge", () => {
  store.upsertRun(run({ agentId: "loop", loop: null, endedAt: FROM }));
  store.addAgentEvent({ agentId: "dev", at: FROM - 10, from: "idle", to: "running", text: "" });
  store.addAgentEvent({ agentId: "dev", at: FROM, from: "running", to: "idle", text: "" });
  expect(view().lanes.every((lane) => lane.spans.length === 0)).toBe(true);
});

it("handles stored digests without toolStarts", () => {
  store.upsertRun(run());
  const { toolStarts: _, ...legacy } = foldTranscript(null, [], NOW).digest;
  store.setDigest("r", legacy);
  expect(store.digest("r")).not.toHaveProperty("toolStarts");
  expect(view().lanes[1]?.ticks).toEqual([]);
});
