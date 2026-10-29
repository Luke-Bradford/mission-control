import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactTranscripts, compactTranscriptText } from "../src/compact-transcripts.ts";
import {
  compactTranscriptLine,
  DELTA_HEARTBEAT_MS,
  deltaHeartbeats,
  TRANSCRIPT_KEEP_BYTES,
} from "../src/runtime/transcript-compact.ts";
import { crewKeeperDir, Store } from "../src/store.ts";
import { foldTranscript } from "../src/streamjson.ts";

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
const parse = (s: string | null) => JSON.parse(s as string);

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

  it("drops get_context_usage answers and deltas without a limiter, keeps other control responses", () => {
    const delta = JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "i", delta: "x" },
      timestamp: "2026-10-29T10:00:00.000Z",
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

  it("cuts a Claude line's tool_use_result copy and an image's base64, shaped like real lines", () => {
    const big = "w".repeat(150 * 1024);
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              { type: "text", text: big },
              { type: "image", source: { type: "base64", media_type: "image/png", data: big } },
            ],
          },
        ],
      },
      tool_use_result: { stdout: big, stderr: "small", interrupted: false },
    });
    const kept = compactTranscriptLine(line) as string;
    expect(kept.length).toBeLessThan(40 * 1024);
    const m = JSON.parse(kept);
    const parts = m.message.content[0].content;
    expect(parts[0].outputTruncated).toEqual({ bytes: big.length });
    expect(parts[1].source).toMatchObject({ data: "", outputTruncated: { bytes: big.length } });
    expect(m.tool_use_result).toMatchObject({
      stderr: "small",
      interrupted: false,
      outputTruncated: { bytes: big.length },
    });
    // a tool_use_result that is an array of parts, or a string, is cut too
    const arr = JSON.stringify({ type: "user", tool_use_result: [{ type: "text", text: big }] });
    expect(parse(compactTranscriptLine(arr)).tool_use_result[0].outputTruncated).toEqual({
      bytes: big.length,
    });
    const str = JSON.stringify({ type: "user", tool_use_result: big });
    expect((compactTranscriptLine(str) as string).length).toBeLessThan(20 * 1024);
  });

  it("cuts the command outputs of a Codex JSON-RPC result (a resume answer)", () => {
    const big = "r".repeat(2 * MB);
    const item = (type: string) => ({ type, id: "i", aggregatedOutput: big });
    const line = JSON.stringify({
      id: 4,
      result: {
        thread: { id: "th", turns: [{ items: [item("commandExecution"), item("other")] }] },
        turns: [{ items: [item("commandExecution")] }],
        items: [item("commandExecution")],
      },
    });
    const kept = compactTranscriptLine(line) as string;
    const r = JSON.parse(kept).result;
    expect(r.thread.turns[0].items[0].outputTruncated).toEqual({ bytes: big.length });
    expect(r.thread.turns[0].items[1].aggregatedOutput).toBe(big); // not a command
    expect(r.turns[0].items[0].outputTruncated).toEqual({ bytes: big.length });
    expect(r.items[0].outputTruncated).toEqual({ bytes: big.length });
  });

  it("is idempotent and keeps non-JSON lines", () => {
    const once = compactTranscriptLine(codexDone("y".repeat(MB))) as string;
    expect(compactTranscriptLine(once)).toBe(once);
    expect(compactTranscriptLine("not json")).toBe("not json");
  });
});

describe("delta heartbeats", () => {
  const start = Date.parse("2026-10-29T10:00:00.000Z");
  const delta = (sec: number, itemId = "cmd") =>
    JSON.stringify({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "th", turnId: "tu", itemId, delta: "output\n" },
      timestamp: new Date(start + sec * 1000).toISOString(),
    });

  it("keeps a stripped heartbeat per item per minute, and a heartbeat is kept as it is", () => {
    const hb = deltaHeartbeats();
    const first = compactTranscriptLine(delta(0), hb);
    expect(parse(first)).toEqual({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "th", turnId: "tu", itemId: "cmd" },
      timestamp: new Date(start).toISOString(),
    });
    expect(compactTranscriptLine(delta(30), hb)).toBeNull();
    expect(compactTranscriptLine(delta(30, "other"), hb)).not.toBeNull();
    expect(compactTranscriptLine(delta(DELTA_HEARTBEAT_MS / 1000), hb)).not.toBeNull();
    expect(compactTranscriptLine(first as string, hb)).toBe(first);
    expect(compactTranscriptLine(first as string)).toBe(first);
  });

  it("a 15-minute delta-only command still advances lastEventAt through the digest fold", () => {
    const hb = deltaHeartbeats();
    const kept: string[] = [];
    for (let sec = 0; sec <= 15 * 60; sec++) {
      const line = compactTranscriptLine(delta(sec), hb);
      if (line !== null) kept.push(line);
    }
    expect(kept.length).toBeLessThan(20);
    const facts = foldTranscript(null, kept, start, "codex");
    expect(facts.digest.lastEventAt).toBeGreaterThanOrEqual(start + 14 * 60 * 1000);
  });
});

describe("compacting existing transcripts", () => {
  let dir: string;
  let store: Store;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-compact-"));
    dbPath = join(dir, "mc.sqlite");
    store = new Store(dbPath);
    mkdirSync(join(dir, "crew"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const big = [codexDone("p".repeat(MB)), contextAnswer, '{"type":"result"}'].join("\n");
  const NOW = Date.now() + 3_600_000; // an hour on: every file below is old enough
  const run = (id: string, path: string, endedAt: number | null): Run => ({
    id,
    agentId: "guido-1",
    repoId: "shop-app",
    seq: 1,
    startedAt: 1,
    endedAt,
    status: endedAt === null ? "running" : "ok",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: path,
    prs: [],
    summary: null,
    reviewId: null,
  });
  const crewFile = (id: string) => join(dir, "crew", `${id}.jsonl`);
  const add = (id: string, endedAt: number | null, path = crewFile(id), text = `${big}\n`) => {
    writeFileSync(path, text, { mode: 0o600 });
    store.upsertRun(run(id, path, endedAt));
    return path;
  };
  const summarise = () => compactTranscripts(dbPath, () => {}, NOW);

  it("rewrites ended runs only, reports sizes, and a second run changes nothing", () => {
    add("ended", 5);
    add("live", null);
    const liveBefore = readFileSync(crewFile("live"), "utf8");
    const first = summarise();
    expect(first.skippedLive).toBe(1);
    expect(first.rewritten).toHaveLength(1);
    expect(first.rewritten[0]?.before).toBeGreaterThan(MB);
    expect(first.rewritten[0]?.after).toBe(statSync(crewFile("ended")).size);
    expect(first.rewritten[0]?.after).toBeLessThan(20 * 1024);
    expect(statSync(crewFile("ended")).mode & 0o777).toBe(0o600);
    expect(readFileSync(crewFile("ended"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readFileSync(crewFile("live"), "utf8")).toBe(liveBefore);
    const after = readFileSync(crewFile("ended"), "utf8");
    const second = summarise();
    expect(second.rewritten).toEqual([]);
    expect(second.unchanged).toBe(1);
    expect(readFileSync(crewFile("ended"), "utf8")).toBe(after);
  });

  it("leaves an observed loop's transcript outside crew/ alone, and a link into it", () => {
    const outside = join(dir, "loop-logs");
    mkdirSync(outside);
    const path = add("loop", 5, join(outside, "run.log"));
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(path, old, old);
    const stat = statSync(path);
    // a link inside crew/ to a file outside it
    symlinkSync(path, crewFile("linked"));
    store.upsertRun(run("linked", crewFile("linked"), 5));
    const s = summarise();
    expect(s.skippedOutside).toBe(2);
    expect(s.rewritten).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(`${big}\n`);
    expect(statSync(path).mtimeMs).toBe(stat.mtimeMs);
  });

  it("skips an ended run whose keeper pid is alive, and a file written lately", () => {
    add("keeper", 5);
    const keeperDir = crewKeeperDir(dbPath, "keeper");
    mkdirSync(keeperDir, { recursive: true });
    writeFileSync(join(keeperDir, "keeper.pid"), `${process.pid}\n`);
    add("recent", 5);
    const s = compactTranscripts(dbPath, () => {}, Date.now());
    expect(s.rewritten).toEqual([]);
    expect(s.skippedLive).toBe(2);
    expect(readFileSync(crewFile("keeper"), "utf8")).toBe(`${big}\n`);
  });

  it("keeps a final line with no newline as it is", () => {
    expect(compactTranscriptText(`${contextAnswer}\n{"a":1}\ncut`)).toBe('{"a":1}\ncut');
  });
});
