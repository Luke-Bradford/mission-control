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
  const both = { prompt: true, diagnose: true };

  it("saves what was running in a private file, then restarts through sudo when the rule allows it", async () => {
    const { calls, exec } = fake({});
    const out = join(dir, "diagnostics");
    const r = await restartFileService(out, 0, both, exec);
    expect(r).toMatchObject({ how: "sudo", prompted: false });
    expect(calls.at(-1)).toBe("/usr/bin/sudo -n /usr/bin/killall fseventsd");
    expect(calls.some((c) => c.startsWith("/usr/bin/osascript"))).toBe(false);
    expect(calls.find((c) => c.startsWith("/usr/bin/log"))).toContain('process == "fseventsd"');
    const saved = await readFile(r.diagnostics ?? "", "utf8");
    expect(saved).toContain("/bin/ps output");
    expect(saved).toContain("/usr/bin/log output");
    expect((await stat(r.diagnostics ?? "")).mode & 0o777).toBe(0o600);
    expect((await stat(out)).mode & 0o777).toBe(0o700);
  });

  it("falls back to the administrator prompt, and says in plain words why it was not restarted", async () => {
    const prompted = fake({ "/usr/bin/sudo": "sudo: a password is required\n" });
    expect(await restartFileService(dir, 0, both, prompted.exec)).toMatchObject({
      how: "prompt",
      prompted: true,
    });
    expect(prompted.calls.at(-1)).toContain("with administrator privileges");

    const declined = fake({
      "/usr/bin/sudo": "sudo: a password is required\n",
      "/usr/bin/osascript": "0:93: execution error: User canceled. (-128)\n",
      "/bin/ps": "ps: no such thing\n",
    });
    const r = await restartFileService(dir, 1, both, declined.exec);
    expect(r).toMatchObject({
      how: "not restarted",
      prompted: true,
      error: "sudo: a password is required; prompt: 0:93: execution error: User canceled. (-128)",
    });
    expect(await readFile(r.diagnostics ?? "", "utf8")).toContain("(failed: ps: no such thing)");
  });

  it("names a timed-out prompt as unanswered", () => {
    const killed = Object.assign(
      new Error("Command failed: /usr/bin/osascript -e do shell script"),
      {
        killed: true,
        signal: "SIGTERM",
        stderr: "",
      },
    );
    expect(failureReason(killed, 5 * 60_000)).toBe("no answer within 5 minutes");
  });

  it("shows no prompt and saves nothing when the caller says not to", async () => {
    const { calls, exec } = fake({ "/usr/bin/sudo": "sudo: a password is required\n" });
    const r = await restartFileService(dir, 0, { prompt: false, diagnose: false }, exec);
    expect(r).toEqual({
      how: "not restarted",
      error: "sudo: a password is required",
      prompted: false,
    });
    expect(calls).toEqual(["/usr/bin/sudo -n /usr/bin/killall fseventsd"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps only the latest diagnostics files, and still restarts when saving fails", async () => {
    const { exec } = fake({});
    for (let i = 0; i < DIAGNOSTICS_KEPT + 3; i++)
      await restartFileService(dir, i * 1000, { prompt: false, diagnose: true }, exec);
    const kept = (await readdir(dir)).filter((f) => f.startsWith("fseventsd-")).sort();
    expect(kept).toHaveLength(DIAGNOSTICS_KEPT);
    expect(kept[0]).toContain("1970-01-01T00-00-03");

    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    const r = await restartFileService(blocked, 0, { prompt: false, diagnose: true }, exec);
    expect(r).toEqual({ how: "sudo", prompted: false, diagnostics: null });
  });
});
