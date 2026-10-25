import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STREAM_TEXT_MAX } from "@mc/core";
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
    vi.advanceTimersByTime(15 * 60_000 + 1);
    ring.poll();
    expect(ring.calls("seat")).toEqual([]);
  });
});
