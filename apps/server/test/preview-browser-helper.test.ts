import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { previewBrowserInHelper, previewRequest } from "../src/preview-browser.ts";

const HELPER = fileURLToPath(new URL("./fixtures/preview-stand-in-helper.mjs", import.meta.url));
const ORIGIN = "http://127.0.0.1:7431";
const guard = previewRequest(ORIGIN);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function run(mode: string, over: { deadlineMs?: number; graceMs?: number } = {}) {
  const pidfile = join(mkdtempSync(join(tmpdir(), "preview-helper-")), "pid");
  const result = previewBrowserInHelper(
    {
      path: `/needs-you?mode=${mode}&pidfile=${pidfile}`,
      width: 1280,
      theme: "dark",
      steps: [{ screenshot: "wide" }],
    },
    guard,
    { helperPath: HELPER, deadlineMs: 5_000, graceMs: 1_000, ...over },
  );
  const grandchild = async (): Promise<number> => {
    await expect.poll(() => readFileSync(pidfile, "utf8"), { timeout: 3000 }).toMatch(/^\d+$/);
    return Number(readFileSync(pidfile, "utf8"));
  };
  return { result, grandchild };
}

describe("previewBrowserInHelper", () => {
  it("returns the helper's report and screenshots, and kills everything the helper started", async () => {
    const { result, grandchild } = await run("ok");
    const r = await result;
    expect(r.report).toEqual(["step 1: screenshot wide"]);
    expect(r.shots).toEqual([{ label: "wide", png: Buffer.from("png") }]);
    await expect.poll(async () => alive(await grandchild())).toBe(false);
  });

  it("reports the helper's error, and cleans up", async () => {
    const { result, grandchild } = await run("fail");
    await expect(result).rejects.toThrow("browser exploded");
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

  it("refuses a path off the preview before it starts a process", () => {
    expect(() =>
      previewBrowserInHelper(
        { path: "http://evil.example/", width: 1280, theme: "dark", steps: [] },
        guard,
        { helperPath: "/nonexistent/helper.mjs" },
      ),
    ).toThrow("path on the preview");
  });
});
