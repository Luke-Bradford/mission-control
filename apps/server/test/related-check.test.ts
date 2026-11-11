import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { relatedBase } from "../../../scripts/check-related.ts";

it("rejects missing or unrelated default history and returns a verified immutable base", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-related-base-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
  };
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "file"), "one");
    commit();
    expect(() => relatedBase(dir)).toThrow();
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    writeFileSync(join(dir, "file"), "two");
    commit();
    expect(relatedBase(dir)).toBe(base);
    expect(relatedBase(dir)).not.toBe(git("rev-parse", "HEAD"));
    git("checkout", "--orphan", "unrelated");
    writeFileSync(join(dir, "file"), "unrelated");
    commit();
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
    git("checkout", "main");
    expect(() => relatedBase(dir)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([0, 3, "signal"] as const)(
  "preserves the check result and bounded success output for %s",
  (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "mc-related-output-test-"));
    const script = resolve("scripts/check-related.ts");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    try {
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
      );
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const shim = join(bin, "pnpm");
      const noise = "fixture log line\n".repeat(100_000);
      writeFileSync(
        shim,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(noise)});\nprocess.stderr.write("Test Files 1 passed (1)\\nTests 2 passed (2)\\n");\n${outcome === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.stderr.write("fixture failure name and full error\\n"); process.exit(${outcome});`}\n`,
      );
      chmodSync(shim, 0o700);
      const result = spawnSync(process.execPath, [script], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(outcome === "signal" ? 1 : outcome);
      if (outcome === 0) {
        expect(result.stdout.trim().split("\n")).toHaveLength(2);
        expect(result.stdout).toContain("Test Files 1 passed");
        expect(result.stdout).not.toContain("fixture log line");
        expect(result.stdout).not.toContain("fixture failure name");
      } else {
        expect(result.stdout.startsWith(noise)).toBe(true);
        if (outcome === "signal") expect(result.stderr).toContain("SIGTERM");
        else expect(result.stdout).toContain("fixture failure name and full error");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
