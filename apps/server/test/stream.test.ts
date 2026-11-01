import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStream,
  readStreamPage,
  STREAM_CHUNK_BYTES,
  STREAM_SCAN_BYTES,
} from "../src/stream.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/stream/agent.jsonl");
const T = (iso: string) => Date.parse(iso);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-stream-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (i: number) => new Date(T("2026-10-18T10:00:00Z") + i * 1000).toISOString();
const say = (text: string, i = 0) =>
  JSON.stringify({
    type: "assistant",
    message: { id: `m${i}`, content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    timestamp: at(i),
  });
const filler = (bytes: number): string => {
  const line = `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"${"x".repeat(200)}"}}}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
};
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe("readStream", () => {
  it("pages older: `before` an event's id returns the events ahead of it, and says if more remain", () => {
    const p = write(
      "page.jsonl",
      `${[1, 2, 3, 4, 5, 6, 7].map((i) => say(`m${i}`, i)).join("\n")}\n`,
    );
    const newest = readStreamPage(p, 3);
    expect(newest.events.map((e) => e.text)).toEqual(["m5", "m6", "m7"]);
    expect(newest.more).toBe(true);
    const older = readStreamPage(p, 3, undefined, newest.events[0]?.id);
    expect(older.events.map((e) => e.text)).toEqual(["m2", "m3", "m4"]);
    expect(older.more).toBe(true);
    const oldest = readStreamPage(p, 3, undefined, older.events[0]?.id);
    expect(oldest.events.map((e) => e.text)).toEqual(["m1"]);
    expect(oldest.more).toBe(false);
  });

  it("turns the fixture's top-level frames into events, oldest first", () => {
    const { events, truncated } = readStream(FIXTURE, 200);
    expect(truncated).toBe(false);
    expect(events.map((e) => [e.kind, e.text])).toEqual([
      ["think", "thinking"],
      ["msg", "I will run the tests."],
      ["tool", "Bash"],
      ["tool", "Read"],
      ["tool", "Agent"],
      ["sys", "Subagent started: Explore · Find the fold"],
      ["sys", "Subagent started: general-purpose · Check CI"],
      ["sys", "Pushed"],
      ["sys", "PR created: https://github.com/o/r/pull/7"],
      ["msg", "Done. Checking the PR."],
      ["tool", "Bash"],
    ]);
    const [, , bash, read, agent] = events;
    expect(bash).toMatchObject({
      at: T("2026-10-18T10:00:06Z"),
      tool: {
        name: "Bash",
        input: JSON.stringify({ command: "pnpm test", description: "Run the tests" }),
        result: "Tests 42 passed",
        ms: 30_000,
        error: false,
      },
    });
    expect(read?.tool).toMatchObject({ result: "File does not exist.", ms: 1000, error: true });
    expect(agent?.tool?.result).toBe("The fold is in apps/server/src/streamjson.ts.");
    // The live call has no result yet.
    expect(events.at(-1)?.tool).toMatchObject({ name: "Bash", result: null, ms: null });
  });

  it("returns the newest `limit` events", () => {
    const { events } = readStream(FIXTURE, 3);
    expect(events.map((e) => e.text)).toEqual([
      "PR created: https://github.com/o/r/pull/7",
      "Done. Checking the PR.",
      "Bash",
    ]);
  });

  it("names a result whose call lies before the scan window `(earlier call)`", () => {
    const p = write(
      "t.jsonl",
      `${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "gone", content: "late" }] },
        parent_tool_use_id: null,
        timestamp: at(5),
      })}\n`,
    );
    expect(readStream(p, 10).events).toEqual([
      {
        id: "0:0",
        at: T(at(5)),
        kind: "tool",
        text: "(earlier call)",
        tool: { name: "(earlier call)", input: "", result: "late", ms: null, error: false },
      },
    ]);
  });

  it("maps top-level user text to op and skips subagent frames", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Please carry on" }] },
        parent_tool_use_id: null,
        timestamp: at(1),
      }),
      JSON.stringify({
        type: "assistant",
        message: { id: "s", content: [{ type: "text", text: "subagent talk" }] },
        parent_tool_use_id: "toolu_parent",
        timestamp: at(2),
      }),
      JSON.stringify({ type: "system", subtype: "vcs_state_changed", kind: "push", branch: "b" }),
      JSON.stringify({ type: "system", subtype: "vcs_state_changed", kind: "commit" }),
      "",
    ];
    const p = write("t.jsonl", lines.join("\n"));
    const pushedAt = (lines[0]?.length ?? 0) + (lines[1]?.length ?? 0) + 2;
    expect(readStream(p, 10).events).toEqual([
      { id: "0:0", at: T(at(1)), kind: "op", text: "Please carry on" },
      { id: `${pushedAt}:0`, at: null, kind: "sys", text: "Pushed b" },
    ]);
  });

  it("reads a 10 MB transcript of stream_event filler up to the scan cap: the last 30 events, truncated", () => {
    const real = Array.from({ length: 30 }, (_, i) => say(`event ${i}`, i)).join("\n");
    const p = write("big.jsonl", `${filler(10 * 1024 * 1024)}${real}\n${filler(64 * 1024)}`);
    const { events, truncated } = readStream(p, 200);
    expect(truncated).toBe(true);
    expect(events.map((e) => e.text)).toEqual(Array.from({ length: 30 }, (_, i) => `event ${i}`));
  });

  it("stops early when the last chunk already holds `limit` events", () => {
    const real = Array.from({ length: 50 }, (_, i) => say(`event ${i}`, i)).join("\n");
    // A first line that is not JSON at all: reached only if the reader scanned the whole file.
    const p = write("t.jsonl", `${"z".repeat(STREAM_SCAN_BYTES)}\n${real}\n`);
    const { events, truncated } = readStream(p, 20);
    expect(truncated).toBe(false);
    expect(events.map((e) => e.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `event ${i + 30}`),
    );
  });

  it("skips a partial first line, a non-JSON line and a cut last line", () => {
    const whole = say("kept", 2);
    const p = write(
      "t.jsonl",
      `${whole.slice(20)}\n=== fire START ===\n${whole}\n${say("cut", 3).slice(0, 40)}`,
    );
    expect(readStream(p, 10).events.map((e) => e.text)).toEqual(["kept"]);
  });

  it("skips one line longer than the scan cap", () => {
    const huge = say("y".repeat(9 * 1024 * 1024), 1);
    const p = write("t.jsonl", `${say("before", 0)}\n${huge}\n${say("after", 2)}\n`);
    const { events, truncated } = readStream(p, 10);
    expect(events.map((e) => e.text)).toEqual(["after"]);
    expect(truncated).toBe(true);
  });

  it("joins a line that spans several chunks", () => {
    const long = say("w".repeat(STREAM_CHUNK_BYTES * 2 + 17), 1);
    const p = write("t.jsonl", `${say("first", 0)}\n${long}\n`);
    const { events } = readStream(p, 10);
    expect(events.map((e) => e.text.length)).toEqual([5, 2000]);
  });

  it("returns markup as the same string and redacts a token", () => {
    const xss = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    const p = write(
      "t.jsonl",
      `${say(xss, 0)}\n${say("token ghp_abcdefghijklmnopqrstuvwxyz0123 here", 1)}\n`,
    );
    expect(readStream(p, 10).events.map((e) => e.text)).toEqual([xss, "token [redacted] here"]);
  });

  it("cleans tool input and result text", () => {
    const p = write(
      "t.jsonl",
      [
        JSON.stringify({
          type: "assistant",
          message: {
            id: "m",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Bash",
                input: { command: "echo AKIAABCDEFGHIJKLMNOP" },
              },
            ],
          },
          parent_tool_use_id: null,
          timestamp: at(0),
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "\u001b[32mok\u001b[0m" }],
          },
          parent_tool_use_id: null,
          timestamp: at(1),
        }),
        "",
      ].join("\n"),
    );
    expect(readStream(p, 10).events[0]?.tool).toEqual({
      name: "Bash",
      input: '{"command":"echo [redacted]"}',
      result: "ok",
      ms: 1000,
      error: false,
    });
  });

  it("gives every event a stable id: its line's byte offset and block index", () => {
    const { events } = readStream(FIXTURE, 200);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events) expect(e.id).toMatch(/^\d+:\d+$/);
    // The first line holds the first event at offset 0.
    const two = JSON.stringify({
      type: "assistant",
      message: {
        id: "m0",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      parent_tool_use_id: null,
      timestamp: at(0),
    });
    const p = write("ids.log", `${two}\n${say("c", 1)}\n`);
    expect(readStream(p, 10).events.map((e) => [e.id, e.text])).toEqual([
      ["0:0", "a"],
      ["0:1", "b"],
      [`${two.length + 1}:0`, "c"],
    ]);
  });

  it("keeps an event's id when the window moves on and when the read crosses chunks", () => {
    const lines = Array.from({ length: 6 }, (_, i) => say(`m${i}`, i));
    const p = write("move.log", `${lines.slice(0, 4).join("\n")}\n`);
    const before = readStream(p, 3).events;
    writeFileSync(p, `${lines.join("\n")}\n`);
    const after = readStream(p, 3).events;
    expect(before.map((e) => e.text)).toEqual(["m1", "m2", "m3"]);
    expect(after.map((e) => e.text)).toEqual(["m3", "m4", "m5"]);
    expect(after[0]?.id).toBe(before[2]?.id);
    // A line that spans chunk boundaries keeps the offset it starts at.
    const big = say("y".repeat(STREAM_CHUNK_BYTES * 2), 7);
    const q = write("big.log", `${say("x", 6)}\n${big}\n`);
    expect(readStream(q, 10).events.map((e) => e.id)).toEqual([
      "0:0",
      `${say("x", 6).length + 1}:0`,
    ]);
  });

  it("reads an empty file as no events", () => {
    expect(readStream(write("e.jsonl", ""), 10)).toEqual({ events: [], truncated: false });
  });

  it("handles a file with no trailing newline whose last line is complete", () => {
    const p = join(dir, "t.jsonl");
    const fd = openSync(p, "w");
    writeSync(fd, `${say("a", 0)}\n${say("b", 1)}`);
    closeSync(fd);
    expect(readStream(p, 10).events.map((e) => e.text)).toEqual(["a", "b"]);
  });
});

describe("Codex stream", () => {
  const fixture = resolve(import.meta.dirname, "fixtures/stream/codex.jsonl");
  it("shows messages, tools, approval decisions and the plan", () => {
    const events = readStream(fixture, 200, "codex").events;
    expect(readStream(fixture, 200).events).toEqual(events);
    expect(events.map((e) => e.kind)).toEqual([
      "msg",
      "tool",
      "sys",
      "sys",
      "tool",
      "tool",
      "sys",
      "sys",
      "msg",
    ]);
    expect(events.find((e) => e.text === "Bash")?.tool).toMatchObject({
      name: "Bash",
      input: '{"command":"pnpm test"}',
      result: "Tests passed\n",
      status: "completed",
      exitCode: 0,
      ms: 1200,
      error: false,
    });
    expect(events.find((e) => e.text === "Edit")?.tool?.input).toContain("/work/a.ts");
    expect(events.some((e) => e.text === "mcp__mc__status")).toBe(true);
    expect(events.some((e) => e.text.includes("approved"))).toBe(true);
    expect(events.some((e) => e.text.includes("declined"))).toBe(true);
    expect(events.some((e) => e.text.includes("[completed] Run tests"))).toBe(true);
    expect(readStream(fixture, 1).events).toEqual(events.slice(-1));
  });

  it("keeps the command's id as its result arrives and reads a result without its start", () => {
    const lines = readFileSync(fixture, "utf8").trim().split("\n");
    const path = write("codex.jsonl", `${lines.slice(0, 6).join("\n")}\n`);
    const before = readStream(path, 200).events.find((e) => e.text === "Bash");
    expect(before?.tool?.result).toBeNull();
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(readStream(path, 200).events.find((e) => e.text === "Bash")?.id).toBe(before?.id);
    const result = write("result.jsonl", `${lines[8]}\n`);
    expect(readStream(result, 1).events[0]?.tool).toMatchObject({
      name: "Bash",
      exitCode: 0,
      ms: 1200,
    });
  });
});

it("detects Codex from an initialize response and honours the run vendor", () => {
  const path = write(
    "rpc.jsonl",
    `${JSON.stringify({ id: 0, result: { userAgent: "codex" } })}\n${JSON.stringify({ method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "Ready" } } })}\n`,
  );
  expect(readStream(path, 20).events.map((e) => e.text)).toEqual(["Ready"]);
  expect(readStream(path, 20, "claude").events).toEqual([]);
});

it("shows failed Codex command status and cleans and bounds its output", () => {
  const path = write(
    "failed.jsonl",
    `${JSON.stringify({ method: "item/completed", params: { item: { type: "commandExecution", id: "c", command: "false", aggregatedOutput: `\u001b[31mfailed\u001b[0m${"x".repeat(STREAM_CHUNK_BYTES)}`, status: "failed", exitCode: 1, durationMs: 12 } } })}\n`,
  );
  const tool = readStream(path, 20).events[0]?.tool;
  expect(tool).toMatchObject({ status: "failed", exitCode: 1, error: true, ms: 12 });
  expect(tool?.result).not.toContain("\u001b");
  expect(tool?.result?.length).toBeLessThan(STREAM_CHUNK_BYTES);
});

it("defers stream format detection past bookkeeping and unknown objects", () => {
  const fixture = readFileSync(resolve(import.meta.dirname, "fixtures/stream/codex.jsonl"), "utf8");
  const path = write("growing.jsonl", `${fixture.split("\n")[0]}\n`);
  expect(readStream(path, 200).events).toEqual([]);
  writeFileSync(path, fixture);
  expect(readStream(path, 200).events).toEqual(readStream(path, 200, "codex").events);
  const claude = write(
    "claude.jsonl",
    `${JSON.stringify({ type: "bookkeeping" })}\n{}\n${say("Ready.")}\n`,
  );
  expect(readStream(claude, 200).events.map((e) => e.text)).toEqual(["Ready."]);
});

it("says how many bytes a cut result lost (#934)", () => {
  const p = write(
    "cut.jsonl",
    `${[
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
        parent_tool_use_id: null,
        timestamp: at(0),
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "kept",
              outputTruncated: { originalBytes: 123456 },
            },
          ],
        },
        parent_tool_use_id: null,
        timestamp: at(1),
      }),
    ].join("\n")}\n`,
  );
  const text = JSON.stringify(readStream(p, 10).events);
  expect(text).toContain("kept\\n(cut from 123456 bytes)");
});

it("keeps a compaction as a typed system event in the activity timeline", () => {
  const path = write(
    "compact.jsonl",
    `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at(1) })}\n`,
  );
  expect(readStream(path, 10).events).toEqual([
    expect.objectContaining({ kind: "sys", text: "Context compacted" }),
  ]);
});
