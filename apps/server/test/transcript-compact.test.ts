import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactTranscripts, compactTranscriptText } from "../src/compact-transcripts.ts";
import { compactTranscriptLine, TRANSCRIPT_KEEP_BYTES } from "../src/runtime/transcript-compact.ts";

const MB = 1024 * 1024;
const codexDone = (out: string) =>
  JSON.stringify({
    method: "item/completed",
    params: { item: { type: "commandExecution", command: "pnpm test", aggregatedOutput: out } },
    timestamp: "2026-10-29T10:00:00.000Z",
  });
const contextAnswer = JSON.stringify({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: "r1",
    response: { categories: [], totalTokens: 9, maxTokens: 100, gridRows: [[1, 2]], mcpTools: [] },
  },
});

describe("compactTranscriptLine", () => {
  it("stores a Codex command with a 2 MB output in under 20 KB, with the marker", () => {
    const out = `${"a".repeat(TRANSCRIPT_KEEP_BYTES)}${"m".repeat(2 * MB)}${"z".repeat(TRANSCRIPT_KEEP_BYTES)}`;
    const kept = compactTranscriptLine(codexDone(out)) as string;
    expect(kept.length).toBeLessThan(20 * 1024);
    const item = JSON.parse(kept).params.item;
    expect(item.outputTruncated).toEqual({ bytes: out.length });
    expect(item.aggregatedOutput.startsWith("a".repeat(100))).toBe(true);
    expect(item.aggregatedOutput.endsWith("z".repeat(100))).toBe(true);
    expect(item.command).toBe("pnpm test");
  });

  it("drops outputDelta and get_context_usage answers, keeps other control responses", () => {
    const delta = JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: { delta: "x" },
    });
    expect(compactTranscriptLine(delta)).toBeNull();
    expect(compactTranscriptLine(contextAnswer)).toBeNull();
    const interrupt = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "r2", response: {} },
    });
    expect(compactTranscriptLine(interrupt)).toBe(interrupt);
  });

  it("cuts a Claude tool_result over 64 KB, string or text parts, and leaves small ones", () => {
    const big = "q".repeat(200 * 1024);
    const user = (content: unknown) =>
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t", content }] },
      });
    for (const content of [big, [{ type: "text", text: big }]]) {
      const kept = JSON.parse(compactTranscriptLine(user(content)) as string);
      const block = Array.isArray(kept.message.content[0].content)
        ? kept.message.content[0].content[0]
        : kept.message.content[0];
      expect(block.outputTruncated).toEqual({ bytes: big.length });
      expect(JSON.stringify(kept).length).toBeLessThan(20 * 1024);
    }
    const small = user("fine");
    expect(compactTranscriptLine(small)).toBe(small);
  });

  it("is idempotent and keeps non-JSON lines", () => {
    const once = compactTranscriptLine(codexDone("y".repeat(MB))) as string;
    expect(compactTranscriptLine(once)).toBe(once);
    expect(compactTranscriptLine("not json")).toBe("not json");
  });
});

describe("compacting existing transcripts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-compact-"));
    mkdirSync(join(dir, "crew"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const big = [codexDone("p".repeat(MB)), contextAnswer, '{"type":"result"}'].join("\n");

  function setup() {
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    db.exec(
      "CREATE TABLE runs (id TEXT PRIMARY KEY, ended_at INTEGER, transcript_path TEXT NOT NULL)",
    );
    const add = db.prepare("INSERT INTO runs VALUES (?, ?, ?)");
    for (const [id, ended] of [
      ["ended", 5],
      ["live", null],
    ] as const) {
      const p = join(dir, "crew", `${id}.jsonl`);
      writeFileSync(p, `${big}\n`, { mode: 0o600 });
      add.run(id, ended, p);
    }
    db.close();
    return (id: string) => join(dir, "crew", `${id}.jsonl`);
  }

  it("rewrites ended runs only, reports sizes, and a second run changes nothing", () => {
    const file = setup();
    const liveBefore = readFileSync(file("live"), "utf8");
    const first = compactTranscripts(join(dir, "mc.sqlite"));
    expect(first.skippedLive).toBe(1);
    expect(first.rewritten).toHaveLength(1);
    expect(first.rewritten[0]?.before).toBeGreaterThan(MB);
    expect(first.rewritten[0]?.after).toBe(statSync(file("ended")).size);
    expect(first.rewritten[0]?.after).toBeLessThan(20 * 1024);
    expect(statSync(file("ended")).mode & 0o777).toBe(0o600);
    expect(readFileSync(file("ended"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(file("live"), "utf8")).toBe(liveBefore);
    const after = readFileSync(file("ended"), "utf8");
    const second = compactTranscripts(join(dir, "mc.sqlite"));
    expect(second.rewritten).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(readFileSync(file("ended"), "utf8")).toBe(after);
  });

  it("keeps a final line with no newline as it is", () => {
    expect(compactTranscriptText(`${contextAnswer}\n{"a":1}\ncut`)).toBe('{"a":1}\ncut');
  });
});
