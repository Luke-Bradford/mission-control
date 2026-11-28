import { describe, expect, it } from "vitest";
import { peerIsBrowser, peerIsSeat } from "../src/peer-process.ts";

/** A fake process table for `lsof`, `ps`, and `codesign`. */
const fake =
  (
    tree: Record<number, { ppid: number; env: string; executable?: string; identifier?: string }>,
    client = 4242,
  ) =>
  (cmd: string, args: string[]): string => {
    if (cmd === "lsof" && args.includes("-d")) {
      const pid = Number(args.at(args.indexOf("-p") + 1));
      const row = tree[pid];
      if (!row) throw new Error("no such process");
      return `p${pid}\nftxt\nn${row.executable ?? "/usr/bin/curl"}\n`;
    }
    if (cmd === "lsof")
      return `p${client}\nn127.0.0.1:50000->127.0.0.1:7420\np9\nn127.0.0.1:7420->127.0.0.1:50000\n`;
    if (cmd === "codesign") {
      const row = Object.values(tree).find((peer) => peer.executable === args.at(-1));
      if (!row?.identifier || !args.some((arg) => arg.includes(`identifier "${row.identifier}"`)))
        throw new Error("unsigned executable");
      return "";
    }
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

  it("refuses when the parent walk hits its depth limit before reaching launchd", () => {
    // pid n has parent n+1; only a pid far up the chain carries the marker
    const chain = (cmd: string, args: string[]): string => {
      if (cmd === "lsof") return "p5000\nn127.0.0.1:50000->127.0.0.1:7420\n";
      const pid = Number(args.at(-1));
      if (args.includes("ppid=")) return `${pid + 1}\n`;
      return pid === 5016 ? "sh MC_SEAT_SANDBOX=1" : "sh PATH=/bin";
    };
    expect(peerIsSeat(50000, chain)).toBe(true);
  });

  it("refuses when a parent pid cannot be read", () => {
    const blank = (cmd: string, args: string[]): string => {
      if (cmd === "lsof") return "p5000\nn127.0.0.1:50000->127.0.0.1:7420\n";
      return args.includes("ppid=") ? "\n" : "sh PATH=/bin";
    };
    expect(peerIsSeat(50000, blank)).toBe(true);
  });
});

describe("peerIsBrowser", () => {
  it("accepts Chrome's absolute executable path behind a loopback connection", () => {
    const tree = {
      4242: {
        ppid: 1,
        env: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=utility",
        executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        identifier: "com.google.Chrome",
      },
    };
    expect(peerIsBrowser(50000, fake(tree))).toBe(true);
  });

  it("accepts a signed Chrome helper executable", () => {
    const tree = {
      4242: {
        ppid: 1,
        env: "Google Chrome Helper (Renderer)",
        executable:
          "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
        identifier: "com.google.Chrome.helper",
      },
    };
    expect(peerIsBrowser(50000, fake(tree))).toBe(true);
  });

  it("refuses a curl-like peer whose arguments and environment name every allowed browser", () => {
    const tree = {
      4242: {
        ppid: 1,
        env: "curl Google Chrome Chromium Safari Firefox Arc Brave Browser Microsoft Edge com.google.Chrome PATH=/bin",
        executable: "/usr/bin/curl",
      },
    };
    expect(peerIsBrowser(50000, fake(tree))).toBe(false);
  });

  it("refuses Docker's proxy behind a forged browser request", () => {
    const tree = {
      4242: { ppid: 100, env: "com.docker.backend PATH=/bin" },
      100: { ppid: 1, env: "launchd" },
    };
    expect(peerIsBrowser(50000, fake(tree))).toBe(false);
  });
});
