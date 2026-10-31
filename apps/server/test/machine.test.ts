import type { CpuInfo } from "node:os";
import type { MachineSample } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import {
  cpuPercent,
  type MachineDeps,
  parseMemoryPressure,
  parsePs,
  parseSwapUsage,
  parseTopConsumers,
  parseVmStat,
  sampleMachine,
} from "../src/collectors/machine.ts";

// Recorded on macOS (Apple silicon), 2026-10-18; trimmed to the lines the sampler reads and more.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    20291.
Pages active:                                 541351.
Pages inactive:                               537706.
Pages speculative:                              3226.
Pages throttled:                                   0.
Pages wired down:                             144555.
Pages purgeable:                                2491.
"Translation faults":                    18882109672.
Pages stored in compressor:                   557127.
`;
const PAGE = 16384;
const TOTAL = 24 * 1024 ** 3;

// `ps -axo pid=,rss=,%cpu=,comm=` on the same Mac, a handful of lines; home paths anonymised.
const PS = `    1  14288   0.0 /sbin/launchd
 5630  31968   0.0 /Users/user/.vscode/extensions/openai.chatgpt-26.1007.21434-darwin-arm64/bin/macos-aarch64/codex
 5899 391520   2.0 /Users/user/.vscode/extensions/anthropic.claude-code-2.1.301-darwin-arm64/resources/native-binary/claude
12812 243088   2.3 claude
20001  50000   9.9 /Users/user/Library/Application Support/Claude Tools/claude
20002  60000   1.0 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer)
20003  70000   1.0 /usr/local/bin/claude-code-guide
28102 269344   0.5 claude
`;

const cpu = (user: number, sys: number, idle: number): CpuInfo => ({
  model: "x",
  speed: 0,
  times: { user, nice: 0, sys, idle, irq: 0 },
});

const sample = (over: Partial<MachineSample> = {}): MachineSample => ({
  at: 1000,
  cpuPct: 12,
  cores: 2,
  memUsedBytes: 5,
  memTotalBytes: TOTAL,
  diskFreeBytes: 100,
  diskTotalBytes: 400,
  agents: { count: 1, rssBytes: 2048, cpuPct: 3 },
  ...over,
});

function deps(over: Partial<MachineDeps> = {}): MachineDeps {
  return {
    cpus: () => [cpu(300, 100, 600), cpu(100, 100, 800)],
    totalmem: () => TOTAL,
    freemem: () => 1024 ** 3,
    vmStat: async () => VM_STAT,
    swapUsage: async () => "vm.swapusage: total = 22528.00M  used = 21500.50M  free = 1027.50M",
    memoryPressure: async () => "System-wide memory free percentage: 9%\n",
    loadavg: () => [1.25, 1, 0.5],
    statfs: async () => ({ bavail: 250, blocks: 1000, bsize: 4096 }),
    ps: async () => PS,
    psTree: async () => "",
    testCommand: null,
    prevCpus: [cpu(100, 100, 400), cpu(50, 50, 400)],
    prev: null,
    now: 5000,
    ...over,
  };
}

describe("parsers", () => {
  it("reads macOS swap usage and memory-pressure free percentage", () => {
    expect(
      parseSwapUsage(
        "vm.swapusage: total = 22528.00M  used = 21500.50M  free = 1027.50M  (encrypted)",
      ),
    ).toEqual({ totalBytes: 22528 * 1024 ** 2, usedBytes: 21500.5 * 1024 ** 2 });
    expect(parseMemoryPressure("System-wide memory free percentage: 9%\n")).toBe(9);
    expect(parseSwapUsage("unavailable")).toBeNull();
    expect(parseMemoryPressure("unavailable")).toBeNull();
  });
  it("computes memory used as total − (free + inactive + speculative) × page size", () => {
    const available = (20291 + 537706 + 3226) * PAGE;
    expect(parseVmStat(VM_STAT, TOTAL)).toBe(TOTAL - available);
    expect(parseVmStat("garbage", TOTAL)).toBeNull();
  });

  it("sums claude and codex processes by command basename, command may hold spaces", () => {
    // codex 31968 + claude 391520 + 243088 + 50000 (path with spaces) + 269344 KiB
    expect(parsePs(PS)).toEqual({ count: 5, rssBytes: 985920 * 1024, cpuPct: 14.7 });
    expect(parsePs("")).toEqual({ count: 0, rssBytes: 0, cpuPct: 0 });
  });

  it("keeps the highest-RSS process rows for a machine-capacity alert", () => {
    expect(parseTopConsumers(PS)).toEqual([
      { pid: 5899, command: "claude", rssBytes: 391520 * 1024, cpuPct: 2 },
      { pid: 28102, command: "claude", rssBytes: 269344 * 1024, cpuPct: 0.5 },
      { pid: 12812, command: "claude", rssBytes: 243088 * 1024, cpuPct: 2.3 },
      { pid: 20003, command: "claude-code-guide", rssBytes: 70000 * 1024, cpuPct: 1 },
      { pid: 20002, command: "Claude Helper (Renderer)", rssBytes: 60000 * 1024, cpuPct: 1 },
    ]);
  });

  it("computes CPU % from the busy/total tick delta across all cores", () => {
    // ticks: previous busy 300 of 1100, current busy 600 of 2000 → 300 busy of 900.
    const prev = [cpu(100, 100, 400), cpu(50, 50, 400)];
    const cur = [cpu(300, 100, 600), cpu(100, 100, 800)];
    expect(cpuPercent(prev, cur)).toBeCloseTo((300 / 900) * 100, 6);
    expect(cpuPercent(cur, cur)).toBeNull();
  });
});

// `ps -axww -o pid=,ppid=,rss=,%cpu=,args=`: a test run (shell, pnpm, vitest), an agent and a bystander.
const PS_TREE = `  100     1  1000  1.0 /bin/zsh -c pnpm -s test
  101   100  2000  2.0 node /opt/homebrew/bin/pnpm -s test
  102   101  3000 30.5 node vitest
  200     1  9000  5.0 claude
  300     1   500  1.0 node other.js
`;

describe("sampleMachine", () => {
  it.each(["", " --run"])("excludes similarly named test commands (suffix %j)", async (suffix) => {
    const r = await sampleMachine(
      deps({
        testCommand: "pnpm test",
        psTree: async () => `100 1 1000 1.0 /bin/zsh -c pnpm test${suffix}
101 100 2000 2.0 node vitest
200 1 9000 5.0 node /opt/homebrew/bin/pnpm test:unit
201 200 9000 5.0 node vitest
300 1 9000 5.0 pnpm test:e2e
`,
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.sample.testRun).toEqual({ count: 2, rssBytes: 3000 * 1024, cpuPct: 3 });
  });

  it("separates the test-lock holder's process tree from agents", async () => {
    const r = await sampleMachine(
      deps({ psTree: async () => PS_TREE, testCommand: "pnpm -s test" }),
    );
    expect(r.errors).toEqual([]);
    expect(r.sample.testRun).toEqual({ count: 3, rssBytes: 6000 * 1024, cpuPct: 33.5 });
    expect(r.sample.agents).toEqual(parsePs(PS));
    const free = await sampleMachine(deps({ psTree: async () => PS_TREE, testCommand: null }));
    expect(free.sample.testRun).toBeNull();
    const failed = await sampleMachine(
      deps({
        testCommand: "pnpm -s test",
        psTree: async () => {
          throw new Error("ps timed out");
        },
      }),
    );
    expect(failed.sample.testRun).toBeNull();
    expect(failed.errors).toEqual(["ps tree: ps timed out"]);
  });

  it("reads CPU, memory, disk and processes", async () => {
    const r = await sampleMachine(deps());
    expect(r.errors).toEqual([]);
    expect(r.sample).toEqual({
      at: 5000,
      cpuPct: (300 / 900) * 100,
      cores: 2,
      memUsedBytes: TOTAL - (20291 + 537706 + 3226) * PAGE,
      memTotalBytes: TOTAL,
      diskFreeBytes: 250 * 4096,
      diskTotalBytes: 1000 * 4096,
      swapUsedBytes: 21500.5 * 1024 ** 2,
      swapTotalBytes: 22528 * 1024 ** 2,
      memoryPressureFreePct: 9,
      load1: 1.25,
      agents: { count: 5, rssBytes: 985920 * 1024, cpuPct: 14.7 },
      topConsumers: parseTopConsumers(PS),
      testRun: null,
    });
    expect(r.cpus).toHaveLength(2);
  });

  it("first sample has no CPU delta: cpuPct null", async () => {
    const r = await sampleMachine(deps({ prevCpus: null }));
    expect(r.sample.cpuPct).toBeNull();
    expect(r.sample.cores).toBe(2);
    expect(r.errors).toEqual([]);
  });

  it("ps failing with no previous sample gives agents null and an error", async () => {
    const r = await sampleMachine(
      deps({
        ps: async () => {
          throw new Error("ps timed out");
        },
      }),
    );
    expect(r.sample.agents).toBeNull();
    expect(r.errors).toEqual(["ps: ps timed out"]);
  });

  it("ps failing keeps the previous agents", async () => {
    const prev = sample();
    const r = await sampleMachine(
      deps({
        prev,
        ps: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(r.sample.agents).toEqual(prev.agents);
    expect(r.errors).toEqual(["ps: boom"]);
  });

  it("vm_stat failing falls back to total − freemem", async () => {
    const r = await sampleMachine(
      deps({
        vmStat: async () => {
          throw new Error("not found");
        },
      }),
    );
    expect(r.sample.memUsedBytes).toBe(TOTAL - 1024 ** 3);
    expect(r.errors).toEqual(["vm_stat: not found"]);
    const bad = await sampleMachine(deps({ vmStat: async () => "nonsense" }));
    expect(bad.sample.memUsedBytes).toBe(TOTAL - 1024 ** 3);
    expect(bad.errors).toHaveLength(1);
  });

  it("reads only os values and spawns no command when spawn is off", async () => {
    const never = vi.fn(async () => {
      throw new Error("spawned");
    });
    const prev = sample({ swapUsedBytes: 7, swapTotalBytes: 9, memoryPressureFreePct: 40 });
    const r = await sampleMachine(
      deps({
        spawn: false,
        vmStat: never,
        swapUsage: never,
        memoryPressure: never,
        ps: never,
        psTree: never,
        prev,
      }),
    );
    expect(never).not.toHaveBeenCalled();
    expect(r.errors).toEqual([]);
    // os.freemem counts inactive pages as used: the last vm_stat figure stands
    expect(r.sample.memUsedBytes).toBe(prev.memUsedBytes);
    expect(r.sample).toMatchObject({
      load1: 1.25,
      diskFreeBytes: 250 * 4096,
      swapUsedBytes: 7,
      memoryPressureFreePct: 40,
      agents: prev.agents,
    });
  });

  it("disk failing keeps the previous disk values, or null", async () => {
    const fail = async () => {
      throw new Error("EIO");
    };
    const kept = await sampleMachine(deps({ prev: sample(), statfs: fail }));
    expect(kept.sample.diskFreeBytes).toBe(100);
    expect(kept.sample.diskTotalBytes).toBe(400);
    expect(kept.errors).toEqual(["disk: EIO"]);
    const none = await sampleMachine(deps({ statfs: fail }));
    expect(none.sample.diskFreeBytes).toBeNull();
    expect(none.sample.diskTotalBytes).toBeNull();
  });

  it("cpus() throwing keeps the previous CPU reading and snapshot", async () => {
    const prevCpus = [cpu(1, 1, 1)];
    const r = await sampleMachine(
      deps({
        prev: sample(),
        prevCpus,
        cpus: () => {
          throw new Error("no cpus");
        },
      }),
    );
    expect(r.sample.cpuPct).toBe(12);
    expect(r.cpus).toBe(prevCpus);
    expect(r.errors).toEqual(["cpu: no cpus"]);
  });
});
