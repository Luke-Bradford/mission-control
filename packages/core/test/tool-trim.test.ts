import { describe, expect, it } from "vitest";
import {
  TOOL_TRIM_HEAD,
  TOOL_TRIM_OVER,
  TOOL_TRIM_TAIL,
  toolTrimMarker,
  trimToolResponse,
} from "../src/tool-trim.ts";

const FULL = "/tmp/run/tool-output/toolu_1.txt";
const bytes = (s: string) => Buffer.byteLength(s);
const cutOf = (tool: string, response: unknown) => {
  const r = trimToolResponse(tool, response, FULL);
  if (r === null) throw new Error("not cut");
  return r;
};
const stdoutOf = (text: string) =>
  (cutOf("Bash", { stdout: text }).output as { stdout: string }).stdout;

describe("trimToolResponse", () => {
  it("leaves a result of 32 KB or less alone", () => {
    expect(trimToolResponse("Bash", { stdout: "x".repeat(TOOL_TRIM_OVER - 100) }, FULL)).toBeNull();
    expect(trimToolResponse("mcp__mc__x", "short", FULL)).toBeNull();
    expect(trimToolResponse("Bash", undefined, FULL)).toBeNull();
  });

  it("cuts a long string to 8 KB head, 4 KB tail and a marker naming the file", () => {
    const text = `${"a".repeat(TOOL_TRIM_HEAD)}${"m".repeat(100_000)}${"z".repeat(TOOL_TRIM_TAIL)}`;
    const r = trimToolResponse("mcp__x__dump", text, FULL);
    const cut = bytes(text) - TOOL_TRIM_HEAD - TOOL_TRIM_TAIL;
    expect(r?.full).toBe(text);
    expect(r?.output).toBe(
      `${"a".repeat(TOOL_TRIM_HEAD)}\n${toolTrimMarker(cut, FULL)}\n${"z".repeat(TOOL_TRIM_TAIL)}`,
    );
    expect(toolTrimMarker(cut, FULL)).toContain(`${cut} bytes`);
    expect(toolTrimMarker(cut, FULL)).toContain(FULL);
  });

  it("keeps the shape of a Bash result: only stdout is cut", () => {
    const stdout = "o".repeat(200_000);
    const r = trimToolResponse("Bash", { stdout, stderr: "warn", interrupted: false }, FULL);
    const out = r?.output as Record<string, unknown>;
    expect(out.stderr).toBe("warn");
    expect(out.interrupted).toBe(false);
    expect(bytes(out.stdout as string)).toBeLessThan(TOOL_TRIM_HEAD + TOOL_TRIM_TAIL + 400);
    expect(r?.full).toBe(JSON.stringify({ stdout, stderr: "warn", interrupted: false }));
  });

  it("cuts the text blocks of an MCP content array and keeps other blocks", () => {
    const image = { type: "image", source: { data: "abc" } };
    const r = trimToolResponse(
      "mcp__x__y",
      [{ type: "text", text: "t".repeat(90_000) }, image],
      FULL,
    );
    const out = r?.output as { type: string; text?: string }[];
    expect(out).toHaveLength(2);
    expect(bytes(out[0]?.text ?? "")).toBeLessThan(TOOL_TRIM_HEAD + TOOL_TRIM_TAIL + 400);
    expect(out[1]).toEqual(image);
  });

  it("falls back to a text cut of the whole when no single string is the bulk", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ n: i, label: `row ${i}` }));
    const r = trimToolResponse("mcp__x__rows", many, FULL);
    expect(typeof r?.output).toBe("string");
    expect(bytes(r?.output as string)).toBeLessThan(TOOL_TRIM_HEAD + TOOL_TRIM_TAIL + 400);
    expect(r?.full).toBe(JSON.stringify(many));
  });

  it("takes a Bash tail from the last FAIL or error line when there is one", () => {
    const noise = "ok line\n".repeat(20_000);
    const text = `${noise}FAIL src/a.test.ts > breaks\nAssertionError: expected 1 to be 2\n${"summary\n".repeat(1500)}`;
    const out = stdoutOf(text);
    expect(out).toContain("FAIL src/a.test.ts > breaks");
    expect(out).toContain("AssertionError: expected 1 to be 2");
    expect(out.startsWith("ok line\n")).toBe(true);
  });

  it("matches error lines too, and takes the last one", () => {
    const text = `${"fine\n".repeat(20_000)}error TS2322: first\n${"fine\n".repeat(5_000)}error TS2345: last\ntail\n`;
    const out = stdoutOf(text);
    expect(out).toContain("error TS2345: last");
    expect(out).not.toContain("error TS2322: first");
  });

  it("uses the plain last 4 KB for a tool that is not Bash, and when no line fails", () => {
    const text = `${"x\n".repeat(30_000)}FAIL not a build\nend`;
    const other = (cutOf("mcp__x__y", text).output as string).split("\n");
    expect(other.at(-1)?.endsWith("end")).toBe(true);
    const plain = `${"x".repeat(50_000)}END`;
    const out = stdoutOf(plain);
    expect(out.endsWith(`${"x".repeat(TOOL_TRIM_TAIL - 3)}END`)).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    const r = trimToolResponse("mcp__x__y", `a${"é".repeat(60_000)}`, FULL);
    expect(r?.output).not.toContain("�");
  });

  it("leaves a result whole when its shape cannot be kept and the tool may not return text", () => {
    const filenames = Array.from({ length: 1500 }, (_, i) => `/repo/deep/path/file-${i}.ts`);
    expect(trimToolResponse("Grep", { mode: "files_with_matches", filenames }, FULL)).toBeNull();
  });

  it("never trims the file-edit tools: their bulk does not reach the model", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const write = {
      type: "update",
      filePath: "/a.ts",
      content: "x",
      originalFile: lines.join("\n"),
    };
    expect(trimToolResponse("Write", { ...write, structuredPatch: [{ lines }] }, FULL)).toBeNull();
    for (const tool of ["Edit", "MultiEdit", "NotebookEdit"]) {
      const big = { filePath: "/a.ts", originalFile: "x".repeat(100_000), structuredPatch: [] };
      expect(trimToolResponse(tool, big, FULL), tool).toBeNull();
    }
  });
});
