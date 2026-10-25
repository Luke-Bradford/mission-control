# Seat git hardening: design (#635)

Date: 2026-10-25. Applies to every crew seat, Claude and Codex alike. It follows on from #632, which was cut back to read parity.

## The gaps

A seat may run `git status`, `git diff`, `git log` and `git show`: `GIT_READ_TOOLS` in `packages/core/src/runtime.ts:218`, and the matching Codex read rules. The reviews of #632 found three ways those reads can do more than read.

1. **Helpers run during reads.** Git runs a helper program if config defines one:
   - `diff.external`;
   - `diff.<driver>.textconv` or `filter.<driver>.clean`/`process`, selected by `.gitattributes`;
   - `core.fsmonitor`.

   A seat inherits the operator's environment and `HOME`, so helpers in `~/.gitconfig`, the system config or the clone's config run inside the seat's sandbox on an ordinary `git diff`. The seat can write `.gitattributes`, so it can select any driver that config defines.
2. **The seat's git env can be overridden in the command line:** `GIT_CONFIG_GLOBAL=x git diff`, `env GIT_DIR=… git log`, `export GIT_CONFIG_COUNT=…; git diff`, `git -c diff.external=x diff`.
3. **`git diff --no-index A B` compares any two paths,** including paths outside the worktree. This is allowed today through `Bash(git diff:*)`.

The OS sandbox still applies, so a helper can't write outside the seat's write roots or reach the network, and the deny-read list still holds. The risk is code running that the seat didn't ask for, plus reads past the worktree that Read/Grep/Glob would refuse.

## Decisions

### 1. The seat env ignores the operator's git config (both vendors)

A new `CREW_GIT_ENV` goes in `packages/core/src/runtime.ts`, merged into `crewEnv` (`apps/server/src/runtime/supervisor.ts:1043`) and into the Codex seat env:

| Variable | Value | Effect |
|---|---|---|
| `GIT_CONFIG_NOSYSTEM` | `1` | no `/etc/gitconfig` |
| `GIT_CONFIG_GLOBAL` | `/dev/null` | no `~/.gitconfig` and its includes |
| `GIT_ATTR_NOSYSTEM` | `1` | no system attributes |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` | `1`, `core.fsmonitor` / `false` | no fsmonitor, even from repo config |
| `GIT_PAGER` | `cat` | no pager program |
| `GIT_EXTERNAL_DIFF` | removed from the env | no inherited external diff |

Don't override `diff.external` with an empty value: git then tries to run `""` ("cannot run :"), so plain `git diff` fails.

Seats lose the operator's global excludes file and aliases. No seat rule depends on either, and seats don't commit themselves (the hub's `mc commit` sets the identity), so they need no `user.*` either.

### 2. The clone defines no helpers (checked when a seat starts)

The clone's config is written only by the hub. Seats can't write `.git/**`: the sandbox's `denyWrite` covers `gitCommonDir` and the worktree git dir. Even so, the operator might have configured a driver there.

`prepareCheckout` (`apps/server/src/runtime/checkouts.ts`) runs this with `CREW_GIT_ENV`, so only local and worktree config is read:

`git config --includes --show-origin --get-regexp '^(diff\.external|core\.fsmonitor|(diff|filter|merge)\..+\.(textconv|command|clean|smudge|process|driver))$'`

If anything is set, the start is refused with `CANNOT_START` and the reason "the clone's git config defines helpers: <keys>; remove them to run seats here". The keys are logged, never the values.

### 3. The guard refuses env and git-option overrides, per segment (both vendors)

These go in the shared tokenizer in `packages/core/src/guard.ts`: the assignment handling at about line 923, and `WRAPPERS` at about 197. Each rule judges the segment that carries it, so one segment can never vouch for another. The new rule is `git-env`.

A segment is refused when it:
- assigns any `GIT_*` variable inline (`GIT_X=… cmd`);
- runs `env` with `-i`, `-u GIT_*`, `GIT_*=…` or a bare `-`;
- runs `git` with `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, or `-C <path>` where the path resolves outside the worktree;
- runs `git diff` (or `difftool`) with `--no-index` and any operand outside the worktree.

The whole line is refused when any segment runs `export`, `declare`, `typeset`, `readonly`, `unset` or `set -a` and names a `GIT_*` variable. Those builtins persist into later segments, so a per-segment check can't contain them.

### 4. What stays allowed (both vendors, every mode that has the git read tools)

Taken from the current guard and floor tests:
- `git status`, `git status --short`;
- `git diff`, `git diff --stat`, `git diff HEAD~1..HEAD`;
- `git log --oneline -5`, `git log --format='%h %s' -3`, `git log main`, `git log -- apps/server`;
- `git show HEAD:package.json`, `git show <sha>`;
- the same piped into `head`, `wc -l` or `grep`;
- `git -C apps/server log --oneline -3` (inside the worktree).

## Tests

- **Sentinel tests** (new `apps/server/test/seat-git.test.ts`, in a temp `HOME` with a temp repo):
  - a helper that writes a sentinel file, configured as `diff.external` in a temp global config, a temp system config (`GIT_CONFIG_SYSTEM`), and a textconv or clean filter selected by `.gitattributes`, never runs under `CREW_GIT_ENV` for `git diff`, `log -p`, `show` or `status`;
  - `git diff` still prints the diff.
- **Checkout assertion:** a clone with `diff.x.textconv` set refuses the start, giving the key names; a clean clone starts.
- **Guard table**, run for both vendors' paths:
  - every bypass form in §3 is refused with `git-env`;
  - every command in §4 is allowed for writer, read-only and scratch seats;
  - the existing Claude positive git tests stay unchanged.

## Residual risk

- **Seat-writable `.gitattributes`** can still select git's built-in drivers, such as `diff=cpp`. Those run no programs.
- **A tool other than git** that reads `GIT_*` config is unaffected. No seat command does today.
- **Claude Code runs git itself** for its own context, under the same env. That's harmless.

## Build

One PR, built with Codex after the quota resets. One Codex review at high effort. Hard-rule files: `packages/core/src/runtime.ts`, `packages/core/src/guard.ts`, `apps/server/src/runtime/**`.
