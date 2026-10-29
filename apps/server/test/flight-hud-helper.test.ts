import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hudRenderRequest, renderHudInHelper } from "../src/flight/hud-render.ts";

const HELPER = fileURLToPath(new URL("./fixtures/hud-stand-in-helper.mjs", import.meta.url));
const guard = hudRenderRequest("http://127.0.0.1:7420");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function run(mode: string, over: { deadlineMs?: number; graceMs?: number } = {}) {
  const pidfile = join(mkdtempSync(join(tmpdir(), "hud-helper-")), "pid");
  const result = renderHudInHelper(
    `http://127.0.0.1:7420/map?mode=${mode}&pidfile=${pidfile}`,
    guard,
    {
      helperPath: HELPER,
      deadlineMs: 5_000,
      graceMs: 1_000,
      ...over,
    },
  );
  const grandchild = async (): Promise<number> => {
    await expect.poll(() => readFileSync(pidfile, "utf8"), { timeout: 3000 }).toMatch(/^\d+$/);
    return Number(readFileSync(pidfile, "utf8"));
  };
  return { result, grandchild };
}

describe("renderHudInHelper", () => {
  it("returns the helper's PNG and kills everything the helper started", async () => {
    const { result, grandchild } = await run("ok");
    expect(await result).toEqual(Buffer.from("png"));
    const pid = await grandchild();
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("reports the helper's error, and cleans up", async () => {
    const { result, grandchild } = await run("fail");
    await expect(result).rejects.toThrow("render exploded");
    await expect.poll(async () => alive(await grandchild())).toBe(false);
  });

  it("reports a crashed helper", async () => {
    const { result } = await run("crash");
    await expect(result).rejects.toThrow("exited");
  });

  it("kills a hung helper's whole process group at the deadline: no orphan survives", async () => {
    const { result, grandchild } = await run("hang", { deadlineMs: 300, graceMs: 100 });
    await expect(result).rejects.toThrow("timed out");
    const pid = await grandchild();
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("gives the helper no hub secrets in its environment", async () => {
    process.env.MC_TEST_SECRET = "s3cret";
    try {
      const { result } = await run("env");
      expect((await result).toString()).toBe("undefined");
    } finally {
      delete process.env.MC_TEST_SECRET;
    }
  });
});
