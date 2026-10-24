import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it.each(["codex-cli 0.153.9", "unreadable", ""])("refuses %j", async (output) => {
    await expect(
      probeCodexVersion(executable(`console.log(${JSON.stringify(output)});`)),
    ).rejects.toThrow(`Codex requires ${CODEX_MIN_VERSION} or newer`);
  });

  it("bounds an unresponsive version command", async () => {
    await expect(probeCodexVersion(executable("setInterval(() => {}, 1000);"))).rejects.toThrow(
      `Codex requires ${CODEX_MIN_VERSION} or newer`,
    );
  });

  it("refuses a missing executable", async () => {
    await expect(probeCodexVersion(join(dir, "missing"))).rejects.toThrow(
      `Codex requires ${CODEX_MIN_VERSION} or newer`,
    );
  });
});
