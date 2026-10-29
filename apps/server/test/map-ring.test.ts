import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MapDelta, STREAM_TEXT_MAX } from "@mc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallRing } from "../src/map/ring.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(vendor: "claude" | "codex") {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
  const cwd = mkdtempSync(join(tmpdir(), "map-ring-"));
  dirs.push(cwd);
  const transcriptPath = join(cwd, "transcript.jsonl");
  writeFileSync(join(cwd, "file.ts"), "before\n");
  writeFileSync(transcriptPath, "");
  const source = { id: "run", seat: "seat", repoId: "repo", cwd, transcriptPath, vendor };
  const ring = new CallRing(() => [source]);
  const lines = readFileSync(new URL(`./fixtures/map/${vendor}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n");
  return { cwd, transcriptPath, ring, lines };
}

describe("crew call ring", () => {
  it("publishes per-repo sequences and lets a client detect a gap and refetch", () => {
    const { ring, transcriptPath, lines } = setup("claude");
    const received: MapDelta[] = [];
    const stop = ring.subscribe("repo", (delta) => received.push(delta));
    appendFileSync(transcriptPath, `${lines[0]}\n${lines[1]}\n`);
    ring.poll();
    expect(received.map((d) => [d.seq, d.type])).toEqual([
      [1, "call.start"],
      [2, "edit"],
      [3, "call.end"],
    ]);
    expect(ring.sequence("repo")).toBe(3);
    expect(ring.sequence("other")).toBe(0);
    // The future panel must refetch its snapshot on reconnect or any missing sequence (§6).
    const refetch = vi.fn();
    let seq = 0;
    for (const delta of received.filter((d) => d.seq !== 2)) {
      if (delta.seq !== seq + 1) refetch();
      seq = delta.seq;
    }
    expect(refetch).toHaveBeenCalledTimes(1);
    stop();
    appendFileSync(transcriptPath, `${lines.slice(2).join("\n")}\n`);
    ring.poll();
    expect(received).toHaveLength(3);
    expect(ring.sequence("repo")).toBeGreaterThan(3);
  });

  it("keeps repo sequences independent across interleaved calls and reconnects", () => {
    const { cwd, transcriptPath, lines } = setup("claude");
    const otherPath = join(cwd, "other.jsonl");
    writeFileSync(otherPath, "");
    const ring = new CallRing(() => [
      { id: "one", seat: "one", repoId: "one", cwd, transcriptPath },
      { id: "two", seat: "two", repoId: "two", cwd, transcriptPath: otherPath },
    ]);
    const one: MapDelta[] = [];
    const two: MapDelta[] = [];
    const stop = ring.subscribe("one", (delta) => one.push(delta));
    ring.subscribe("two", (delta) => two.push(delta));
    appendFileSync(transcriptPath, `${lines[0]}\n`);
    ring.poll();
    appendFileSync(otherPath, `${lines[0]}\n${lines[1]}\n`);
    ring.poll();
    stop();
    appendFileSync(transcriptPath, `${lines[1]}\n`);
    ring.poll();
    expect(one.map((d) => [d.seq, d.type, "seat" in d && d.seat])).toEqual([
      [1, "call.start", "one"],
      [2, "edit", "one"],
    ]);
    expect(two.map((d) => [d.seq, d.type, "seat" in d && d.seat])).toEqual([
      [1, "call.start", "two"],
      [2, "edit", "two"],
      [3, "call.end", "two"],
    ]);
    const refetch = vi.fn(() => ring.sequence("one"));
    const seq = refetch(); // Reconnect starts with a new snapshot, not replayed events.
    const resumed: MapDelta[] = [];
    ring.subscribe("one", (delta) => resumed.push(delta));
    appendFileSync(transcriptPath, `${lines.slice(2).join("\n")}\n`);
    ring.poll();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(resumed.map((d) => d.seq)).toEqual(resumed.map((_, i) => seq + i + 1));
    expect(resumed.at(-1)?.seq).toBe(ring.sequence("one"));
    expect(ring.sequence("one")).toBeGreaterThan(3);
    expect(ring.sequence("two")).toBe(3);
  });

  it("starts a restarted ring at the transcript's recent tail, not at offset 0", () => {
    const { transcriptPath, lines, ring } = setup("claude");
    const stale = (id: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id, name: "Stale", input: { file_path: "file.ts" } }],
        },
        timestamp: "2026-10-23T00:00:00Z",
      });
    // an old day of work, then the fixture's calls at "now"
    writeFileSync(transcriptPath, `${stale("old-1")}\n${stale("old-2")}\n${lines.join("\n")}\n`);
    const received: MapDelta[] = [];
    ring.subscribe("repo", (delta) => received.push(delta));
    ring.poll();
    expect(received.length).toBeGreaterThan(0);
    expect(received.some((d) => "tool" in d && d.tool === "Stale")).toBe(false);
  });

  it("polls only live runs, and reads a run once more when it stops being current", () => {
    const { cwd, transcriptPath, lines } = setup("claude");
    const source = { id: "run", seat: "seat", repoId: "repo", cwd, transcriptPath, current: true };
    const ring = new CallRing(() => [source]);
    const received: MapDelta[] = [];
    ring.subscribe("repo", (delta) => received.push(delta));
    appendFileSync(transcriptPath, `${lines[0]}\n`);
    ring.poll();
    const first = received.length;
    source.current = false;
    appendFileSync(transcriptPath, `${lines[1]}\n`);
    ring.poll(); // the last read of the finished run
    expect(received.length).toBeGreaterThan(first);
    const settled = received.length;
    appendFileSync(transcriptPath, `${lines[2]}\n${lines[3]}\n`);
    ring.poll();
    expect(received).toHaveLength(settled);
    source.current = true;
    ring.poll();
    expect(received.length).toBeGreaterThan(settled);
  });

  it("polls every second with a map client connected and every five seconds without", () => {
    const { ring } = setup("claude");
    const poll = vi.spyOn(ring, "poll");
    const stop = ring.start();
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    const unsubscribe = ring.subscribe("repo", () => {});
    vi.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(5);
    unsubscribe();
    stop();
  });

  it("moves its revision when a delta is published or a call ages out, and not otherwise", () => {
    const { transcriptPath, lines, ring } = setup("claude");
    const before = ring.revision("repo");
    ring.poll();
    expect(ring.revision("repo")).toBe(before);
    appendFileSync(transcriptPath, `${lines[0]}\n${lines[1]}\n`);
    ring.poll();
    const after = ring.revision("repo");
    expect(after).not.toBe(before);
    ring.poll();
    expect(ring.revision("repo")).toBe(after);
    vi.setSystemTime(new Date("2026-10-25T00:20:00Z"));
    ring.poll();
    expect(ring.revision("repo")).not.toBe(after);
  });

  for (const vendor of ["claude", "codex"] as const) {
    it(`${vendor}: tails calls within two seconds, closes results and measures raw payloads`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      const { ring, lines, transcriptPath } = setup(vendor);
      ring.subscribe("repo", () => {}); // a connected map client keeps the one-second cadence
      const stop = ring.start();
      const since = Date.now();
      appendFileSync(transcriptPath, `${lines[0]}\n`);
      vi.advanceTimersByTime(1000);
      expect(ring.calls("seat")[0]).toMatchObject({
        id: "edit",
        runId: "run",
        repoId: "repo",
        since,
        detail: "file.ts",
        writeTok: 3,
        tool: "Edit",
        files: ["file.ts"],
        end: null,
        churn: [{ file: "file.ts", add: 2, rem: 1, source: "churn" }],
      });
      appendFileSync(transcriptPath, `${lines[1]}\n`);
      vi.advanceTimersByTime(1000);
      expect(ring.calls("seat")[0]?.end).not.toBeNull();
      const output = `${"x".repeat(STREAM_TEXT_MAX + 71)}\n Tests  1 failed | 2 passed (3)\n`;
      appendFileSync(transcriptPath, `${lines.slice(2).join("\n")}\n`);
      vi.advanceTimersByTime(1000);
      expect(ring.calls("seat")[1]).toMatchObject({
        files: ["file.ts"],
        resultSize: output.length,
        resultTok: Math.ceil(output.length / 4),
        error: false,
        tests: { runner: "vitest", status: "failed", passed: 2, failed: 1 },
      });
      expect(ring.calls("seat")[2]).toMatchObject({
        refused: true,
        why: "Permission denied",
        error: false,
      });
      stop();
    });
  }
  for (const vendor of ["claude", "codex"] as const) {
    it(`${vendor}: retains an unfinished call beyond fifteen minutes and closes its late result`, () => {
      const { ring, transcriptPath, lines } = setup(vendor);
      appendFileSync(transcriptPath, `${lines[0]}\n`);
      ring.poll();
      vi.advanceTimersByTime(16 * 60_000);
      ring.poll();
      expect(ring.calls("seat")).toHaveLength(1);
      expect(ring.calls("seat")[0]?.end).toBeNull();
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ ...JSON.parse(lines[1] as string), timestamp: new Date().toISOString() })}\n`,
      );
      ring.poll();
      expect(ring.calls("seat")[0]?.end).not.toBeNull();
      vi.advanceTimersByTime(15 * 60_000 + 1);
      ring.poll();
      expect(ring.calls("seat")).toEqual([]);
    });
  }

  it("measures a result the transcript holds cut by the bytes it was, not the bytes kept (#934)", () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, 25, 0, 0, n)).toISOString();
    const claude = setup("claude");
    appendFileSync(
      claude.transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        timestamp: at(0),
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
        },
      })}\n${JSON.stringify({
        type: "user",
        timestamp: at(1),
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "kept",
              outputTruncated: { originalBytes: 4000 },
            },
          ],
        },
      })}\n`,
    );
    claude.ring.poll();
    expect(claude.ring.calls("seat")[0]).toMatchObject({ resultSize: 4000, resultTok: 1000 });
    const codex = setup("codex");
    const item = (extra: object) => ({
      id: "c1",
      type: "commandExecution",
      command: "pnpm test",
      ...extra,
    });
    appendFileSync(
      codex.transcriptPath,
      `${JSON.stringify({ method: "item/started", timestamp: at(0), params: { item: item({}) } })}\n${JSON.stringify(
        {
          method: "item/completed",
          timestamp: at(1),
          params: {
            item: item({ aggregatedOutput: "kept", outputTruncated: { originalBytes: 8000 } }),
          },
        },
      )}\n`,
    );
    codex.ring.poll();
    expect(codex.ring.calls("seat")[0]).toMatchObject({ resultSize: 8000, resultTok: 2000 });
  });

  it("resolves Glob patterns to existing files within the requested checkout directory", () => {
    const { ring, transcriptPath, cwd } = setup("claude");
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "src", "nested"));
    writeFileSync(join(cwd, "src", "a.ts"), "");
    writeFileSync(join(cwd, "src", "nested", "b.ts"), "");
    writeFileSync(join(cwd, "src", "other.js"), "");
    const inputs = [
      { pattern: "**/*.ts" },
      { path: "src", pattern: "**/*.ts" },
      { pattern: "**/*.missing" },
      { path: "..", pattern: "**/*.ts" },
    ];
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: inputs.map((input, i) => ({
            type: "tool_use",
            id: `glob-${i}`,
            name: "Glob",
            input,
          })),
        },
      })}\n`,
    );
    ring.poll();
    expect(ring.calls("seat").map((c) => c.files.slice().sort())).toEqual([
      ["file.ts", "src/a.ts", "src/nested/b.ts"],
      ["src/a.ts", "src/nested/b.ts"],
      [],
      [],
    ]);
  });

  it("records files only: a folder searched, listed or cd'd into is never a path (#946)", () => {
    const { ring, transcriptPath, cwd } = setup("claude");
    mkdirSync(join(cwd, "apps", "web"), { recursive: true });
    writeFileSync(join(cwd, "apps", "web", "a.ts"), "");
    const use = (id: string, name: string, input: Record<string, unknown>) => ({
      type: "tool_use",
      id,
      name,
      input,
    });
    const frames = [
      {
        type: "assistant",
        message: {
          content: [
            use("grep", "Grep", { pattern: "x", path: "apps/web" }),
            use("ls", "Bash", { command: "ls apps/web" }),
            use("cd", "Bash", { command: "cd apps/web && cat apps/web/a.ts" }),
          ],
        },
      },
      {
        type: "user",
        message: {
          content: ["grep", "ls", "cd"].map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: [{ type: "text", text: "ok" }],
          })),
        },
      },
    ];
    appendFileSync(transcriptPath, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    ring.poll();
    const files = ring.calls("seat").flatMap((c) => c.files);
    expect(files).toEqual(["apps/web/a.ts"]);
    expect(ring.scope("run").read).toEqual(["apps/web/a.ts"]);
  });

  it("counts a file opened as read, never the names a Glob listed", () => {
    const { ring, transcriptPath, cwd } = setup("claude");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "");
    writeFileSync(join(cwd, "src", "b.ts"), "");
    const frames = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "list", name: "Glob", input: { pattern: "**/*.ts" } },
            { type: "tool_use", id: "open", name: "Read", input: { file_path: "src/a.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: ["list", "open"].map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: [{ type: "text", text: "ok" }],
          })),
        },
      },
    ];
    appendFileSync(transcriptPath, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    ring.poll();
    expect(ring.calls("seat")[0]?.files.length).toBeGreaterThan(1);
    expect(ring.scope("run").read).toEqual(["src/a.ts"]);
  });

  it("measures the full NotebookEdit new_source payload before cleaning", () => {
    const { ring, transcriptPath } = setup("claude");
    const new_source = `${"cell\n".repeat(STREAM_TEXT_MAX)}last`;
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "notebook",
              name: "NotebookEdit",
              input: { notebook_path: "notes.ipynb", new_source },
            },
          ],
        },
      })}\n`,
    );
    ring.poll();
    expect(ring.calls("seat")[0]).toMatchObject({
      files: ["notes.ipynb"],
      writeTok: Math.ceil(new_source.length / 4),
      churn: [],
    });
  });

  it("updates Codex edits when their completed frame supplies the diff", () => {
    const { ring, transcriptPath } = setup("codex");
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ method: "item/started", params: { item: { id: "late", type: "fileChange", changes: [] } } })}\n`,
    );
    ring.poll();
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ method: "item/completed", params: { item: { id: "late", type: "fileChange", changes: [{ path: "file.ts", diff: "@@ -1 +1 @@\n-before\n+after\n" }] } } })}\n`,
    );
    ring.poll();
    expect(ring.calls("seat")[0]).toMatchObject({
      files: ["file.ts"],
      churn: [{ file: "file.ts", add: 1, rem: 1, source: "churn" }],
    });
  });

  it("publishes only the difference when Codex completion revises edit churn", () => {
    const { ring, transcriptPath } = setup("codex");
    const received: MapDelta[] = [];
    ring.subscribe("repo", (delta) => received.push(delta));
    for (const [method, changes] of [
      [
        "item/started",
        [
          { path: "file.ts", diff: "-before\n+after\n" },
          { path: "removed.ts", diff: "+line\n" },
        ],
      ],
      ["item/completed", [{ path: "file.ts", diff: "-before\n+after\n+extra\n" }]],
    ]) {
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ method, params: { item: { id: "revised", type: "fileChange", changes } } })}\n`,
      );
      ring.poll();
    }
    expect(received.filter((d) => d.type === "edit").map((d) => [d.file, d.add, d.rem])).toEqual([
      ["file.ts", 1, 1],
      ["removed.ts", 1, 0],
      ["file.ts", 1, 0],
      ["removed.ts", -1, 0],
    ]);
    expect(ring.calls("seat")[0]?.churn).toEqual([
      { file: "file.ts", add: 2, rem: 1, source: "churn" },
    ]);
  });

  it("counts diff content beginning with plus or minus and missing final newlines", () => {
    const { ring, transcriptPath } = setup("codex");
    const item = {
      id: "diff",
      type: "fileChange",
      changes: [
        {
          path: "file.ts",
          diff: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n---old\n+++new\n\\ No newline at end of file\n",
        },
      ],
    };
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ method: "item/completed", params: { item } })}\n`,
    );
    ring.poll();
    expect(ring.calls("seat")[0]).toMatchObject({
      writeTok: 2,
      churn: [{ file: "file.ts", add: 1, rem: 1, source: "churn" }],
    });
  });

  it("counts full write inputs, failure reasons, unknown runners and stopped calls honestly", () => {
    const { ring, transcriptPath } = setup("claude");
    const content = `${"line\n".repeat(STREAM_TEXT_MAX)}last`;
    const frames = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "write",
              name: "Write",
              input: { file_path: "file.ts", content },
            },
            {
              type: "tool_use",
              id: "fail",
              name: "Bash",
              input: { command: "other-runner file.ts ../outside.ts" },
            },
            { type: "tool_use", id: "cut", name: "Read", input: { file_path: "../outside.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "fail",
              is_error: true,
              content: [{ type: "text", text: "Tool failed" }],
            },
          ],
        },
      },
    ];
    appendFileSync(transcriptPath, `${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    ring.poll();
    expect(ring.calls("seat")[0]).toMatchObject({
      writeTok: Math.ceil(content.length / 4),
      churn: [{ file: "file.ts", add: STREAM_TEXT_MAX + 1, rem: 0, source: "churn" }],
    });
    expect(ring.calls("seat")[1]).toMatchObject({
      error: true,
      refused: false,
      why: "Tool failed",
      tests: { runner: null, status: "unknown" },
      files: ["file.ts"],
    });
    expect(ring.calls("seat")[2]).toMatchObject({
      end: null,
      error: false,
      refused: false,
      files: [],
    });
  });

  it("retains only fifteen minutes, isolates seats, ignores partial and child frames", () => {
    vi.useFakeTimers();
    const { ring, transcriptPath, lines } = setup("claude");
    appendFileSync(transcriptPath, lines[0] as string);
    ring.poll();
    expect(ring.calls("seat")).toEqual([]);
    appendFileSync(transcriptPath, "\n");
    ring.poll();
    expect(ring.calls("seat")).toHaveLength(1);
    expect(ring.calls("other")).toEqual([]);
    appendFileSync(
      transcriptPath,
      `${JSON.stringify({ ...JSON.parse(lines[0] as string), parent_tool_use_id: "parent" })}\n`,
    );
    ring.poll();
    expect(ring.calls("seat")).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    appendFileSync(transcriptPath, `${lines[1]}\n`);
    ring.poll();
    vi.advanceTimersByTime(15 * 60_000 + 1);
    ring.poll();
    expect(ring.calls("seat")).toEqual([]);
  });
});

it("retains branch scope and last tests after calls age out of the ring", () => {
  const { ring, transcriptPath, lines } = setup("claude");
  appendFileSync(transcriptPath, `${lines.join("\n")}\n`);
  ring.poll();
  vi.advanceTimersByTime(16 * 60_000);
  ring.poll();
  expect(ring.calls("seat")).toEqual([]);
  expect(ring.scope("run")).toMatchObject({
    modified: [{ file: "file.ts", add: 2, rem: 1, source: "churn" }],
    tests: { tests: { runner: "vitest", status: "failed", passed: 2, failed: 1 } },
  });
});
