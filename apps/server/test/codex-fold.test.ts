import { describe, expect, it } from "vitest";
import { foldTranscript } from "../src/streamjson.ts";

const at = Date.parse("2026-10-24T12:00:00Z");
const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number, time = at) =>
  JSON.stringify({
    method: "thread/tokenUsage/updated",
    timestamp: new Date(time).toISOString(),
    params: {
      threadId: "thread",
      tokenUsage: {
        total: {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        last: { totalTokens: 100 },
        modelContextWindow: 10000,
      },
    },
  });

describe("Codex transcript folding", () => {
  it("folds cumulative usage once, keeps cost unknown and buckets deltas across resumes", () => {
    const lines = [usage(100, 20, 10), usage(100, 20, 10), usage(160, 30, 30, at + 60000)];
    const all = foldTranscript(null, lines, at + 60000);
    const first = foldTranscript(null, lines.slice(0, 1), at);
    const incremental = foldTranscript(first, lines.slice(1), at + 60000);
    expect(all.tokens).toEqual({ input: 130, cacheRead: 30, output: 30, cacheCreate: 0 });
    expect(all.costUsd).toBeNull();
    expect(all.digest).toMatchObject({ contextTokens: 100, contextWindow: 10000 });
    expect(all.digest.minuteTokens).toEqual([
      [at, 90],
      [at + 60000, 70],
    ]);
    expect(incremental).toEqual(all);
    expect(first.tokens).toEqual({ input: 80, cacheRead: 20, output: 10, cacheCreate: 0 });
    expect(first.digest.contextWindow).toBe(10000);
    expect(foldTranscript(incremental, [], at + 60000).digest.contextWindow).toBe(10000);
    expect(foldTranscript(all, [usage(10, 0, 1)], at + 60000).tokens).toEqual(all.tokens);
  });

  it("keeps the reported context window when later updates omit it", () => {
    const first = foldTranscript(null, [usage(100, 20, 10)], at);
    const update = JSON.parse(usage(160, 30, 30, at + 60000));
    delete update.params.tokenUsage.modelContextWindow;
    const next = foldTranscript(first, [JSON.stringify(update)], at + 60000);
    expect(next.digest.contextWindow).toBe(10000);
    expect(first.digest.contextWindow).toBe(10000);
    update.params.tokenUsage.modelContextWindow = 20000;
    expect(foldTranscript(next, [JSON.stringify(update)], at + 60000).digest.contextWindow).toBe(
      20000,
    );
    expect(next.digest.contextWindow).toBe(10000);
  });

  it("keeps the latest plan text and rejects malformed plans and usage", () => {
    const plan = (step: string) =>
      JSON.stringify({
        method: "turn/plan/updated",
        params: { explanation: "Working", plan: [{ step, status: "in_progress" }] },
      });
    const facts = foldTranscript(
      null,
      [
        plan("First"),
        plan("Second"),
        usage(10, 20, 1),
        JSON.stringify({ method: "turn/plan/updated", params: { plan: [null] } }),
      ],
      at,
    );
    expect(facts.latestPlan).toBe("Working\n[in_progress] Second");
    expect(facts.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    expect(facts.costUsd).toBeNull();
  });
});
