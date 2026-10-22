import { describe, expect, it } from "vitest";
import type { AgentView, Run } from "../src/index.ts";

describe("core types", () => {
  it("accepts literal Run and AgentView objects", () => {
    const run = {
      id: "r1",
      agentId: "a1",
      repoId: "repo",
      seq: 1,
      startedAt: 1_700_000_000_000,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
      transcriptPath: "/tmp/t.jsonl",
      prs: [{ repo: "owner/repo", number: 7 }],
      summary: "Merged PR #7.",
    } satisfies Run;

    const view = {
      id: "a1",
      repoId: "repo",
      kind: "loop",
      role: null,
      mode: null,
      area: [],
      model: null,
      sessionId: null,
      loopKind: "ta-loop",
      accountId: "acc",
      state: "working",
      stateSince: run.startedAt,
      currentRun: run,
      paused: false,
      sourceError: null,
      note: null,
      stop: null,
      lastOutputAt: null,
    } satisfies AgentView;

    expect(view.currentRun?.id).toBe("r1");
  });
});
