import { describe, expect, it } from "vitest";
import { COMMS_PREVIEW_CHARS, logLine } from "../src/overview/logLine.ts";

describe("logLine", () => {
  it("leaves a short line as it is", () => {
    expect(logLine("push refused", "step")).toEqual({ text: "push refused", cut: false });
  });

  it("puts a multi-line event on one line", () => {
    expect(logLine("checks failed\n  lint:  2 errors\n", "step")).toEqual({
      text: "checks failed lint: 2 errors",
      cut: false,
    });
  });

  it("keeps a long event whole: the row clamps it and offers the rest", () => {
    const text = "x".repeat(400);
    expect(logLine(text, "step")).toEqual({ text, cut: false });
  });

  it("cuts a Comms message to its first 120 characters with an ellipsis", () => {
    const out = logLine("a".repeat(300), "comms");
    expect(COMMS_PREVIEW_CHARS).toBe(120);
    expect(out.cut).toBe(true);
    expect(Array.from(out.text)).toHaveLength(COMMS_PREVIEW_CHARS);
    expect(out.text.endsWith("…")).toBe(true);
  });

  it("does not cut a Comms message of exactly 120 characters", () => {
    const text = "b".repeat(COMMS_PREVIEW_CHARS);
    expect(logLine(text, "comms")).toEqual({ text, cut: false });
  });

  it("counts characters, not UTF-16 units, so it never splits an emoji", () => {
    const out = logLine("🚀".repeat(200), "comms");
    expect(Array.from(out.text)).toHaveLength(COMMS_PREVIEW_CHARS);
    expect(out.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
