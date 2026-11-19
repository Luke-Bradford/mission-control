import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_KEPT,
  failureReason,
  restartFileService,
} from "../src/telemetry/file-service-restart.ts";

/** An error shaped as `execFile` rejects: the command line in the message, the reason on stderr. */
const execError = (file: string, stderr: string) =>
  Object.assign(new Error(`Command failed: ${file} -x\n${stderr}`), { stderr, killed: false });

describe("restartFileService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fsev-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fake = (fail: Readonly<Record<string, string>>) => {
    const calls: string[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args].join(" "));
      const stderr = fail[file];
      if (stderr !== undefined) throw execError(file, stderr);
      return { stdout: `${file} output` };
    };
    return { calls, exec };
  };

  it("saves what was running in a private file, then restarts through sudo", async () => {
    const { calls, exec } = fake({});
    const out = join(dir, "diagnostics");
    const r = await restartFileService(out, 0, { diagnose: true }, exec);
    expect(r.restarted).toBe(true);
    expect(calls.at(-1)).toBe("/usr/bin/sudo -n /usr/bin/killall fseventsd");
    expect(calls.find((c) => c.startsWith("/usr/bin/log"))).toContain('process == "fseventsd"');
    const saved = await readFile(r.diagnostics ?? "", "utf8");
    expect(saved).toContain("/bin/ps output");
    expect(saved).toContain("/usr/bin/log output");
    expect((await stat(r.diagnostics ?? "")).mode & 0o777).toBe(0o600);
    expect((await stat(out)).mode & 0o777).toBe(0o700);
  });

  it("says in plain words why sudo could not restart it", async () => {
    const { exec } = fake({
      "/usr/bin/sudo": "sudo: a password is required\n",
      "/bin/ps": "ps: no such thing\n",
    });
    const r = await restartFileService(dir, 1, { diagnose: true }, exec);
    expect(r).toMatchObject({ restarted: false, error: "a password is required" });
    expect(await readFile(r.diagnostics ?? "", "utf8")).toContain("(failed: ps: no such thing)");
  });

  it("names a killed command as timed out", () => {
    const killed = Object.assign(new Error("Command failed: /usr/bin/sudo -n"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "",
    });
    expect(failureReason(killed)).toBe("it timed out");
  });

  it("saves nothing when the caller says not to", async () => {
    const { calls, exec } = fake({ "/usr/bin/sudo": "sudo: a password is required\n" });
    const r = await restartFileService(dir, 0, { diagnose: false }, exec);
    expect(r).toEqual({ restarted: false, error: "a password is required" });
    expect(calls).toEqual(["/usr/bin/sudo -n /usr/bin/killall fseventsd"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps only the latest diagnostics files, and still restarts when saving fails", async () => {
    const { exec } = fake({});
    for (let i = 0; i < DIAGNOSTICS_KEPT + 3; i++)
      await restartFileService(dir, i * 1000, { diagnose: true }, exec);
    const kept = (await readdir(dir)).filter((f) => f.startsWith("fseventsd-")).sort();
    expect(kept).toHaveLength(DIAGNOSTICS_KEPT);
    expect(kept[0]).toContain("1970-01-01T00-00-03");

    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    const r = await restartFileService(blocked, 0, { diagnose: true }, exec);
    expect(r).toEqual({ restarted: true, diagnostics: null });
  });
});
