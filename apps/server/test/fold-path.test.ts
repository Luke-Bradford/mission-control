import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FoldState, foldPath } from "../src/collectors/common.ts";
import { foldTranscript } from "../src/streamjson.ts";

// Records the bytes handed to each fold call, passing through to the real fold.
const foldCalls = vi.hoisted(() => ({ bytes: [] as number[] }));
vi.mock("../src/streamjson.ts", async (orig) => {
  const real = await orig<typeof import("../src/streamjson.ts")>();
  return {
    ...real,
    foldTranscript: (...args: Parameters<typeof real.foldTranscript>) => {
      foldCalls.bytes.push(args[1].reduce((n, l) => n + Buffer.byteLength(l) + 1, 0));
      return real.foldTranscript(...args);
    },
  };
});

const FIXTURE = resolve(import.meta.dirname, "fixtures/stream/agent.jsonl");
const fixtureLines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const longest = Math.max(...fixtureLines.map((l) => Buffer.byteLength(l) + 1));
const mtimeOf = (path: string) => Math.floor(statSync(path).mtimeMs);

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-fold-path-"));
  path = join(dir, "t.jsonl");
  writeFileSync(path, `${fixtureLines.join("\n")}\n`);
  foldCalls.bytes.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("foldPath", () => {
  it("folds a transcript larger than the chunk cap chunk by chunk, to the same facts", () => {
    const cap = 2048;
    const size = readFileSync(path).length;
    expect(size).toBeGreaterThan(cap * 3);
    expect(longest).toBeLessThan(cap);
    const whole = foldTranscript(null, fixtureLines, mtimeOf(path));
    foldCalls.bytes.length = 0;

    const state = new Map<string, FoldState>();
    const facts = foldPath(state, path, cap);

    expect(foldCalls.bytes.length).toBeGreaterThan(3);
    for (const b of foldCalls.bytes) expect(b).toBeLessThanOrEqual(cap);
    expect(state.get(path)?.offset).toBe(size);
    expect(facts).toEqual(whole);
  });

  it("holds at most the cap plus one line when a line is longer than the cap", () => {
    const cap = Math.floor(longest / 2);
    foldPath(new Map(), path, cap);
    expect(foldCalls.bytes.length).toBeGreaterThan(1);
    for (const b of foldCalls.bytes) expect(b).toBeLessThanOrEqual(cap + longest);
  });

  it("re-folds from 0 after a truncation, dropping the old facts", () => {
    const state = new Map<string, FoldState>();
    foldPath(state, path, 2048);
    writeFileSync(path, `${fixtureLines[0] as string}\n`);
    const facts = foldPath(state, path, 2048);
    expect(facts).toEqual(foldTranscript(null, [fixtureLines[0] as string], mtimeOf(path)));
  });

  it("folds multibyte text (emoji, CJK, accents) with tiny caps to the whole-file fold", () => {
    const summary = "Fertig 🚀 日本語のテスト café naïve. Zweiter Satz.";
    const lines = fixtureLines.map((l) => {
      if (!l.startsWith("{")) return l;
      const ev = JSON.parse(l) as { type?: string; result?: unknown };
      return ev.type === "result" ? JSON.stringify({ ...ev, result: summary }) : l;
    });
    writeFileSync(path, `${lines.join("\n")}\n`);
    const whole = foldTranscript(null, lines, mtimeOf(path));
    expect(whole.summary).toContain("🚀");
    for (const cap of [1, 7, 50, 333]) {
      const facts = foldPath(new Map(), path, cap);
      expect(facts).toEqual(whole);
    }
  });

  it("folds nothing new into the same facts when the file has not grown", () => {
    const state = new Map<string, FoldState>();
    const first = foldPath(state, path, 2048);
    foldCalls.bytes.length = 0;
    expect(foldPath(state, path, 2048)).toEqual(first);
    // The empty fold still runs: the mtime stamps the facts even when no line is new.
    expect(foldCalls.bytes).toEqual([0]);
  });

  it("stamps a whole-millisecond mtime on the rate limits", () => {
    utimesSync(path, 1_792_548_000.1234, 1_792_548_000.1234);
    const facts = foldPath(new Map(), path);
    expect(facts?.rateLimits.length).toBeGreaterThan(0);
    for (const r of facts?.rateLimits ?? []) {
      expect(r.at).toBe(1_792_548_000_123);
      expect(Number.isInteger(r.at)).toBe(true);
    }
  });

  it("gives an empty file empty facts rather than none", () => {
    writeFileSync(path, "");
    const state = new Map<string, FoldState>();
    const facts = foldPath(state, path, 2048);
    expect(facts).toEqual(foldTranscript(null, [], mtimeOf(path)));
    expect(state.get(path)?.facts).toEqual(facts);
  });
});
