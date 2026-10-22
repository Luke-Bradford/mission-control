import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeVersion, parseCliVersion, probeClaudeVersion } from "../src/cli-version.ts";

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cli-version-"));
  savedPath = process.env.PATH;
  process.env.PATH = dir;
});

afterEach(() => {
  killFixture(join(dir, "pid"));
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

/** A stuck fixture exits on its own after this long, should nothing kill it. */
const STUCK_DEADLINE_S = 30;

/** A fake CLI that ignores SIGTERM, records its pid in `${dir}/pid` and loops until `deadlineS` has passed. */
function stuckCli(name: string, deadlineS = STUCK_DEADLINE_S): string {
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/sh\ntrap '' TERM\nPATH=/usr/bin:/bin\necho x >> "${dir}/runs-${name}"\necho $$ > "${dir}/pid"\nend=$(( $(date +%s) + ${deadlineS} ))\nwhile [ "$(date +%s)" -lt "$end" ]; do sleep 1; done\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** SIGKILLs the pid recorded in `pidFile`, if there is one and it still runs. */
function killFixture(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  // An empty or partly written file reads as 0, and kill(0) would signal our own process group.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** A fake CLI that prints `out` and appends a line to `runs` each time it runs. */
function fakeCli(name: string, out: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\necho x >> "${dir}/runs-${name}"\necho "${out}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const runs = (name: string): number =>
  readFileSync(join(dir, `runs-${name}`), "utf8").split("\n").length - 1;

describe("parseCliVersion", () => {
  it("takes the leading version, else null", () => {
    expect(parseCliVersion("2.1.302 (Claude Code)\n")).toBe("2.1.302");
    expect(parseCliVersion("claude 2.1.302")).toBeNull();
    expect(parseCliVersion("")).toBeNull();
  });
});

describe("claudeVersion", () => {
  it("answers at once without waiting for the probe, then from the cache", async () => {
    const bin = fakeCli("claude-a", "2.1.302 (Claude Code)");
    // a call on the request path never blocks: the first answer is null while the probe runs
    expect(claudeVersion("claude-a")).toBeNull();
    expect(claudeVersion("claude-a")).toBeNull();
    await probeClaudeVersion("claude-a");
    expect(claudeVersion("claude-a")).toBe("2.1.302");
    expect(claudeVersion("claude-a")).toBe("2.1.302");
    expect(runs("claude-a")).toBe(1);
    // an upgraded binary (new mtime) is read again
    writeFileSync(bin, `#!/bin/sh\necho x >> "${dir}/runs-claude-a"\necho "2.2.0 (Claude Code)"\n`);
    utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    expect(claudeVersion("claude-a")).toBeNull();
    await probeClaudeVersion("claude-a");
    expect(claudeVersion("claude-a")).toBe("2.2.0");
    expect(runs("claude-a")).toBe(2);
  });

  it("is null when the binary prints no version, and does not rerun it", async () => {
    fakeCli("claude-b", "not a version");
    await probeClaudeVersion("claude-b");
    expect(claudeVersion("claude-b")).toBeNull();
    expect(claudeVersion("claude-b")).toBeNull();
    expect(runs("claude-b")).toBe(1);
  });

  it("does not re-walk PATH for a binary that is not there", async () => {
    expect(claudeVersion("claude-late")).toBeNull();
    // had PATH been walked again, this binary would be found
    fakeCli("claude-late", "2.1.302 (Claude Code)");
    expect(claudeVersion("claude-late")).toBeNull();
    expect(await probeClaudeVersion("claude-late")).toBeNull();
  });

  it("finds a binary on a changed PATH at once, though it was missing on the old one", async () => {
    expect(claudeVersion("claude-moved")).toBeNull();
    const other = mkdtempSync(join(tmpdir(), "mc-cli-version-other-"));
    try {
      const bin = join(other, "claude-moved");
      writeFileSync(bin, `#!/bin/sh\necho "2.1.302 (Claude Code)"\n`);
      chmodSync(bin, 0o755);
      process.env.PATH = other;
      expect(await probeClaudeVersion("claude-moved")).toBe("2.1.302");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("starts the probe itself, so a later call has the version", async () => {
    fakeCli("claude-c", "2.1.302 (Claude Code)");
    expect(claudeVersion("claude-c")).toBeNull();
    // only claudeVersion was called: nothing but its own probe can fill the cache
    for (let i = 0; i < 100 && claudeVersion("claude-c") === null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(claudeVersion("claude-c")).toBe("2.1.302");
    expect(runs("claude-c")).toBe(1);
  });

  it("does not rerun a binary that exits non-zero, until the failure has aged out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const bin = join(dir, "claude-d");
      writeFileSync(bin, `#!/bin/sh\necho x >> "${dir}/runs-claude-d"\nexit 3\n`);
      chmodSync(bin, 0o755);
      expect(await probeClaudeVersion("claude-d")).toBeNull();
      expect(await probeClaudeVersion("claude-d")).toBeNull();
      expect(claudeVersion("claude-d")).toBeNull();
      expect(runs("claude-d")).toBe(1);
      vi.advanceTimersByTime(59_000);
      expect(await probeClaudeVersion("claude-d")).toBeNull();
      expect(runs("claude-d")).toBe(1);
      vi.advanceTimersByTime(2_000);
      expect(await probeClaudeVersion("claude-d")).toBeNull();
      expect(runs("claude-d")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a binary that ignores SIGTERM, and does not respawn it after the timeout", async () => {
    stuckCli("claude-stuck");
    expect(await probeClaudeVersion("claude-stuck", 300)).toBeNull();
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await probeClaudeVersion("claude-stuck", 300)).toBeNull();
    expect(claudeVersion("claude-stuck")).toBeNull();
    expect(runs("claude-stuck")).toBe(1);
  });
});

describe("the stuck fixture", () => {
  it("has a 30 s deadline by default", () => {
    const text = readFileSync(stuckCli("claude-stuck-text"), "utf8");
    expect(text).toContain("end=$(( $(date +%s) + 30 ))");
    expect(text).toContain('while [ "$(date +%s)" -lt "$end" ]');
  });

  it("exits on its own once its deadline has passed", async () => {
    const child = spawn(stuckCli("claude-deadline", 1), [], { stdio: "ignore" });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) =>
      child.on("exit", (c, s) => r([c, s])),
    );
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 10_000);

  it("is killed by the cleanup while it still runs", async () => {
    const child = spawn(stuckCli("claude-live"), [], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on("exit", (_c, s) => r(s)));
    const pidFile = join(dir, "pid");
    for (
      let i = 0;
      i < 100 && !(existsSync(pidFile) && readFileSync(pidFile, "utf8") === `${child.pid}\n`);
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    killFixture(pidFile);
    expect(await exited).toBe("SIGKILL");
  });

  it("cleanup does nothing without a live pid", async () => {
    const pidFile = join(dir, "pid");
    expect(() => killFixture(pidFile)).not.toThrow();
    writeFileSync(pidFile, "");
    expect(() => killFixture(pidFile)).not.toThrow();
    const child = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    await new Promise((r) => child.on("exit", r));
    writeFileSync(pidFile, `${child.pid}\n`);
    expect(() => killFixture(pidFile)).not.toThrow();
  });
});
