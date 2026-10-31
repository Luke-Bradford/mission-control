import { estimateTokens, PROMPT_SECTIONS } from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  mergeSections,
  promptSections,
  textBytes,
  toolResultBytes,
  wakePieces,
} from "../src/prompt-cost.ts";

const sum = (list: readonly { bytes: number }[]) => list.reduce((n, s) => n + s.bytes, 0);

describe("promptSections", () => {
  it("gives the remainder to the rest section, so the bytes add up exactly", () => {
    const whole = "héllo world, this is the whole prompt";
    const out = promptSections(whole, [{ section: "rules", bytes: 7 }], "role");
    expect(sum(out)).toBe(textBytes(whole));
    expect(out).toEqual([
      {
        section: "role",
        bytes: textBytes(whole) - 7,
        tokens: estimateTokens(textBytes(whole) - 7),
      },
      { section: "rules", bytes: 7, tokens: estimateTokens(7) },
    ]);
  });
  it("sums pieces of one section and drops zero-byte sections", () => {
    const out = promptSections(
      "x".repeat(20),
      [
        { section: "orders", bytes: 5 },
        { section: "orders", bytes: 5 },
        { section: "rules", bytes: 0 },
      ],
      "role",
    );
    expect(out.map((s) => [s.section, s.bytes])).toEqual([
      ["role", 10],
      ["orders", 10],
    ]);
  });
  it("clamps pieces larger than the whole, in order", () => {
    const out = promptSections(
      "x".repeat(10),
      [
        { section: "rules", bytes: 8 },
        { section: "orders", bytes: 8 },
      ],
      "role",
    );
    expect(out.map((s) => [s.section, s.bytes])).toEqual([
      ["rules", 8],
      ["orders", 2],
    ]);
    expect(sum(out)).toBe(10);
  });
});

describe("mergeSections", () => {
  it("sums by section and orders by PROMPT_SECTIONS", () => {
    const a = promptSections("x".repeat(10), [{ section: "ticket", bytes: 4 }], "role");
    const b = promptSections("y".repeat(6), [{ section: "digest", bytes: 2 }], "orders");
    const out = mergeSections(a, b);
    expect(out.map((s) => [s.section, s.bytes])).toEqual([
      ["role", 6],
      ["orders", 4],
      ["ticket", 4],
      ["digest", 2],
    ]);
    const order = out.map((s) => PROMPT_SECTIONS.indexOf(s.section));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe("toolResultBytes", () => {
  it("counts a string, the text of blocks, and a non-text block's JSON", () => {
    expect(toolResultBytes("héy")).toBe(4);
    expect(
      toolResultBytes([
        { type: "text", text: "abc" },
        { type: "text", text: "de" },
      ]),
    ).toBe(5);
    const image = { type: "image", source: "x" };
    expect(toolResultBytes([image])).toBe(textBytes(JSON.stringify(image)));
  });
  it("counts anything else as nothing", () => {
    expect(toolResultBytes(undefined)).toBe(0);
    expect(toolResultBytes(7)).toBe(0);
    expect(toolResultBytes(null)).toBe(0);
  });
});

describe("wakePieces", () => {
  it("splits the digest's JSON into lessons and the rest, adding up to its bytes", () => {
    const digest = { memory: { heading: "m", notes: ["é"] }, facts: { a: [1] } } as never;
    const pieces = wakePieces(digest);
    expect(sum(pieces)).toBe(textBytes(JSON.stringify(digest)));
    expect(pieces.map((p) => p.section).sort()).toEqual(["digest", "lessons"]);
    expect(pieces.find((p) => p.section === "lessons")?.bytes).toBe(
      textBytes(`"memory":${JSON.stringify((digest as { memory: unknown }).memory)},`),
    );
  });
});
