import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { type CpuInfo, cpus, freemem, totalmem } from "node:os";
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
  statfs: (p: string) => Promise<{ bavail: number; blocks: number; bsize: number }>;
  ps: () => Promise<string>;
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
export function realMachineDeps(): Omit<MachineDeps, "prevCpus" | "prev" | "now"> {
  const run = async (cmd: string, args: string[]) =>
    (await execFileP(cmd, args, { timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" })).stdout;
  return {
    cpus,
    totalmem,
    freemem,
    vmStat: () => run("vm_stat", []),
    statfs: async (p) => {
      const s = await statfs(p);
      return { bavail: Number(s.bavail), blocks: Number(s.blocks), bsize: Number(s.bsize) };
    },
    ps: () => run("ps", ["-axo", "pid=,rss=,%cpu=,comm="]),
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

  let agents = prev?.agents ?? null;
  try {
    agents = parsePs(await deps.ps());
  } catch (e) {
    errors.push(`ps: ${msg(e)}`);
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
      agents,
    },
    cpus: cur,
    errors,
  };
}
