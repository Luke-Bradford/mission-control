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

  for (const vendor of ["claude", "codex"] as const) {
    it(`${vendor}: tails calls within two seconds, closes results and measures raw payloads`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
      const { ring, lines, transcriptPath } = setup(vendor);
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
