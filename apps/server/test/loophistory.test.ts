import {
  type LoopEvent,
  mergedMainText,
  NEW_LOOP,
  parkedEventText,
  REVIEW_STATUS_RUNNING,
  type Run,
  type RunLoop,
  reviewEventKey,
  reviewedEventText,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import { loopTries } from "../src/loophistory.ts";

const RUN = "r1";
const T0 = 1_000_000;

const run = (over: Partial<Run> = {}, loop: Partial<RunLoop> | null = {}): Run => ({
  id: RUN,
  agentId: "guido-1",
  repoId: "repo",
  seq: 1,
  startedAt: T0,
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
  loop: loop === null ? null : { ...NEW_LOOP, ...loop },
  ...over,
});

/** Events at one minute apart from T0, keyed so each is unique unless a key is given. */
const evs = (...rows: (string | [key: string, text: string])[]): LoopEvent[] =>
  rows.map((r, i) => {
    const [key, text] = typeof r === "string" ? [`k${i}`, r] : r;
    return { key, runId: RUN, text, at: T0 + (i + 1) * 60_000 };
  });
const at = (i: number): number => T0 + (i + 1) * 60_000;

const REPORTED = "reported; pushing";
const reviewReported = reviewedEventText("RETRO-1", "abc1234", 2, 0);

describe("loopTries", () => {
  it("is empty without a loop", () => {
    expect(loopTries(run({}, null), evs(REPORTED), null)).toEqual([]);
  });

  it("opens a Working try at the run's start", () => {
    expect(loopTries(run(), [], null)).toEqual([
      {
        step: "working",
        trigger: "run started",
        fix: false,
        n: 1,
        startedAt: T0,
        endedAt: null,
        outcome: "running",
        reason: null,
      },
    ]);
  });

  it("counts a CI failure and the next try", () => {
    const tries = loopTries(run(), evs(REPORTED, "CI failed on abc1234", REPORTED), null);
    expect(tries.map((t) => [t.step, t.n, t.outcome, t.reason])).toEqual([
      ["working", 1, "pass", null],
      ["ci", 1, "fail", "CI failed on abc1234"],
      ["working", 2, "pass", null],
      ["ci", 2, "running", null],
    ]);
    expect(tries[1]).toMatchObject({ startedAt: at(0), endedAt: at(1) });
  });

  it("walks a second review round", () => {
    const events = evs(
      REPORTED,
      "CI passed on abc1234",
      [reviewEventKey(RUN, 7, "reported"), reviewReported],
      [reviewEventKey(RUN, 7, "fix"), "sent 2 findings to GUIDO-1"],
      REPORTED,
      "CI passed on def5678",
    );
    const shape = (status: Parameters<typeof loopTries>[2]) =>
      loopTries(run(), events, status).map((t) => [t.step, t.fix, t.n, t.outcome, t.reason]);
    const expected = (last: string) => [
      ["working", false, 1, "pass", null],
      ["ci", false, 1, "pass", null],
      ["review", false, 1, "fail", reviewReported],
      ["review", true, 1, "pass", null],
      ["ci", false, 2, "pass", null],
      ["review", false, 2, last, null],
    ];
    expect(shape(null)).toEqual(expected("waiting"));
    expect(shape({ state: "pending", description: REVIEW_STATUS_RUNNING })).toEqual(
      expected("running"),
    );
  });

  it("closes a parked try at resume and takes the next step from a later event", () => {
    const parked = parkedEventText("CI failed 3 times; last on abc1234");
    const events = evs(
      REPORTED,
      "CI failed on abc1234",
      REPORTED,
      parked,
      [`${RUN}:resumed:1`, "resumed by operator"],
      "CI passed on abc1234",
    );
    const tries = loopTries(run({}, { phase: "review" }), events, null);
    expect(tries.map((t) => [t.step, t.outcome, t.reason])).toEqual([
      ["working", "pass", null],
      ["ci", "fail", "CI failed on abc1234"],
      ["working", "pass", null],
      ["ci", "parked", "CI failed 3 times; last on abc1234"],
      ["ci", "pass", null],
      ["review", "waiting", null],
    ]);
    expect(tries[3]).toMatchObject({ startedAt: at(2), endedAt: at(4) });
  });

  it("records a re-run as another execution without charging another failure", () => {
    const rerun: [string, string] = [`${RUN}:rerun:abc`, "CI failed on abc1234; re-ran build"];
    const passed = loopTries(run(), evs(REPORTED, rerun, "CI passed on abc1234"), null);
    expect(passed.map((t) => [t.step, t.outcome])).toEqual([
      ["working", "pass"],
      ["ci", "fail"],
      ["ci", "pass"],
      ["review", "waiting"],
    ]);
    expect(passed.filter((t) => t.step === "ci").map((t) => t.failures)).toEqual([0, 0]);
    const failed = loopTries(run(), evs(REPORTED, rerun, "CI failed on abc1234"), null);
    expect(failed.map((t) => [t.step, t.n, t.outcome])).toEqual([
      ["working", 1, "pass"],
      ["ci", 1, "fail"],
      ["ci", 2, "fail"],
      ["working", 2, "running"],
    ]);
    expect(failed.filter((t) => t.step === "ci").map((t) => t.failures)).toEqual([0, 1]);
  });

  it("puts a resumed try on In review when a review fix follows", () => {
    const events = evs(
      REPORTED,
      "CI failed on abc1234",
      REPORTED,
      parkedEventText("x"),
      [`${RUN}:resumed:1`, "resumed by operator"],
      [reviewEventKey(RUN, 7, "fix"), "sent"],
    );
    const tries = loopTries(run({}, { phase: "parked" }), events, null);
    expect(tries[3]).toMatchObject({ step: "ci", n: 2, outcome: "parked" });
    expect(tries[4]).toMatchObject({ step: "review", fix: false, outcome: "fail" });
    expect(tries[5]).toMatchObject({ step: "review", fix: true });
  });

  it("puts a resumed try on Working when a report follows", () => {
    const events = evs(
      REPORTED,
      "CI passed on abc1234",
      parkedEventText("x"),
      [`${RUN}:resumed:1`, "resumed by operator"],
      REPORTED,
    );
    const tries = loopTries(run({}, { phase: "parked" }), events, null);
    expect(tries[2]).toMatchObject({ step: "review", outcome: "parked" });
    expect(tries[3]).toMatchObject({ step: "working", outcome: "pass" });
    expect(tries[4]).toMatchObject({ step: "ci", outcome: "running" });
  });

  it("puts a resumed try with no later event on the loop's phase, else the parked step", () => {
    const events = evs(REPORTED, parkedEventText("x"), [`${RUN}:resumed:1`, "resumed by operator"]);
    expect(loopTries(run({}, { phase: "review" }), events, null).at(-1)).toMatchObject({
      step: "review",
    });
    expect(loopTries(run({}, { phase: "parked" }), events, null).at(-1)).toMatchObject({
      step: "ci",
    });
  });

  it("opens a Working try after a conflicted update and a CI try after a clean one", () => {
    const events = evs(
      REPORTED,
      "CI passed on abc1234",
      [`${RUN}:update:aaa`, mergedMainText("aaa1111")],
      [`${RUN}:update-conflict:bbb`, "merging main bbb2222 conflicted in 1 file"],
    );
    expect(loopTries(run(), events, null).map((t) => [t.step, t.outcome, t.reason])).toEqual([
      ["working", "pass", null],
      ["ci", "pass", null],
      ["review", "pass", null],
      ["ci", "fail", "merging main bbb2222 conflicted in 1 file"],
      ["working", "running", null],
    ]);
  });

  it("stops an open try when the run ends, and passes Done after a merge", () => {
    const ended = run(
      { endedAt: at(5) },
      { phase: "parked", parked: { kind: "ended", reason: "run ended (stopped)", ended: true } },
    );
    expect(loopTries(ended, [], null)).toEqual([
      {
        step: "working",
        trigger: "run started",
        fix: false,
        n: 1,
        startedAt: T0,
        endedAt: at(5),
        outcome: "stopped",
        reason: "run ended (stopped)",
      },
    ]);
    const merged = loopTries(
      run({ endedAt: at(9) }, { phase: "done" }),
      evs(REPORTED, "CI passed on abc1234", "merged"),
      null,
    );
    expect(merged.at(-1)).toMatchObject({ step: "done", outcome: "pass", endedAt: at(9) });
  });

  it("keeps a parked try parked when the run ends", () => {
    const tries = loopTries(
      run({ endedAt: at(3) }, { phase: "parked" }),
      evs(REPORTED, parkedEventText("stuck")),
      null,
    );
    expect(tries.at(-1)).toMatchObject({ outcome: "parked", reason: "stuck", endedAt: at(3) });
  });
});

it("attributes measured zero and usage at retry boundaries, without run totals", () => {
  const events = evs(REPORTED, "CI failed on abc1234");
  const usage = [
    { id: "zero", at: T0, tokens: 0 },
    { id: "next", at: at(1), tokens: 12 },
  ];
  expect(loopTries(run(), events, null, usage).map((t) => t.tokens)).toEqual([0, null, 12]);
  expect(loopTries(run(), events, null, []).map((t) => t.tokens)).toEqual([null, null, null]);
});

it("names verification triggers and separates runs from failures", () => {
  const tries = loopTries(
    run(),
    evs(
      REPORTED,
      "CI passed on abc",
      [reviewEventKey(RUN, 1, "fix"), "findings"],
      REPORTED,
      "CI passed on def",
      [`${RUN}:update:abc`, "merged main"],
      [`${RUN}:rerun:abc`, "CI re-run"],
    ),
    null,
  );
  expect(tries.every((t) => typeof t.trigger === "string")).toBe(true);
  expect(tries.filter((t) => t.step === "ci").map((t) => t.trigger)).toEqual([
    "first push",
    "review fix round 1",
    "main merged",
    "re-run",
  ]);
  expect(tries.filter((t) => t.step === "ci").map((t) => t.failures)).toEqual([0, 0, 0, 0]);
});

it("carries recorded cache usage per attempt", () => {
  const tries = loopTries(run(), evs(REPORTED), null, [
    {
      id: "m",
      at: T0 + 1,
      tokens: 5,
      usage: { input: 2, output: 3, cacheRead: 100, cacheCreate: 20 },
      model: "model-a",
    },
  ]);
  expect(tries[0]?.usage).toEqual({ input: 2, output: 3, cacheRead: 100, cacheCreate: 20 });
});

it("shows the final charged CI failure when the engine parks at the limit", () => {
  const tries = loopTries(
    run(
      {},
      {
        phase: "parked",
        ciFails: 3,
        parked: { kind: "ci", reason: "CI failed 3 times; last on abc", ended: false },
      },
    ),
    evs(REPORTED, parkedEventText("CI failed 3 times; last on abc")),
    null,
  );
  expect(tries.at(-1)).toMatchObject({ step: "ci", failures: 3, outcome: "parked" });
});
