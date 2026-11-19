import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGNOSTICS_KEPT, restartFileService } from "../src/telemetry/file-service-restart.ts";

describe("restartFileService", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fsev-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fake = (fail: readonly string[]) => {
    const calls: string[] = [];
    const exec = async (file: string, args: readonly string[]) => {
      calls.push([file, ...args].join(" "));
      if (fail.includes(file)) throw new Error(`Command failed\n${file} refused`);
      return { stdout: `${file} output` };
    };
    return { calls, exec };
  };

  it("saves what was running in a private file, then restarts through sudo when the rule allows it", async () => {
    const { calls, exec } = fake([]);
    const out = join(dir, "diagnostics");
    const r = await restartFileService(out, 0, { prompt: true }, exec);
    expect(r).toMatchObject({ how: "sudo" });
    expect(calls.at(-1)).toBe("/usr/bin/sudo -n /usr/bin/killall fseventsd");
    expect(calls.some((c) => c.startsWith("/usr/bin/osascript"))).toBe(false);
    expect(calls.find((c) => c.startsWith("/usr/bin/log"))).toContain('process == "fseventsd"');
    const saved = await readFile(r.diagnostics ?? "", "utf8");
    expect(saved).toContain("/bin/ps output");
    expect(saved).toContain("/usr/bin/log output");
    expect((await stat(r.diagnostics ?? "")).mode & 0o777).toBe(0o600);
    expect((await stat(out)).mode & 0o777).toBe(0o700);
  });

  it("falls back to the administrator prompt, and reports why it was not restarted", async () => {
    const prompted = fake(["/usr/bin/sudo"]);
    expect((await restartFileService(dir, 0, { prompt: true }, prompted.exec)).how).toBe("prompt");
    expect(prompted.calls.at(-1)).toContain("with administrator privileges");

    const declined = fake(["/usr/bin/sudo", "/usr/bin/osascript", "/bin/ps"]);
    const r = await restartFileService(dir, 1, { prompt: true }, declined.exec);
    expect(r).toMatchObject({
      how: "not restarted",
      error: "sudo: /usr/bin/sudo refused; prompt: /usr/bin/osascript refused",
    });
    expect(await readFile(r.diagnostics ?? "", "utf8")).toContain("(failed: /bin/ps refused)");
  });

  it("does not show the prompt when the caller says not to", async () => {
    const { calls, exec } = fake(["/usr/bin/sudo"]);
    const r = await restartFileService(dir, 0, { prompt: false }, exec);
    expect(r.how).toBe("not restarted");
    expect(r.error).toContain("prompt was shown less than 12 hours ago");
    expect(calls.some((c) => c.startsWith("/usr/bin/osascript"))).toBe(false);
  });

  it("keeps only the latest diagnostics files, and still restarts when saving fails", async () => {
    const { exec } = fake([]);
    for (let i = 0; i < DIAGNOSTICS_KEPT + 3; i++)
      await restartFileService(dir, i * 1000, { prompt: false }, exec);
    const kept = (await readdir(dir)).filter((f) => f.startsWith("fseventsd-")).sort();
    expect(kept).toHaveLength(DIAGNOSTICS_KEPT);
    expect(kept[0]).toContain("1970-01-01T00-00-03");

    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    const r = await restartFileService(blocked, 0, { prompt: false }, exec);
    expect(r).toEqual({ how: "sudo", diagnostics: null });
  });
});
