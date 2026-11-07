import { describe, expect, it } from "vitest";
import { judgeCliCheck } from "../src/runtime/cli-check.ts";

const N = "abc123";
const lines = (...l: unknown[]) => l.map((x) => JSON.stringify(x)).join("\n");
const claudeTool = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] },
});
const claudeResult = (over: Record<string, unknown> = {}) => ({
  type: "result",
  is_error: false,
  result: N,
  ...over,
});

describe("judgeCliCheck", () => {
  it("passes a Claude turn whose tool result and answer carry the nonce", () => {
    expect(judgeCliCheck(lines(claudeTool(N), claudeResult()), N).ok).toBe(true);
  });
  it("fails when no tool result carried the nonce (an answer alone proves nothing)", () => {
    const r = judgeCliCheck(lines(claudeTool("nothing"), claudeResult()), N);
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/no tool call/);
  });
  it("fails an error result, an unfinished turn and a wrong answer", () => {
    expect(judgeCliCheck(lines(claudeTool(N), claudeResult({ is_error: true })), N).ok).toBe(false);
    expect(judgeCliCheck(lines(claudeTool(N)), N).detail).toMatch(/did not finish/);
    expect(judgeCliCheck(lines(claudeTool(N), claudeResult({ result: "no" })), N).detail).toMatch(
      /did not carry/,
    );
  });
  it("passes a Codex turn and fails a failed one", () => {
    const done = (status: string) => ({
      method: "turn/completed",
      params: { turn: { id: "1", status } },
    });
    const items = [
      {
        method: "item/completed",
        params: { item: { type: "commandExecution", aggregatedOutput: `${N}\n` } },
      },
      { method: "item/completed", params: { item: { type: "agentMessage", text: N } } },
    ];
    expect(judgeCliCheck(lines(...items, done("completed")), N).ok).toBe(true);
    expect(judgeCliCheck(lines(...items, done("failed")), N).ok).toBe(false);
  });
});
