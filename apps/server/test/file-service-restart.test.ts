import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restartFileService } from "../src/telemetry/file-service-restart.ts";

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
      if (fail.includes(file)) throw new Error(`${file} refused`);
      return { stdout: `${file} output` };
    };
    return { calls, exec };
  };

  it("saves what was running, then restarts through sudo when the rule allows it", async () => {
    const { calls, exec } = fake([]);
    const r = await restartFileService(join(dir, "diagnostics"), 0, exec);
    expect(r.how).toBe("sudo");
    expect(calls.at(-1)).toBe("/usr/bin/sudo -n /usr/bin/killall fseventsd");
    expect(calls.some((c) => c.startsWith("/usr/bin/osascript"))).toBe(false);
    const saved = await readFile(r.diagnostics ?? "", "utf8");
    expect(saved).toContain("/bin/ps output");
    expect(saved).toContain("/usr/bin/log output");
    expect((await stat(r.diagnostics ?? "")).mode & 0o777).toBe(0o600);
  });

  it("falls back to the administrator prompt, and reports a declined one without throwing", async () => {
    const prompted = fake(["/usr/bin/sudo"]);
    expect((await restartFileService(dir, 0, prompted.exec)).how).toBe("prompt");
    expect(prompted.calls.at(-1)).toContain("with administrator privileges");

    const declined = fake(["/usr/bin/sudo", "/usr/bin/osascript", "/bin/ps"]);
    const r = await restartFileService(dir, 1, declined.exec);
    expect(r.how).toBe("not restarted");
    expect(await readFile(r.diagnostics ?? "", "utf8")).toContain("(failed: /bin/ps refused)");
  });
});
