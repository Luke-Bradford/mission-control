import { describe, expect, it } from "vitest";
import { peerIsSeat } from "../src/peer-process.ts";

/** A fake `lsof`/`ps`: `tree` maps a pid to its parent and its environment line. */
const fake =
  (tree: Record<number, { ppid: number; env: string }>, client = 4242) =>
  (cmd: string, args: string[]): string => {
    if (cmd === "lsof")
      return `p${client}\nn127.0.0.1:50000->127.0.0.1:7420\np9\nn127.0.0.1:7420->127.0.0.1:50000\n`;
    const pid = Number(args.at(-1));
    const row = tree[pid];
    if (!row) throw new Error("no such process");
    return args.includes("ppid=") ? `${row.ppid}\n` : `${row.env}\n`;
  };

describe("peerIsSeat", () => {
  it("is true when the caller descends from a seat process", () => {
    const tree = {
      4242: { ppid: 100, env: "curl PATH=/bin" },
      100: { ppid: 50, env: "zsh PATH=/bin MC_SEAT_SANDBOX=1 HOME=/x" },
      50: { ppid: 1, env: "claude" },
    };
    expect(peerIsSeat(50000, fake(tree))).toBe(true);
  });

  it("is false for a caller outside every seat", () => {
    const tree = {
      4242: { ppid: 100, env: "Chrome PATH=/bin" },
      100: { ppid: 1, env: "launchd" },
    };
    expect(peerIsSeat(50000, fake(tree))).toBe(false);
  });

  it("is true, refusing, when the caller cannot be identified", () => {
    expect(
      peerIsSeat(50000, () => {
        throw new Error("lsof missing");
      }),
    ).toBe(true);
    expect(peerIsSeat(undefined, fake({}))).toBe(true);
  });
});
