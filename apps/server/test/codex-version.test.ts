import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MIN_VERSION } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeCodexVersion } from "../src/runtime/codex-version.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-cv-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
function executable(script: string): string {
  const path = join(dir, "codex");
  writeFileSync(path, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  return path;
}

describe("Codex version probe", () => {
  it("leaves the event loop free while the CLI answers", async () => {
    let settled = false;
    const version = probeCodexVersion(
      executable(`setTimeout(() => console.log("codex-cli ${CODEX_MIN_VERSION}"), 150);`),
    ).then((value) => {
      settled = true;
      return value;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(await version).toBe(CODEX_MIN_VERSION);
  });

  it("refuses a version below the minimum, naming it, without a retry", async () => {
    const marker = join(dir, "runs");
    const script = `require("fs").appendFileSync(${JSON.stringify(marker)}, "x"); console.log("codex-cli 0.153.9");`;
    await expect(probeCodexVersion(executable(script))).rejects.toThrow(
      `Codex 0.153.9 is older than ${CODEX_MIN_VERSION}`,
    );
    expect(readFileSync(marker, "utf8")).toBe("x");
  });

  it.each(["unreadable", ""])("refuses unreadable output %j", async (output) => {
    await expect(
      probeCodexVersion(executable(`console.log(${JSON.stringify(output)});`)),
    ).rejects.toThrow("Codex version output was not readable");
  });

  it("retries a timeout with a longer one and returns the version", async () => {
    const marker = join(dir, "runs");
    const script = `const fs = require("fs");
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.writeFileSync(${JSON.stringify(marker)}, "x");
if (first) setInterval(() => {}, 1000);
else console.log("codex-cli ${CODEX_MIN_VERSION}");`;
    expect(await probeCodexVersion(executable(script), [300, 5000])).toBe(CODEX_MIN_VERSION);
  });

  it("says the check timed out when the retry times out too", async () => {
    await expect(
      probeCodexVersion(executable("setInterval(() => {}, 1000);"), [200, 300]),
    ).rejects.toThrow("Codex version check timed out");
  });

  it("says Codex could not be run, with the reason", async () => {
    await expect(probeCodexVersion(join(dir, "missing"))).rejects.toThrow(
      /Codex could not be run: .*ENOENT/,
    );
  });
});
