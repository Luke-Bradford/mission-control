import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { readNewLines } from "../src/tail.ts";
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
