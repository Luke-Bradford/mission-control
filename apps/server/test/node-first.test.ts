import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_SHELL } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFirstPath, zprofileNodeFirst } from "../src/runtime/node-first.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("nodeFirstPath", () => {
  it("puts the folder of the given node ahead of every other folder", () => {
    expect(nodeFirstPath("/hub/bin/node", "/opt/homebrew/bin:/usr/bin")).toBe(
      "/hub/bin:/opt/homebrew/bin:/usr/bin",
    );
  });

  it("moves the folder up rather than listing it twice", () => {
    expect(nodeFirstPath("/hub/bin/node", "/opt/homebrew/bin:/hub/bin:/usr/bin")).toBe(
      "/hub/bin:/opt/homebrew/bin:/usr/bin",
    );
  });

  it("works from an empty PATH", () => {
    expect(nodeFirstPath("/hub/bin/node", "")).toBe("/hub/bin");
  });
});

describe("a Claude seat's command", () => {
  it("resolves node to the hub's folder when another node comes first on the inherited PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "mc-node-first-"));
    made.push(root);
    const other = join(root, "other");
    mkdirSync(other);
    const fake = join(other, "node");
    writeFileSync(fake, "#!/bin/sh\necho fake\n");
    chmodSync(fake, 0o755);
    // the PATH a Claude seat's env carries, as crewEnv builds it, run by a plain shell
    const out = execFileSync("/bin/sh", ["-c", "command -v node"], {
      env: { PATH: nodeFirstPath(process.execPath, `${other}:/usr/bin:/bin`) },
      encoding: "utf8",
    }).trim();
    expect(dirname(out)).toBe(dirname(process.execPath));
  });
});

describe("a login zsh with the seat's ZDOTDIR", () => {
  it.skipIf(!existsSync(CODEX_SHELL))(
    "resolves node to the hub's folder even after /etc/zprofile reorders PATH",
    () => {
      const root = mkdtempSync(join(tmpdir(), "mc-node-first-"));
      made.push(root);
      const other = join(root, "other");
      mkdirSync(other);
      const fake = join(other, "node");
      writeFileSync(fake, "#!/bin/sh\necho fake\n");
      chmodSync(fake, 0o755);
      const zdotdir = join(root, "zsh");
      mkdirSync(zdotdir);
      writeFileSync(join(zdotdir, ".zprofile"), zprofileNodeFirst(process.execPath));
      // a zshenv standing in for a login shell that puts another node first
      writeFileSync(join(zdotdir, ".zshenv"), `export PATH=${JSON.stringify(other)}:$PATH\n`);
      const out = execFileSync(CODEX_SHELL, ["-lc", "command -v node"], {
        env: { PATH: "/usr/bin:/bin", ZDOTDIR: zdotdir, HOME: root },
        encoding: "utf8",
      }).trim();
      expect(dirname(out)).toBe(dirname(process.execPath));
    },
  );
});
