import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SEAT_COMMANDS } from "@mc/core";
import { expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { crewGuardDecision } from "../src/guard/decision.ts";
import { codexCommandAllowed } from "../src/runtime/codex-floor.ts";

it("confines each Claude git segment to the seat worktree in every mode", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-git-paths-")));
  const root = join(dir, "tree");
  mkdirSync(join(root, "apps"), { recursive: true });
  symlinkSync(dir, join(root, "escape"));
  try {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const command of [
        "cd /tmp && git diff a b",
        "pushd /tmp; git diff a b",
        "popd; git diff a b",
        "cd apps; cd ../../; git diff a b",
        "env -C /tmp git diff a b",
        "env --chdir=/tmp git diff a b",
        "env -C/tmp git diff a b",
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
        "cd apps && git diff file",
        "env -C apps git diff file",
        "env --chdir=apps git diff file",
        "git -C apps log --oneline -3",
        "git -Capps diff file",
        "git diff HEAD",
        "git diff HEAD~1..HEAD",
        "git diff abcdef123",
        "git show HEAD:package.json",
        "git diff -- apps/missing",
        "git diff | head",
        "git status --short",
        "git diff --stat",
        "git log --oneline -5",
        "git log main",
        "git log -- apps/server",
        "git log --format='%h %s' -3",
        "git status | wc -l",
        "git log | grep fix",
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

it.each([
  'name=GIT_CONFIG_GLOBAL; unset -m "$name"; git diff',
  'unset "$name"; git diff',
  'export "$name"; git diff',
  'declare "$name"; git diff',
  'typeset "$name"; git diff',
  'readonly "$name"; git diff',
  'local "$name"; git diff',
  'set -a "$name"; git diff',
  "local GIT_CONFIG_COUNT=0; git diff",
  "env -C /tmp -S 'git diff a b'",
  "env -C /tmp sh -c 'git diff a b'",
  "env -S 'git diff'",
  "sh -c 'git diff'",
  "bash -c 'git diff'",
  "zsh -c 'git diff'",
  "eval 'git diff'",
  "xargs git diff",
  "env -C /tmp sh <<'EOF'\ngit diff a b\nEOF",
  "sh <<< 'git diff'",
  "source /dev/stdin <<< 'git diff'",
  'cd "$HOME" && git diff a b',
  'pushd "$HOME"; git diff',
  "env -C ~ git diff a b",
  "env --chdir=$HOME git diff",
  'git diff "$HOME/a" "$HOME/b"',
  'git -C "$HOME" diff',
  "git -C ~ diff",
  "git diff ~/a ~/b",
  "git diff a* b",
  "git diff a? b",
  "git diff a[bc] b",
  "git diff 'a{b,c}' b",
  "cd apps*; git diff",
  "env -C apps? git diff",
  'git diff "`pwd`/a" b',
])("refuses uncertain git context: %s", (command) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-git-context-")));
  try {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      expect(codexCommandAllowed(command, mode, DEFAULT_SEAT_COMMANDS, root, root)).toBe(false);
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
      ).toMatchObject({ kind: "deny", rule: "git-env" });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
