import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAST_TEXT_MAX, LIVE_DETAIL_MAX } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { foldTranscript } from "../src/streamjson.ts";

const lines = readFileSync(resolve(import.meta.dirname, "fixtures/iteration.sample.log"), "utf8")
  .split("\n")
  .filter((l) => l.length > 0);

describe("foldTranscript", () => {
  it("folds the fixture into run facts", () => {
    const f = foldTranscript(null, lines, 123_000);
    expect(f.sessionId).toBe("11111111-2222-4333-8444-555555555555");
    expect(f.model).toBe("claude-opus-5-5");
    expect(f.permissionMode).toBe("acceptEdits");
    expect(f.branch).toBe("fix/3757-fence-reacquire");
    expect(f.costUsd).toBe(2.4711);
    expect(f.resultCount).toBe(1);
    expect(f.isError).toBe(false);
    // msg_fixture_1 seen twice (last wins: out 120) + msg_fixture_2 once
    expect(f.tokens).toEqual({
      input: 4,
      output: 162,
      cacheRead: 12628 + 70733,
      cacheCreate: 58105 + 3447,
    });
    expect(f.rateLimits).toEqual([
      { window: "5h", utilization: 7, resetsAt: 1792227600_000, at: 123_000 },
      { window: "7d", utilization: 41, resetsAt: 1792548000_000, at: 123_000 },
    ]);
  });

  it("folding in two chunks equals folding in one, including the split duplicate id", () => {
    const whole = foldTranscript(null, lines, 5);
    // split between the two assistant lines that share a message id
    const a = foldTranscript(null, lines.slice(0, 4), 5);
    const b = foldTranscript(a, lines.slice(4), 5);
    expect(b).toEqual(whole);
  });

  it("folding on never changes the earlier facts", () => {
    const a = foldTranscript(null, lines.slice(0, 4), 5);
    const before = structuredClone(a);
    // lines[1] is the rate_limit_event: folding on must push into a copy, not a's list
    foldTranscript(a, [...lines.slice(4), lines[1] as string], 5);
    expect(a).toEqual(before);
  });

  it("skips non-JSON and truncated lines without throwing", () => {
    const f = foldTranscript(
      null,
      ["=== studio-build-loop fire START ===", '{"type":"assistant","mess', ...lines],
      1,
    );
    expect(f.model).toBe("claude-opus-5-5");
    expect(f.tokens.output).toBe(162);
  });

  it("uses the last result cost and last branch; flags errors", () => {
    const f = foldTranscript(
      null,
      [
        JSON.stringify({ type: "system", subtype: "vcs_state_changed", kind: "push", branch: "a" }),
        JSON.stringify({ type: "system", subtype: "vcs_state_changed", kind: "push", branch: "b" }),
        JSON.stringify({ type: "system", subtype: "vcs_state_changed", kind: "push" }),
        JSON.stringify({ type: "result", total_cost_usd: 1, is_error: false }),
        JSON.stringify({ type: "result", total_cost_usd: 3, is_error: true }),
      ],
      1,
    );
    expect(f.branch).toBe("b");
    expect(f.costUsd).toBe(3);
    expect(f.resultCount).toBe(2);
    expect(f.isError).toBe(true);
  });

  const published = (branch?: string) =>
    JSON.stringify({
      type: "system",
      subtype: "code_change_published",
      provider: "github",
      url: "https://github.com/o/r/pull/1",
      action: "created",
      ...(branch ? { branch } : {}),
    });

  it("takes the branch from the last code_change_published when there is no vcs_state_changed", () => {
    const f = foldTranscript(
      null,
      [published("feat/studio-1600-a"), published(), published("feat/studio-1600-b")],
      1,
    );
    expect(f.branch).toBe("feat/studio-1600-b");
  });

  it("prefers vcs_state_changed over code_change_published, across chunks", () => {
    const vcs = JSON.stringify({
      type: "system",
      subtype: "vcs_state_changed",
      kind: "push",
      branch: "fix/1-vcs",
    });
    const whole = foldTranscript(null, [vcs, published("feat/studio-2-pub")], 1);
    expect(whole.branch).toBe("fix/1-vcs");
    const a = foldTranscript(null, [published("feat/studio-2-pub")], 1);
    expect(a.branch).toBe("feat/studio-2-pub");
    const b = foldTranscript(a, [vcs], 1);
    expect(b.branch).toBe("fix/1-vcs");
    const c = foldTranscript(b, [published("feat/studio-3-later")], 1);
    expect(c.branch).toBe("fix/1-vcs");
  });

  it("cleans branch names from vcs_state_changed and code_change_published", () => {
    const dirty = (subtype: string, branch: string) =>
      JSON.stringify({ type: "system", subtype, kind: "push", branch });
    expect(
      foldTranscript(null, [dirty("vcs_state_changed", "\u001b[31mfix/1-a\u001b[0m")], 1).branch,
    ).toBe("fix/1-a");
    expect(
      foldTranscript(
        null,
        [dirty("code_change_published", "feat/ghp_abcdefghijklmnopqrstuvwxyz0123")],
        1,
      ).branch,
    ).toBe("feat/[redacted]");
    // A branch made only of control characters is no branch.
    expect(foldTranscript(null, [dirty("vcs_state_changed", "\u0007\u0008")], 1).branch).toBeNull();
  });

  it("returns empty facts for no lines", () => {
    const f = foldTranscript(null, [], 1);
    expect(f).toMatchObject({ sessionId: null, costUsd: null, resultCount: 0, rateLimits: [] });
    expect(f.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});

const agentLines = readFileSync(resolve(import.meta.dirname, "fixtures/stream/agent.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const T = (iso: string) => Date.parse(iso);
const MIN = 60_000;

describe("foldTranscript digest", () => {
  const d = foldTranscript(null, agentLines, 1).digest;

  it("folding in three chunks equals folding at once", () => {
    // Split inside msg_a1's repeated blocks and between a tool_use and its result.
    const a = foldTranscript(null, agentLines.slice(0, 7), 1);
    const b = foldTranscript(a, agentLines.slice(7, 13), 1);
    const c = foldTranscript(b, agentLines.slice(13), 1);
    expect(c.digest).toEqual(d);
    // Folding on from `a` again is unaffected by the folds that went before.
    expect(foldTranscript(a, agentLines.slice(7), 1).digest).toEqual(d);
  });

  it("counts a message repeated per content block once in turns, turnUsage and minuteTokens", () => {
    expect(d.turns).toBe(4);
    expect(d.turnUsage).toEqual([
      { input: 10, output: 50, cacheRead: 5000 },
      { input: 5, output: 20, cacheRead: 6000 },
      { input: 3, output: 40, cacheRead: 6200 },
      { input: 2, output: 15, cacheRead: 6500 },
    ]);
    // Every frame's de-duplicated usage, subagents included (msg_s1 at 10:02).
    expect(d.minuteTokens).toEqual([
      [T("2026-10-18T10:00:00Z"), 60],
      [T("2026-10-18T10:01:00Z"), 25],
      [T("2026-10-18T10:02:00Z"), 43 + 130],
      [T("2026-10-18T10:05:00Z"), 17],
    ]);
    for (const [at] of d.minuteTokens) expect(at % MIN).toBe(0);
  });

  it("drops minute buckets that end 60 minutes or more before the newest event", () => {
    const later = JSON.stringify({
      type: "assistant",
      message: { id: "msg_late", content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      parent_tool_use_id: null,
      timestamp: "2026-10-18T11:01:30.000Z",
    });
    const f = foldTranscript(null, [...agentLines, later], 1).digest;
    // The window is (10:01:30, 11:01:30]: 10:00 ends before it, 10:01 overlaps it.
    expect(f.minuteTokens).toEqual([
      [T("2026-10-18T10:01:00Z"), 25],
      [T("2026-10-18T10:02:00Z"), 173],
      [T("2026-10-18T10:05:00Z"), 17],
      [T("2026-10-18T11:01:00Z"), 2],
    ]);
  });

  it("counts top-level tool calls and tracks the live tool", () => {
    expect(d.toolCalls).toBe(4);
    expect(d.liveTool).toEqual({
      name: "Bash",
      since: T("2026-10-18T10:05:01Z"),
      detail: "gh pr view 7",
    });
    // Mid-run: the Agent call is live while its subagent works.
    const mid = foldTranscript(null, agentLines.slice(0, 18), 1).digest;
    expect(mid.liveTool).toEqual({
      name: "Agent",
      since: T("2026-10-18T10:02:00Z"),
      detail: null,
    });
    expect(mid.toolCalls).toBe(3);
  });

  it("records per-tool calls, failures and durations, subagent frames included", () => {
    expect(Object.getPrototypeOf(d.tools)).toBeNull();
    expect({ ...d.tools }).toEqual({
      Bash: { calls: 2, failed: 0, durationsMs: [30_000] },
      Read: { calls: 1, failed: 1, durationsMs: [1000] },
      Agent: { calls: 1, failed: 0, durationsMs: [100_000] },
      Grep: { calls: 1, failed: 0, durationsMs: [1000] },
    });
  });

  it("keeps the last 50 durations per tool and treats __proto__ as a plain tool name", () => {
    const lines: string[] = [];
    for (let i = 0; i < 55; i++) {
      const at = T("2026-10-18T10:00:00Z") + i * MIN;
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { id: `m${i}`, content: [{ type: "tool_use", id: `t${i}`, name: "__proto__" }] },
          parent_tool_use_id: null,
          timestamp: new Date(at).toISOString(),
        }),
        JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x" }] },
          parent_tool_use_id: null,
          timestamp: new Date(at + i).toISOString(),
        }),
      );
    }
    const t = foldTranscript(null, lines, 1).digest.tools;
    expect(Object.keys(t)).toEqual(["__proto__"]);
    const p = Object.getOwnPropertyDescriptor(t, "__proto__")?.value as (typeof t)[string];
    expect(p?.calls).toBe(55);
    expect(p?.durationsMs).toHaveLength(50);
    expect(p?.durationsMs[0]).toBe(5);
    expect(p?.durationsMs[49]).toBe(54);
  });

  it("takes the context from the latest top-level usage and the window from the result", () => {
    expect(d.model).toBe("claude-opus-5-5");
    expect(d.contextTokens).toBe(2 + 6500 + 50);
    expect(d.contextWindow).toBe(1_000_000);
    expect(d.lastEventAt).toBe(T("2026-10-18T10:05:01Z"));
  });

  it("has no context window before any result line (a running run)", () => {
    const resultAt = agentLines.findIndex((l) => l.startsWith('{"type":"result"'));
    const running = foldTranscript(null, agentLines.slice(0, resultAt), 1).digest;
    expect(running.contextWindow).toBeNull();
    // The subagent's frames do not move the (top-level) context.
    expect(running.contextTokens).toBe(3 + 6200 + 100);
  });

  it("tracks local_agent subagents only, ending on the notification's final numbers", () => {
    expect(d.subagents).toEqual([
      {
        taskId: "task_sub1",
        type: "Explore",
        description: "Find the fold",
        status: "completed",
        tokens: 98_111,
        toolUses: 12,
        durationMs: 95_000,
      },
      {
        taskId: "task_sub2",
        type: "general-purpose",
        description: "Check CI",
        status: "stopped",
        tokens: null,
        toolUses: null,
        durationMs: null,
      },
    ]);
    const progressAt = agentLines.findIndex((l) => l.includes('"subtype":"task_progress"'));
    const mid = foldTranscript(null, agentLines.slice(0, progressAt + 2), 1).digest;
    // After task_progress and a null-status task_updated: still running, on progress numbers.
    expect(mid.subagents[0]).toMatchObject({ status: "running", tokens: 10_673, toolUses: 1 });
  });

  it("does not let a task_progress after the notification replace its final numbers", () => {
    const progressLine = agentLines.find((l) => l.includes('"subtype":"task_progress"')) ?? "";
    const f = foldTranscript(null, [...agentLines, progressLine], 1).digest;
    expect(f.subagents[0]).toMatchObject({ tokens: 98_111, toolUses: 12, durationMs: 95_000 });
  });

  it("cleans subagent descriptions", () => {
    const start = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "t9",
      task_type: "local_agent",
      subagent_type: "Explore",
      description: "\u001b[31mred\u001b[0m with ghp_abcdefghijklmnopqrstuvwxyz0123",
    });
    expect(foldTranscript(null, [start], 1).digest.subagents[0]?.description).toBe(
      "red with [redacted]",
    );
  });

  it("ignores a task_updated status that names an Object.prototype member", () => {
    const start = JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id: "t9",
      task_type: "local_agent",
      subagent_type: "Explore",
      description: "x",
    });
    const patch = (status: string) =>
      JSON.stringify({ type: "system", subtype: "task_updated", task_id: "t9", patch: { status } });
    const note = (status: string) =>
      JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t9", status });
    for (const s of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const f = foldTranscript(null, [start, patch(s), note(s)], 1).digest;
      expect(f.subagents[0]?.status, s).toBe("running");
    }
  });

  it("cleans tool names (tools keys and the live tool) and the model at fold time", () => {
    const dirty = "\u001b[31mBash\u001b[0m ghp_abcdefghijklmnopqrstuvwxyz0123";
    const f = foldTranscript(
      null,
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s",
          model: "opus\u0007 sk-ant-abcdefghijklmnopqrstuvwxyz",
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: dirty }] },
          parent_tool_use_id: null,
          timestamp: "2026-10-18T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "result",
          modelUsage: { "opus\u0007 sk-ant-abcdefghijklmnopqrstuvwxyz": { contextWindow: 9 } },
        }),
        JSON.stringify({
          type: "assistant",
          message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: dirty }] },
          parent_tool_use_id: null,
          timestamp: "2026-10-18T10:01:00.000Z",
        }),
      ],
      1,
    );
    expect(f.model).toBe("opus [redacted]");
    expect(f.digest.model).toBe("opus [redacted]");
    // The window lookup still finds the (cleaned) model's entry.
    expect(f.digest.contextWindow).toBe(9);
    expect(Object.keys(f.digest.tools)).toEqual(["Bash [redacted]"]);
    expect(f.digest.liveTool?.name).toBe("Bash [redacted]");
  });

  it("names a tool made only of control characters (unnamed)", () => {
    const f = foldTranscript(
      null,
      [
        JSON.stringify({
          type: "assistant",
          message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "\u0001\u0002" }] },
          parent_tool_use_id: null,
          timestamp: "2026-10-18T10:00:00.000Z",
        }),
      ],
      1,
    );
    expect(Object.keys(f.digest.tools)).toEqual(["(unnamed)"]);
  });

  it("clears the live tool on a result line when the last top-level call never got a result", () => {
    const use = JSON.stringify({
      type: "assistant",
      message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash" }] },
      parent_tool_use_id: null,
      timestamp: "2026-10-18T10:00:00.000Z",
    });
    const result = JSON.stringify({ type: "result", total_cost_usd: 1 });
    expect(foldTranscript(null, [use], 1).digest.liveTool?.name).toBe("Bash");
    expect(foldTranscript(null, [use, result], 1).digest.liveTool).toBeNull();
    // Across chunks too.
    const a = foldTranscript(null, [use], 1);
    expect(foldTranscript(a, [result], 1).digest.liveTool).toBeNull();
    // A late result still records the call's duration.
    const late = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      parent_tool_use_id: null,
      timestamp: "2026-10-18T10:00:05.000Z",
    });
    const f = foldTranscript(null, [use, result, late], 1).digest;
    expect(f.liveTool).toBeNull();
    expect(f.tools.Bash?.durationsMs).toEqual([5000]);
  });

  it("does not treat heartbeat tool_progress lines as frames", () => {
    const hb = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "toolu_4-heartbeat-9",
      tool_name: "Bash",
      parent_tool_use_id: "toolu_4",
      heartbeat: true,
    });
    const f = foldTranscript(null, [...agentLines, hb, hb], 1).digest;
    expect(f).toEqual(d);
  });

  it("skips unknown line types and stream_event lines", () => {
    const withoutNoise = agentLines.filter(
      (l) => !l.includes('"subtype":"informational"') && !l.startsWith('{"type":"stream_event"'),
    );
    expect(foldTranscript(null, withoutNoise, 1).digest).toEqual(d);
    // A stream_event line is skipped by its prefix, before JSON.parse.
    const parse = vi.spyOn(JSON, "parse");
    try {
      foldTranscript(null, ['{"type":"stream_event","event":{}}'], 1);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps folding rate_limit_event and tokens alongside the digest", () => {
    const f = foldTranscript(null, agentLines, 7);
    expect(f.rateLimits.map((r) => r.window)).toEqual(["5h", "7d"]);
    expect(f.tokens).toEqual({ input: 120, output: 155, cacheRead: 25_700, cacheCreate: 1350 });
  });

  it("returns an empty digest for no lines", () => {
    expect(foldTranscript(null, [], 1).digest).toEqual({
      tasks: [],
      attemptUsage: [],
      toolCalls: 0,
      turns: 0,
      lastEventAt: null,
      model: null,
      contextTokens: null,
      contextWindow: null,
      liveTool: null,
      lastText: null,
      tools: {},
      subagents: [],
      minuteTokens: [],
      turnUsage: [],
      background: [],
      compactions: 0,
      costTokens: null,
      speed: { tokensPerSec: null, turnMs: null, firstTokenMs: null },
    });
  });
});

describe("foldTranscript compactions", () => {
  const boundary = (extra = {}) =>
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180_000 },
      ...extra,
    });

  it("counts top-level compact_boundary lines and ignores a subagent's", () => {
    const lines = [boundary(), boundary({ parent_tool_use_id: "toolu_9" }), boundary()];
    expect(foldTranscript(null, lines, 1).digest.compactions).toBe(2);
  });

  it("folds in chunks like at once", () => {
    const lines = [boundary(), boundary()];
    const once = foldTranscript(null, lines, 1);
    const chunked = foldTranscript(foldTranscript(null, lines.slice(0, 1), 1), lines.slice(1), 1);
    expect(chunked.digest.compactions).toBe(2);
    expect(chunked.digest).toEqual(once.digest);
  });
});

describe("foldTranscript background tasks", () => {
  const started = (task_id: string, task_type: string, description: string, extra = {}) =>
    JSON.stringify({
      type: "system",
      subtype: "task_started",
      task_id,
      tool_use_id: `tu_${task_id}`,
      description,
      is_backgrounded: true,
      task_type,
      ...extra,
    });
  const updated = (task_id: string, patch: Record<string, unknown>) =>
    JSON.stringify({ type: "system", subtype: "task_updated", task_id, patch });
  const notified = (task_id: string, status: string) =>
    JSON.stringify({ type: "system", subtype: "task_notification", task_id, status, summary: "s" });
  const result = JSON.stringify({ type: "result", total_cost_usd: 1, is_error: false });

  it("tracks every task in flight, any type, from task_started", () => {
    const f = foldTranscript(
      null,
      [
        started("b1", "local_bash", "pnpm test"),
        started("a1", "local_agent", "Find the fold", { subagent_type: "Explore" }),
      ],
      1,
    ).digest;
    expect(f.background).toEqual([
      { taskId: "b1", description: "pnpm test", type: "local_bash" },
      { taskId: "a1", description: "Find the fold", type: "local_agent" },
    ]);
  });

  // The run #28 shape: a result line, then a background shell still running.
  it("keeps a task open across a result line", () => {
    const f = foldTranscript(null, [started("b1", "local_bash", "long suite"), result], 1).digest;
    expect(f.background.map((b) => b.taskId)).toEqual(["b1"]);
  });

  it("closes a task on task_notification with any status", () => {
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      const f = foldTranscript(null, [started("b1", "local_bash", "x"), notified("b1", status)], 1);
      expect(f.digest.background, status).toEqual([]);
    }
  });

  it("closes a task on task_updated with a final status, not on other patches", () => {
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      const f = foldTranscript(
        null,
        [started("b1", "local_bash", "x"), updated("b1", { status, end_time: 1 })],
        1,
      );
      expect(f.digest.background, status).toEqual([]);
    }
    for (const patch of [{ is_backgrounded: true }, { status: null }, { status: "running" }]) {
      const f = foldTranscript(null, [started("b1", "local_bash", "x"), updated("b1", patch)], 1);
      expect(
        f.digest.background.map((b) => b.taskId),
        JSON.stringify(patch),
      ).toEqual(["b1"]);
    }
    for (const s of ["__proto__", "constructor", "toString"]) {
      const f = foldTranscript(
        null,
        [started("b1", "local_bash", "x"), updated("b1", { status: s })],
        1,
      );
      expect(f.digest.background, s).toHaveLength(1);
    }
  });

  it("folds in chunks like at once; a repeated task_started does not add the task twice", () => {
    const lines = [
      started("b1", "local_bash", "a"),
      started("b2", "local_bash", "b"),
      started("b2", "local_bash", "b"),
      notified("b1", "completed"),
      result,
    ];
    const whole = foldTranscript(null, lines, 1).digest;
    const a = foldTranscript(null, lines.slice(0, 2), 1);
    expect(foldTranscript(a, lines.slice(2), 1).digest).toEqual(whole);
    expect(a.digest.background).toHaveLength(2);
    expect(whole.background).toEqual([{ taskId: "b2", description: "b", type: "local_bash" }]);
  });

  it("cleans the description and type", () => {
    const f = foldTranscript(
      null,
      [
        started(
          "b1",
          "\u001b[31mlocal_bash",
          "\u001b[31mred\u001b[0m ghp_abcdefghijklmnopqrstuvwxyz0123",
        ),
      ],
      1,
    ).digest;
    expect(f.background).toEqual([
      { taskId: "b1", description: "red [redacted]", type: "local_bash" },
    ]);
  });
});

describe("foldTranscript PRs and summary", () => {
  const pr = (identifier: unknown, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "system",
      subtype: "code_change_published",
      provider: "github",
      url: `https://github.com/Owner-A/repo-b/pull/${String(identifier)}`,
      repo: "Owner-A/repo-b",
      identifier,
      action: "created",
      ...over,
    });
  const result = (text: unknown) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text });

  it("collects each GitHub PR once, in first-seen order, from code_change_published", () => {
    const f = foldTranscript(
      null,
      [
        pr("1767"),
        pr("1767", { action: "pushed" }),
        pr("abc"),
        pr("1769"),
        pr("12", { provider: "gitlab" }),
        pr("13", { repo: undefined }),
      ],
      1,
    );
    expect(f.prs).toEqual([
      { repo: "Owner-A/repo-b", number: 1767 },
      { repo: "Owner-A/repo-b", number: 1769 },
    ]);
  });

  it("folding PRs in chunks equals folding them at once, and never mutates the earlier facts", () => {
    const a = foldTranscript(null, [pr("1767")], 1);
    const b = foldTranscript(a, [pr("1767"), pr("1769")], 1);
    expect(a.prs).toEqual([{ repo: "Owner-A/repo-b", number: 1767 }]);
    expect(b.prs.map((p) => p.number)).toEqual([1767, 1769]);
  });

  it("cleans the repo name", () => {
    const f = foldTranscript(null, [pr("5", { repo: "Owner-A/\u001b[31mrepo-b" })], 1);
    expect(f.prs).toEqual([{ repo: "Owner-A/repo-b", number: 5 }]);
  });

  it("takes the summary from the latest result", () => {
    expect(foldTranscript(null, [pr("1")], 1).summary).toBeNull();
    const f = foldTranscript(
      null,
      [result("First attempt failed. Retrying"), result("**Merged** PR #1767. CI green.")],
      1,
    );
    expect(f.summary).toBe("Merged PR #1767. CI green.");
    const g = foldTranscript(f, [result("Then stopped at quota.\nMore")], 1);
    expect(g.summary).toBe("Then stopped at quota. More");
    expect(f.summary).toBe("Merged PR #1767. CI green.");
  });

  it("skips the DONE marker and describes the work", () => {
    const f = foldTranscript(
      null,
      [result("DONE. The draft PR is #174 (Closes #167). `reconcile` is in place.")],
      1,
    );
    expect(f.summary).toBe("The draft PR is #174 (Closes #167). reconcile is in place.");
    expect(foldTranscript(null, [result("x ".repeat(500))], 1).summary?.length).toBeLessThanOrEqual(
      240,
    );
  });
});

describe("foldTranscript live tool detail and last text", () => {
  const CWD = "/work/repo";
  const init = JSON.stringify({ type: "system", subtype: "init", cwd: CWD });
  const frame = (content: unknown[], at = "2026-10-21T10:00:00.000Z") =>
    JSON.stringify({
      type: "assistant",
      message: { id: `m-${at}`, content },
      parent_tool_use_id: null,
      timestamp: at,
    });
  const use = (name: string, input: unknown) =>
    frame([{ type: "tool_use", id: "t1", name, input }]);
  const detailOf = (name: string, input: unknown) =>
    foldTranscript(null, [init, use(name, input)], 1).digest.liveTool?.detail;

  it("Bash: the first line of the command, cut to 80 characters", () => {
    expect(LIVE_DETAIL_MAX).toBe(80);
    expect(detailOf("Bash", { command: "pnpm -s test\necho done" })).toBe("pnpm -s test");
    expect(detailOf("Bash", { command: "x".repeat(200) })).toBe(`${"x".repeat(79)}…`);
  });
  it("Bash: skips blank lines, and a command with nothing on its lines has no detail", () => {
    expect(detailOf("Bash", { command: "\n  \n  pnpm -s lint  \nnext" })).toBe("pnpm -s lint");
    expect(detailOf("Bash", { command: "  \n\t\n" })).toBeNull();
  });
  it("Bash: a cut detail ends in … and never in a space, by code point", () => {
    const words = detailOf("Bash", { command: "abcdefg ".repeat(30) }) as string;
    expect(words.length).toBeLessThanOrEqual(LIVE_DETAIL_MAX);
    expect(words.endsWith("abcdefg…")).toBe(true);
    const emoji = detailOf("Bash", { command: "😀".repeat(200) }) as string;
    expect(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji),
    ).toBe(false);
    expect(Array.from(emoji)).toHaveLength(LIVE_DETAIL_MAX);
  });
  it("Bash: drops a leading cd into the run's cwd", () => {
    expect(detailOf("Bash", { command: `cd ${CWD} && git status -sb` })).toBe("git status -sb");
    expect(detailOf("Bash", { command: `cd "${CWD}/" && git log` })).toBe("git log");
    expect(detailOf("Bash", { command: `cd ${CWD}; git diff` })).toBe("git diff");
    expect(detailOf("Bash", { command: `cd ${CWD}\ngit show` })).toBe("git show");
    expect(detailOf("Bash", { command: "cd /elsewhere && git log" })).toBe(
      "cd /elsewhere && git log",
    );
  });
  it("Read, Edit, Write: the path, relative to the cwd when inside it", () => {
    for (const name of ["Read", "Edit", "Write"]) {
      expect(detailOf(name, { file_path: `${CWD}/apps/server/a.ts` })).toBe("apps/server/a.ts");
    }
    expect(detailOf("Read", { file_path: "/etc/hosts" })).toBe("/etc/hosts");
    expect(detailOf("Read", { file_path: `${CWD}-other/a.ts` })).toBe(`${CWD}-other/a.ts`);
  });
  it("Grep and Glob: the pattern", () => {
    expect(detailOf("Grep", { pattern: "liveTool", path: "src" })).toBe("liveTool");
    expect(detailOf("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });
  it("an mc tool: its name without the prefix", () => {
    expect(detailOf("mcp__mc__commit", { message: "secret words" })).toBe("commit");
  });
  it("anything else, or an input of the wrong shape: null", () => {
    expect(detailOf("Agent", { prompt: "go" })).toBeNull();
    expect(detailOf("Bash", {})).toBeNull();
    expect(detailOf("Read", { file_path: 5 })).toBeNull();
    expect(detailOf("Bash", "ls")).toBeNull();
  });
  it("is cleaned, like the tool name", () => {
    expect(detailOf("Bash", { command: "echo \u001b[31mhi" })).toBe("echo hi");
  });

  it("lastText is the first sentence of the newest assistant text block", () => {
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      parent_tool_use_id: null,
      timestamp: "2026-10-21T10:00:05.000Z",
    });
    const text = frame(
      [{ type: "text", text: "**Tests** pass now. Next I fix lint." }],
      "2026-10-21T10:00:06.000Z",
    );
    const think = frame(
      [{ type: "thinking", thinking: "Hidden thought. More.", text: "Hidden thought." }],
      "2026-10-21T10:00:07.000Z",
    );
    expect(foldTranscript(null, [use("Bash", { command: "ls" })], 1).digest.lastText).toBeNull();
    const f = foldTranscript(null, [use("Bash", { command: "ls" }), result, text], 1);
    expect(f.digest.lastText).toBe("Tests pass now.");
    // Thinking never counts, and the newest text wins, across chunks too.
    expect(foldTranscript(f, [think], 1).digest.lastText).toBe("Tests pass now.");
    const later = frame([{ type: "text", text: "Done fixing." }], "2026-10-21T10:00:08.000Z");
    expect(foldTranscript(f, [think, later], 1).digest.lastText).toBe("Done fixing.");
  });
  it("lastText ignores a subagent's text and caps at 160 characters", () => {
    const sub = JSON.stringify({
      type: "assistant",
      message: { id: "ms", content: [{ type: "text", text: "Subagent talk." }] },
      parent_tool_use_id: "toolu_x",
    });
    expect(foldTranscript(null, [sub], 1).digest.lastText).toBeNull();
    const long = frame([{ type: "text", text: `${"word ".repeat(80)}end.` }]);
    const t = foldTranscript(null, [long], 1).digest.lastText as string;
    expect(t.length).toBeLessThanOrEqual(LAST_TEXT_MAX);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("foldTranscript: reply speed and the cost's token count", () => {
  const at = (s: number) => new Date(T("2026-10-22T10:00:00Z") + s * 1000).toISOString();
  const reply = (id: string, s: number, output: number, tool?: string) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        usage: { input_tokens: 10, output_tokens: output },
        content: tool ? [{ type: "tool_use", id: tool, name: "Bash", input: {} }] : [],
      },
      parent_tool_use_id: null,
      timestamp: at(s),
    });
  const ask = (tool: string, s: number, parent: string | null = null) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] },
      parent_tool_use_id: parent,
      timestamp: at(s),
    });
  const result = (cost: unknown = 1) => JSON.stringify({ type: "result", total_cost_usd: cost });

  it("measures each reply from its ask to its last frame; the first reply has no ask", () => {
    const f = foldTranscript(
      null,
      [
        reply("m1", 1, 999, "t1"), // the turn's first reply: no ask before it, left out
        ask("t1", 3),
        reply("m2", 5, 100, "t2"), // asked at 3, last frame at 5
        reply("m2", 6, 100), // a later frame of the same message: last frame at 6, 3 s in all
        ask("t2", 8),
        reply("m3", 12, 300), // asked at 8, last frame at 12: 4 s
      ],
      1,
    ).digest;
    // (100 + 300) tokens over (3 + 4) s, and the mean of 3 s and 4 s
    expect(f.speed?.tokensPerSec).toBeCloseTo(400 / 7, 10);
    expect(f.speed?.turnMs).toBe(3500);
  });

  it("is null with no ask, and a result line clears the ask", () => {
    const none = foldTranscript(null, [reply("m1", 1, 50)], 1).digest;
    expect(none.speed).toEqual({ tokensPerSec: null, turnMs: null, firstTokenMs: null });
    const cleared = foldTranscript(null, [ask("t1", 3), result(), reply("m2", 5, 100)], 1).digest;
    expect(cleared.speed).toEqual({ tokensPerSec: null, turnMs: null, firstTokenMs: null });
  });

  it("ignores a subagent's frames, and folds the same in chunks", () => {
    const all = [ask("t1", 3), ask("tx", 4, "toolu_sub"), reply("m2", 6, 90)];
    const whole = foldTranscript(null, all, 1);
    expect(whole.digest.speed).toEqual({ tokensPerSec: 30, turnMs: 3000, firstTokenMs: null });
    const chunked = foldTranscript(foldTranscript(null, all.slice(0, 2), 1), all.slice(2), 1);
    expect(chunked.digest.speed).toEqual(whole.digest.speed);
  });

  it("costTokens is the summed tokens at the latest result with a cost, null before one", () => {
    const m1 = reply("m1", 1, 100);
    const m2 = reply("m2", 5, 200);
    expect(foldTranscript(null, [m1], 1).digest.costTokens).toBeNull();
    const f = foldTranscript(null, [m1, result(), m2], 1);
    expect(f.digest.costTokens).toBe(110);
    expect(foldTranscript(f, [result()], 1).digest.costTokens).toBe(110 + 210);
    // a result with no numeric cost is not one
    expect(foldTranscript(null, [m1, result("x")], 1).digest.costTokens).toBeNull();
  });
});
