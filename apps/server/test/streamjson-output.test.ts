import { describe, expect, it } from "vitest";
import { foldTranscript } from "../src/streamjson.ts";

const assistant = (id: string, output: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-06T10:00:00Z",
    message: {
      id,
      model: "claude-x",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100 },
    },
  });
const result = (output: number, cost: number) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: cost,
    usage: { input_tokens: 5, output_tokens: output },
  });

const LINES = [
  assistant("m1", 10),
  assistant("m2", 20),
  result(500, 1),
  assistant("m3", 7),
  result(700, 2),
];

describe("a run's output tokens", () => {
  it("are the sum of its result events, not the streamed figure", () => {
    const facts = foldTranscript(null, LINES, 0);
    expect(facts.tokens.output).toBe(1200);
    expect(facts.costUsd).toBe(2);
  });

  it("are the same when the transcript is folded in two chunks", () => {
    const first = foldTranscript(null, LINES.slice(0, 3), 0);
    expect(first.tokens.output).toBe(500);
    expect(foldTranscript(first, LINES.slice(3), 0).tokens.output).toBe(1200);
  });

  it("stay the streamed figure while no result has come", () => {
    expect(foldTranscript(null, LINES.slice(0, 2), 0).tokens.output).toBe(30);
  });
});
