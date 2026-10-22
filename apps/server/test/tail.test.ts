import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, MAX_READ_BYTES, readNewLines } from "../src/tail.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-tail-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readNewLines", () => {
  it("returns only complete lines and stops at the last newline", () => {
    const p = join(dir, "a.log");
    writeFileSync(p, "one\ntwo\npart");
    const r = readNewLines(p, 0);
    expect(r.lines).toEqual(["one", "two"]);
    expect(r.nextOffset).toBe(8);
    appendFileSync(p, "ial\n");
    const r2 = readNewLines(p, r.nextOffset);
    expect(r2.lines).toEqual(["partial"]);
    expect(r2.nextOffset).toBe(16);
  });

  it("returns nothing when there is no newline yet", () => {
    const p = join(dir, "b.log");
    writeFileSync(p, "nope");
    expect(readNewLines(p, 0)).toEqual({ lines: [], nextOffset: 0, reset: false });
  });

  it("restarts from 0 when the file is smaller than the offset", () => {
    const p = join(dir, "c.log");
    writeFileSync(p, "x\ny\n");
    expect(readNewLines(p, 999)).toEqual({ lines: ["x", "y"], nextOffset: 4, reset: true });
  });

  it("returns an unchanged offset for a missing file", () => {
    expect(readNewLines(join(dir, "missing.log"), 42)).toEqual({
      lines: [],
      nextOffset: 42,
      reset: false,
    });
  });

  it("handles multi-byte characters with byte offsets", () => {
    const p = join(dir, "d.log");
    writeFileSync(p, "héllo\nwörld\n");
    const r = readNewLines(p, 0);
    expect(r.lines).toEqual(["héllo", "wörld"]);
    expect(r.nextOffset).toBe(Buffer.byteLength("héllo\nwörld\n"));
  });

  it("strips a trailing CR from CRLF lines", () => {
    const p = join(dir, "crlf.log");
    writeFileSync(p, "one\r\ntwo\r\nthree");
    const r = readNewLines(p, 0);
    expect(r.lines).toEqual(["one", "two"]);
    expect(r.nextOffset).toBe(10);
  });

  it("flags reset only when the file shrank below the offset", () => {
    const p = join(dir, "r.log");
    writeFileSync(p, "aaaa\nbbbb\n");
    expect(readNewLines(p, 10).reset).toBe(false);
    writeFileSync(p, "c\n");
    const r = readNewLines(p, 10);
    expect(r).toEqual({ lines: ["c"], nextOffset: 2, reset: true });
  });

  it("caps each call and resumes from nextOffset", () => {
    const p = join(dir, "cap.log");
    writeFileSync(p, "aaaa\nbbbb\ncccc\n");
    const r1 = readNewLines(p, 0, { maxBytes: 11 });
    expect(r1.lines).toEqual(["aaaa", "bbbb"]);
    expect(r1.nextOffset).toBe(10);
    const r2 = readNewLines(p, r1.nextOffset, { maxBytes: 11 });
    expect(r2.lines).toEqual(["cccc"]);
    expect(r2.nextOffset).toBe(15);
    expect(readNewLines(p, 15, { maxBytes: 11 })).toEqual({
      lines: [],
      nextOffset: 15,
      reset: false,
    });
  });

  it("returns a single line longer than the cap alone", () => {
    const p = join(dir, "long.log");
    writeFileSync(p, `${"x".repeat(50)}\nshort\n`);
    const r = readNewLines(p, 0, { maxBytes: 8 });
    expect(r.lines).toEqual(["x".repeat(50)]);
    expect(r.nextOffset).toBe(51);
    const r2 = readNewLines(p, 51, { maxBytes: 8 });
    expect(r2.lines).toEqual(["short"]);
  });

  it("keeps the offset for an over-cap line that has no newline yet", () => {
    const p = join(dir, "open.log");
    writeFileSync(p, "x".repeat(50));
    expect(readNewLines(p, 0, { maxBytes: 8 })).toEqual({ lines: [], nextOffset: 0, reset: false });
  });

  it("defaults the cap to MAX_READ_BYTES", () => {
    expect(MAX_READ_BYTES).toBe(8 * 1024 * 1024);
  });

  it("reads the tail of a 50 MB file quickly", () => {
    const p = join(dir, "big.log");
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(p, line.repeat(500_000));
    const size = 100 * 500_000;
    const start = performance.now();
    const r = readNewLines(p, size - 1000);
    const elapsed = performance.now() - start;
    expect(r.lines).toHaveLength(10);
    expect(r.nextOffset).toBe(size);
    expect(elapsed).toBeLessThan(200);
  });

  it("fails soft on a directory: empty result, offset kept, onError called", () => {
    const errors: unknown[] = [];
    const r = readNewLines(dir, 7, { onError: (e) => errors.push(e) });
    expect(r).toEqual({ lines: [], nextOffset: 7, reset: false });
    expect(errors).toHaveLength(1);
  });

  it("skips a line longer than maxLineBytes and reports it", () => {
    const p = join(dir, "huge.log");
    writeFileSync(p, `${"x".repeat(100)}\nok\n`);
    const errors: unknown[] = [];
    const opts = { maxBytes: 8, maxLineBytes: 50, onError: (e: unknown) => errors.push(e) };
    const r = readNewLines(p, 0, opts);
    expect(r).toEqual({ lines: [], nextOffset: 101, reset: false });
    expect(errors).toHaveLength(1);
    expect(readNewLines(p, 101, opts).lines).toEqual(["ok"]);
  });

  it("keeps the offset and reports when no newline appears within maxLineBytes", () => {
    const p = join(dir, "endless.log");
    writeFileSync(p, "x".repeat(100));
    const errors: unknown[] = [];
    const r = readNewLines(p, 0, { maxBytes: 8, maxLineBytes: 50, onError: (e) => errors.push(e) });
    expect(r).toEqual({ lines: [], nextOffset: 0, reset: false });
    expect(errors).toHaveLength(1);
  });

  it("defaults the line cap to MAX_LINE_BYTES", () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
  });
});
