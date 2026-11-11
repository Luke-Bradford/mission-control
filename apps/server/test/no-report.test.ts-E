import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoopKind, NEW_LOOP, noReportNoteKey, noReportReason, type Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { recordNoReport } from "../src/runtime/no-report.ts";
import { runView } from "../src/runview.ts";
import { Store } from "../src/store.ts";
import { foldTranscript } from "../src/streamjson.ts";

let dir: string;
let store: Store;
const run: Run = {
  id: "r1",
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: 1,
  endedAt: 2,
  status: "failed",
  sessionId: null,
  model: null,
  branch: null,
  ticket: "mc#42",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
};
const exit = { code: 0, signal: null, lastStderr: null };
const facts = foldTranscript(
  null,
  [
    JSON.stringify({
      type: "assistant",
      message: {
        id: "m1",
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "I ran out of room. The review is unfinished." }],
        usage: {
          input_tokens: 12,
          output_tokens: 34,
          cache_read_input_tokens: 56,
          cache_creation_input_tokens: 78,
        },
      },
    }),
    JSON.stringify({
      type: "result",
      is_error: true,
      subtype: "error_max_turns",
      num_turns: 1,
      stop_reason: "max_tokens",
    }),
  ],
  2,
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-no-report-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.upsertRun(run);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function reviewRun(): Run {
  const reviewId = store.requestReview({
    authorRunId: "author",
    repoId: "mc",
    seatId: "retro",
    prNumber: 7,
    sha: "sha",
    epoch: 1,
    attempt: 1,
    round: 1,
    at: 1,
  }) as number;
  store.setReviewState(reviewId, ["queued"], "running", { runId: run.id, at: 1 });
  return { ...run, reviewId };
}

describe("missing reports", () => {
  it("counts completed turns across the run, including an unfinished final turn", () => {
    const next = foldTranscript(
      facts,
      [
        JSON.stringify({ type: "result", num_turns: 12 }),
        JSON.stringify({ type: "user", message: { content: [] } }),
      ],
      3,
    );
    recordNoReport(store, run, "build", exit, next, 3);
    expect(store.run(run.id)?.noReport).toMatchObject({
      turns: 2,
      lastAssistantText: "I ran out of room. The review is unfinished.",
    });
  });

  it("records a crash in a rework round despite evidence from an earlier round", () => {
    const id = store.addEvidence(run.id, "first pass", 1);
    store.setRunLoop(run.id, { ...NEW_LOOP, phase: "working", reportedEvidenceId: id });
    expect(recordNoReport(store, run, "build", { ...exit, code: 1 }, facts, 2)).toBe(true);
    expect(store.run(run.id)?.noReport?.code).toBe(1);
  });

  it.each(["build", "review", "plan", "done"] as const)(
    "clears only the same ticket's notes on %s, retaining historical diagnostics",
    (report) => {
      recordNoReport(store, run, "build", exit, facts, 2);
      for (const [id, repoId, ticket, startedAt] of [
        ["other-ticket", "mc", "mc#43", 1],
        ["other-repo", "elsewhere", run.ticket, 1],
        ["newer", "mc", run.ticket, 10],
      ] as const) {
        const other = { ...run, id, repoId, ticket, startedAt };
        store.upsertRun(other);
        recordNoReport(store, other, "build", exit, facts, 2);
      }
      const next = { ...run, id: "later", startedAt: 3 };
      store.upsertRun(next);
      // Ordinary loop events do not resolve a missing report.
      store.addLoopEvent("later:progress", next.id, "progress", 3);
      expect(store.notes()).toHaveLength(4);
      if (report === "build") store.addEvidence(next.id, "done", 4);
      if (report === "plan") store.addLoopEvent("later:plan", next.id, "plan", 4);
      if (report === "review") {
        const reviewId = store.requestReview({
          authorRunId: "author",
          repoId: "mc",
          seatId: "retro",
          prNumber: 7,
          sha: "sha",
          epoch: 1,
          attempt: 1,
          round: 1,
          at: 3,
        }) as number;
        const findings = {
          verdict: { spec: "pass", quality: "pass" } as const,
          summary: "clean",
          findings: [],
          at: 4,
        };
        expect(store.recordFindings(reviewId, next.id, findings)).toBe(false);
        expect(store.notes()).toHaveLength(4);
        store.setReviewState(reviewId, ["queued"], "running", { runId: next.id, at: 3 });
        expect(store.recordFindings(reviewId, next.id, findings)).toBe(true);
      }
      if (report === "done") store.setRunLoop(next.id, { ...NEW_LOOP, phase: "done" }, 4);
      expect(
        store
          .notes()
          .map((n) => n.key)
          .sort(),
      ).toEqual(
        (report === "done"
          ? ["other-repo", "other-ticket"]
          : ["newer", "other-repo", "other-ticket"]
        ).map(noReportNoteKey),
      );
      expect(store.run(run.id)?.noReport).toBeDefined();
    },
  );

  it("leads with terminal reason, drops diagnostic entries and avoids duplicate stream error", () => {
    recordNoReport(store, run, "build", exit, facts, 2);
    const record = store.run(run.id)?.noReport;
    expect(record).toBeDefined();
    if (!record) return;
    const reason = noReportReason({
      ...record,
      terminalReason: "aborted_tools",
      error: "[ede_diagnostic] internal; useful failure",
      apiErrorStatus: 429,
    });
    expect(reason).toMatch(/^aborted_tools; exit code 0/);
    expect(reason).toContain("useful failure");
    expect(reason).toContain("API status 429");
    expect(reason).not.toContain("ede_diagnostic");
    expect(reason).not.toContain("stream error");
    expect(noReportReason({ ...record, resultSubtype: null })).toContain("stream error");
  });

  it.each(["build", "review", "plan"] as const)(
    "records the exit facts for an unreported %s run",
    (loop) => {
      const r = loop === "review" ? reviewRun() : run;
      expect(recordNoReport(store, r, loop, exit, facts, 2)).toBe(true);
      const record = store.run(run.id)?.noReport;
      expect(record).toEqual({
        ...exit,
        stopReason: "max_tokens",
        resultSubtype: "error_max_turns",
        isError: true,
        error: null,
        terminalReason: null,
        apiErrorStatus: null,
        turns: 1,
        tokens: { input: 12, output: 34, cacheRead: 56, cacheCreate: 78 },
        lastAssistantText: "I ran out of room. The review is unfinished.",
      });
      expect(store.notes()).toEqual([
        expect.objectContaining({
          key: noReportNoteKey(run.id),
          runId: run.id,
          text: expect.stringContaining("stop reason max_tokens"),
        }),
      ]);
      // The next fold must not erase controller-owned exit diagnostics.
      store.upsertRun({ ...r, summary: "backfilled" });
      store.close();
      store = new Store(join(dir, "mc.sqlite"));
      const stored = store.run(run.id) as Run;
      expect(stored.noReport).toEqual(record);
      const config = { repos: [] } as unknown as CcConfig;
      const listed = runView(config, store, stored, new Map()).noReport;
      expect(listed).not.toHaveProperty("lastAssistantText");
      expect(listed).toMatchObject({ code: 0, turns: 1 });
      expect(stored.noReport?.lastAssistantText).toBe(record?.lastAssistantText);
    },
  );

  it.each(["build", "review", "plan"] as const)(
    "records nothing extra after a %s report",
    (loop) => {
      let r = run;
      if (loop === "build") store.addEvidence(run.id, "done", 1);
      else if (loop === "review") {
        r = reviewRun();
        expect(
          store.recordFindings(r.reviewId as number, r.id, {
            verdict: { spec: "pass", quality: "pass" },
            summary: "clean",
            findings: [],
            at: 1,
          }),
        ).toBe(true);
        store.setReviewState(r.reviewId as number, ["reported"], "superseded", { at: 2 });
      } else store.addLoopEvent(`${run.id}:plan`, run.id, "plan", 1);
      expect(recordNoReport(store, r, loop, exit, facts, 2)).toBe(false);
      expect(store.run(run.id)?.noReport).toBeUndefined();
      expect(store.notes()).toEqual([]);
    },
  );

  it("records a clean end turn without a report as well as a crash", () => {
    const stopped = foldTranscript(
      null,
      [
        JSON.stringify({
          type: "result",
          is_error: false,
          subtype: "success",
          stop_reason: "end_turn",
        }),
      ],
      2,
    );
    recordNoReport(store, run, "build", exit, stopped, 2);
    expect(store.run(run.id)?.noReport).toMatchObject({
      code: 0,
      signal: null,
      stopReason: "end_turn",
      isError: false,
    });
    expect(store.notes()[0]?.text).toContain("exit code 0; stop reason end_turn; success");
  });

  it("does not mistake a different run's plan on the same ticket for this run's report", () => {
    store.upsertRun({ ...run, id: "older" });
    store.addLoopEvent("older:plan", "older", "plan", 1);
    expect(recordNoReport(store, run, "plan", exit, facts, 2)).toBe(true);
  });

  it.each(["none", "watch"] satisfies LoopKind[])(
    "does not require a report from a %s loop",
    (loop) => {
      expect(recordNoReport(store, run, loop, exit, facts, 2)).toBe(false);
      expect(store.notes()).toEqual([]);
    },
  );

  it("keeps an unknown stream distinct from zero usage when the CLI dies before output", () => {
    recordNoReport(
      store,
      run,
      "build",
      { code: null, signal: "SIGKILL", lastStderr: "out of memory" },
      null,
      2,
    );
    expect(store.run(run.id)?.noReport).toMatchObject({
      code: null,
      signal: "SIGKILL",
      stopReason: null,
      turns: null,
      tokens: null,
      lastAssistantText: null,
    });
    expect(store.notes()[0]?.text).toContain("signal SIGKILL");
    expect(store.notes()[0]?.text).toContain("out of memory");
  });
});
