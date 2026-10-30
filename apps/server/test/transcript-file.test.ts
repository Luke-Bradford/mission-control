import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { type FoldState, foldPath } from "../src/collectors/common.ts";
import { transcriptMtime } from "../src/hud.ts";
import { readStream } from "../src/stream.ts";
import { offsetSince, readNewLines } from "../src/tail.ts";
import { openTranscript, transcriptFilePath } from "../src/transcript-file.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

it("reads a gzip transcript through its stored jsonl path", () => {
  dir = mkdtempSync(join(tmpdir(), "mc-transcript-file-"));
  const path = join(dir, "run.jsonl");
  writeFileSync(path, "one\ntwo\n");
  writeFileSync(`${path}.gz`, gzipSync("one\ntwo\n"));
  unlinkSync(path);
  expect(transcriptFilePath(path)).toBe(`${path}.gz`);
  const file = openTranscript(path);
  const buf = Buffer.alloc(file.size);
  expect(file.read(buf, 0, buf.length, 0)).toBe(buf.length);
  file.close();
  expect(buf.toString()).toBe("one\ntwo\n");
  expect(readNewLines(path, 0).lines).toEqual(["one", "two"]);
});

it("makes every transcript reader treat gzip like plain JSONL", () => {
  dir = mkdtempSync(join(tmpdir(), "mc-transcript-file-"));
  const text = readFileSync(resolve(import.meta.dirname, "fixtures/stream/agent.jsonl"));
  const plain = join(dir, "plain.jsonl");
  const gz = join(dir, "gzip.jsonl");
  writeFileSync(plain, text);
  writeFileSync(`${gz}.gz`, gzipSync(text));
  const mtime = new Date("2026-10-30T12:00:00Z");
  utimesSync(plain, mtime, mtime);
  utimesSync(`${gz}.gz`, mtime, mtime);
  expect(readStream(gz, 50)).toEqual(readStream(plain, 50));
  expect(readNewLines(gz, 0)).toEqual(readNewLines(plain, 0));
  expect(offsetSince(gz, Date.now() - 365 * 24 * 60 * 60_000)).toBe(
    offsetSince(plain, Date.now() - 365 * 24 * 60 * 60_000),
  );
  expect(foldPath(new Map<string, FoldState>(), gz)).toEqual(
    foldPath(new Map<string, FoldState>(), plain),
  );
  expect(transcriptMtime(gz)).not.toBeNull();
  expect(() => openTranscript(join(dir, "missing.jsonl"))).toThrow();
});

it("reports corrupt gzip reads through tail's error callback", () => {
  dir = mkdtempSync(join(tmpdir(), "mc-transcript-file-"));
  const path = join(dir, "bad.jsonl");
  writeFileSync(`${path}.gz`, "not gzip");
  const errors: unknown[] = [];
  expect(readNewLines(path, 0, { onError: (e) => errors.push(e) }).lines).toEqual([]);
  expect(errors).toHaveLength(1);
});
