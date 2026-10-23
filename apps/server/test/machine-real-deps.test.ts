import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { cmd: string; args: string[]; options: unknown }[]);

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    options: unknown,
    cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push({ cmd, args, options });
    cb(null, { stdout: "out", stderr: "" });
  },
}));

import { realMachineDeps } from "../src/collectors/machine.ts";

describe("realMachineDeps", () => {
  it("runs vm_stat and ps with fixed arguments, a 2 s timeout and utf8 output", async () => {
    const deps = realMachineDeps();
    expect(await deps.vmStat()).toBe("out");
    expect(await deps.ps()).toBe("out");
    expect(calls).toEqual([
      {
        cmd: "vm_stat",
        args: [],
        options: expect.objectContaining({ timeout: 2000, encoding: "utf8" }),
      },
      {
        cmd: "ps",
        args: ["-axo", "pid=,rss=,%cpu=,comm="],
        options: expect.objectContaining({ timeout: 2000, encoding: "utf8" }),
      },
    ]);
  });
});
