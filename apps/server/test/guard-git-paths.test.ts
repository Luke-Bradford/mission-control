import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { crewGuardDecision } from "../src/guard/decision.ts";

it("confines each Claude git segment to the seat worktree in every mode", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-git-paths-")));
  const root = join(dir, "tree");
  mkdirSync(join(root, "apps"), { recursive: true });
  symlinkSync(dir, join(root, "escape"));
  try {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const command of [
        "git -C .. log",
        "git -C../ log",
        "git -C escape log",
        "git diff /outside/a /outside/b",
        "git diff file ../outside",
        "git diff escape/missing file",
        "git diff -- escape/missing",
        "git -C apps diff ../../outside",
        "git -C .. log; git -C apps log",
        "git diff escape/../outside file",
      ]) {
        const verdict = crewGuardDecision(
          { repos: [] } as unknown as CcConfig,
          "dev",
          mode,
          { tool: "Bash", input: { command } },
          undefined,
          [],
          root,
        );
        expect(verdict, command).toMatchObject({ kind: "deny", rule: "git-env" });
      }
      for (const command of [
        "git -C apps log --oneline -3",
        "git -Capps diff file",
        "git diff HEAD",
        "git diff HEAD~1..HEAD",
        "git diff abcdef123",
        "git show HEAD:package.json",
        "git diff -- apps/missing",
        "git diff | head",
      ]) {
        expect(
          crewGuardDecision(
            { repos: [] } as unknown as CcConfig,
            "dev",
            mode,
            { tool: "Bash", input: { command } },
            undefined,
            [],
            root,
          ),
          command,
        ).toEqual({ kind: "allow" });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
