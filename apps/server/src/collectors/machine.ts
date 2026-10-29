import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { type CpuInfo, cpus, freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { MachineSample } from "@mc/core";

const execFileP = promisify(execFile);
const COMMAND_TIMEOUT_MS = 2000;
/** Command basenames counted as Claude/Codex processes. */
const AGENT_COMMANDS: ReadonlySet<string> = new Set(["claude", "codex"]);

export interface MachineDeps {
  cpus: () => CpuInfo[];
  totalmem: () => number;
  freemem: () => number;
  vmStat: () => Promise<string>;
  swapUsage: () => Promise<string>;
  memoryPressure: () => Promise<string>;
  loadavg: () => number[];
  statfs: (p: string) => Promise<{ bavail: number; blocks: number; bsize: number }>;
  ps: () => Promise<string>;
  /** `ps -axww -o pid=,ppid=,rss=,%cpu=,args=`: the whole process table, for the test run's tree. */
  psTree: () => Promise<string>;
  /** The test-lock holder's command; null when the lock is free. */
  testCommand: string | null;
  prevCpus: CpuInfo[] | null;
  prev: MachineSample | null;
  now: number;
}

export interface MachineResult {
  sample: MachineSample;
  cpus: CpuInfo[];
  errors: string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The real dependencies: no shell, 2 s timeout on each command. */
export function realMachineDeps(): Omit<MachineDeps, "prevCpus" | "prev" | "now" | "testCommand"> {
  const run = async (cmd: string, args: string[], maxBuffer?: number) =>
    (await execFileP(cmd, args, { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8", maxBuffer }))
      .stdout;
  return {
    cpus,
    totalmem,
    freemem,
    vmStat: () => run("vm_stat", []),
    swapUsage: () => run("sysctl", ["vm.swapusage"]),
    memoryPressure: () => run("memory_pressure", []),
    loadavg,
    statfs: async (p) => {
      const s = await statfs(p);
      return { bavail: Number(s.bavail), blocks: Number(s.blocks), bsize: Number(s.bsize) };
    },
    ps: () => run("ps", ["-axo", "pid=,rss=,%cpu=,comm="]),
    // full command lines can pass the default 1 MB buffer on a busy machine
    psTree: () => run("ps", ["-axww", "-o", "pid=,ppid=,rss=,%cpu=,args="], 8 * 1024 * 1024),
  };
}

const ticks = (list: CpuInfo[]): { busy: number; total: number } => {
  let busy = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
};

/** Busy share of the tick delta between two snapshots across all cores; null if no time passed. */
export function cpuPercent(prev: CpuInfo[], cur: CpuInfo[]): number | null {
  const a = ticks(prev);
  const b = ticks(cur);
  const total = b.total - a.total;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, ((b.busy - a.busy) / total) * 100));
}

/** Used bytes = total − (free + inactive + speculative) pages × page size; null if unparseable. */
export function parseVmStat(text: string, totalBytes: number): number | null {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  const pages = (label: string): number | null => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const free = pages("free");
  const inactive = pages("inactive");
  const speculative = pages("speculative");
  if (!size || free === null || inactive === null || speculative === null) return null;
  const available = (free + inactive + speculative) * Number(size);
  return Math.max(0, totalBytes - available);
}

/** Parses `sysctl vm.swapusage`'s total and used figures (K, M, G or T units). */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } | null {
  const bytes = (value: string, unit: string): number =>
    Number(value) * 1024 ** ({ K: 1, M: 2, G: 3, T: 4 }[unit.toUpperCase() as "K"] ?? 0);
  const total = /\btotal\s*=\s*([\d.]+)\s*([KMGT])/i.exec(text);
  const used = /\bused\s*=\s*([\d.]+)\s*([KMGT])/i.exec(text);
  if (!total || !used) return null;
  return {
    totalBytes: bytes(total[1] as string, total[2] as string),
    usedBytes: bytes(used[1] as string, used[2] as string),
  };
}

/** Parses `memory_pressure`'s system-wide free percentage. */
export function parseMemoryPressure(text: string): number | null {
  const value = /System-wide memory free percentage:\s*([\d.]+)%/i.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/** The claude/codex rows of `ps -axo pid=,rss=,%cpu=,comm=`; RSS is KiB, the command may hold spaces. */
export function parsePs(text: string): { count: number; rssBytes: number; cpuPct: number } {
  let count = 0;
  let rssKib = 0;
  let cpuPct = 0;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const command = m[4] as string;
    const base = command.slice(command.lastIndexOf("/") + 1);
    if (!AGENT_COMMANDS.has(base)) continue;
    count += 1;
    rssKib += Number(m[2]);
    cpuPct += Number(m[3]);
  }
  return { count, rssBytes: rssKib * 1024, cpuPct: Math.round(cpuPct * 10) / 10 };
}

export interface PsProc {
  pid: number;
  ppid: number;
  rssKib: number;
  cpuPct: number;
  args: string;
}

/** The rows of `ps -axww -o pid=,ppid=,rss=,%cpu=,args=`; `args` keeps its spaces. */
export function parsePsTree(text: string): PsProc[] {
  const procs: PsProc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKib: Number(m[3]),
      cpuPct: Number(m[4]),
      args: m[5] as string,
    });
  }
  return procs;
}

const squash = (s: string): string => s.replace(/\s+/g, " ");

/**
 * The processes running `command` (args include it followed by whitespace or their end, agents
 * excluded) and everything under them. RSS is KiB in, bytes out.
 */
export function testRunUse(
  procs: PsProc[],
  command: string,
): { count: number; rssBytes: number; cpuPct: number } {
  const wanted = squash(command);
  const inTree = new Map<number, PsProc>();
  const queue = procs.filter((p) => {
    const args = squash(p.args);
    const first = args.split(" ")[0] as string;
    return (
      ` ${args} `.replace(/["'/]/g, " ").includes(` ${wanted} `) &&
      !AGENT_COMMANDS.has(first.slice(first.lastIndexOf("/") + 1))
    );
  });
  while (queue.length > 0) {
    const p = queue.shift() as PsProc;
    if (inTree.has(p.pid)) continue;
    inTree.set(p.pid, p);
    for (const child of procs) if (child.ppid === p.pid) queue.push(child);
  }
  let rssKib = 0;
  let cpuPct = 0;
  for (const p of inTree.values()) {
    rssKib += p.rssKib;
    cpuPct += p.cpuPct;
  }
  return { count: inTree.size, rssBytes: rssKib * 1024, cpuPct: Math.round(cpuPct * 10) / 10 };
}

/**
 * One machine reading. A part that fails keeps its value from `prev` (null if none) and adds a line
 * to `errors`; the first sample has no CPU delta, so its `cpuPct` is null.
 */
export async function sampleMachine(deps: MachineDeps): Promise<MachineResult> {
  const errors: string[] = [];
  const prev = deps.prev;

  let cur: CpuInfo[] = deps.prevCpus ?? [];
  let cpuPct: number | null = prev?.cpuPct ?? null;
  let cores = prev?.cores ?? 0;
  try {
    cur = deps.cpus();
    cores = cur.length;
    cpuPct = deps.prevCpus ? (cpuPercent(deps.prevCpus, cur) ?? cpuPct) : null;
  } catch (e) {
    errors.push(`cpu: ${msg(e)}`);
  }

  const memTotalBytes = deps.totalmem();
  let memUsedBytes: number | null;
  try {
    memUsedBytes = parseVmStat(await deps.vmStat(), memTotalBytes);
    if (memUsedBytes === null) throw new Error("unrecognised vm_stat output");
  } catch (e) {
    errors.push(`vm_stat: ${msg(e)}`);
    memUsedBytes = Math.max(0, memTotalBytes - deps.freemem());
  }

  let diskFreeBytes = prev?.diskFreeBytes ?? null;
  let diskTotalBytes = prev?.diskTotalBytes ?? null;
  try {
    const s = await deps.statfs("/");
    diskFreeBytes = s.bavail * s.bsize;
    diskTotalBytes = s.blocks * s.bsize;
  } catch (e) {
    errors.push(`disk: ${msg(e)}`);
  }

  let swapUsedBytes = prev?.swapUsedBytes ?? null;
  let swapTotalBytes = prev?.swapTotalBytes ?? null;
  try {
    const swap = parseSwapUsage(await deps.swapUsage());
    if (swap === null) throw new Error("unrecognised vm.swapusage output");
    swapUsedBytes = swap.usedBytes;
    swapTotalBytes = swap.totalBytes;
  } catch (e) {
    errors.push(`swap: ${msg(e)}`);
  }

  let memoryPressureFreePct = prev?.memoryPressureFreePct ?? null;
  try {
    memoryPressureFreePct = parseMemoryPressure(await deps.memoryPressure());
    if (memoryPressureFreePct === null) throw new Error("unrecognised memory_pressure output");
  } catch (e) {
    errors.push(`memory_pressure: ${msg(e)}`);
  }

  let load1 = prev?.load1 ?? null;
  try {
    load1 = deps.loadavg()[0] ?? null;
  } catch (e) {
    errors.push(`load: ${msg(e)}`);
  }

  let agents = prev?.agents ?? null;
  try {
    agents = parsePs(await deps.ps());
  } catch (e) {
    errors.push(`ps: ${msg(e)}`);
  }

  let testRun: MachineSample["testRun"] = null;
  if (deps.testCommand !== null) {
    try {
      testRun = testRunUse(parsePsTree(await deps.psTree()), deps.testCommand);
    } catch (e) {
      errors.push(`ps tree: ${msg(e)}`);
      testRun = deps.prev?.testRun ?? null;
    }
  }

  return {
    sample: {
      at: deps.now,
      cpuPct,
      cores,
      memUsedBytes,
      memTotalBytes,
      diskFreeBytes,
      diskTotalBytes,
      swapUsedBytes,
      swapTotalBytes,
      memoryPressureFreePct,
      load1,
      agents,
      testRun,
    },
    cpus: cur,
    errors,
  };
}
