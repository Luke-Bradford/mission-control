# Seat git hardening: design (#635)

Date: 2026-10-25. Covers every crew seat, Claude and Codex, and follows on from #632, which was cut back to read parity. The git facts below were checked on git 2.54.0.

## The gaps

A seat may run `git status`, `diff`, `log` and `show`. For Claude seats these come from `GIT_READ_TOOLS` (`packages/core/src/runtime.ts:218`); for Codex seats from `codexGitReadCommand` (`packages/core/src/guard.ts` ~1530). Those reads can do more than read, in four ways:

1. **Helpers run during reads.** If config defines a helper, git runs it: `diff.external`; `diff.<driver>.textconv` or `filter.<driver>.clean`/`process`, either selected by a seat-writable `.gitattributes`; or `core.fsmonitor`. A seat inherits the operator's `HOME`, so helpers from `~/.gitconfig`, the system config or the clone's config run inside the seat's sandbox.
2. **The seat's git env can be overridden in the command line** (Claude): `GIT_X=… git diff`, `env [-S] GIT_X=… git log`, `export GIT_CONFIG_COUNT=…; git diff`, `git -c …`, `git --git-dir …`.
3. **`git diff` reads outside the worktree.**
   - `git diff --no-index A B` compares any two paths.
   - So does plain `git diff /a /b` when both paths are outside the repo, because git then implies `--no-index`.
   - A lexical path check is defeated by a symlink inside the worktree: `git diff --no-index esc/hosts f` with `esc -> /etc`.
4. **`git diff`, `log` and `show --output=<file>` write a file.** Claude's `Bash(git diff:*)` allows this today, even for read-only seats.

The OS sandbox still bounds what a helper can write, read through the deny list and reach on the network. The risk is code the seat didn't ask for running, plus reads and writes the Read and Edit rules would refuse.

## Decisions

### 1. The seat env ignores the operator's git config (both vendors)

A new `CREW_GIT_ENV` goes in `packages/core/src/runtime.ts`, merged into `crewEnv` (`apps/server/src/runtime/supervisor.ts:1043`) and into the Codex seat env:

| Variable | Value | Effect |
|---|---|---|
| `GIT_CONFIG_NOSYSTEM` | `1` | no system config |
| `GIT_CONFIG_GLOBAL` | `/dev/null` | no `~/.gitconfig`, its includes, or `~/.config/git/config` |
| `GIT_ATTR_NOSYSTEM` | `1` | no system attributes |
| `GIT_CONFIG_COUNT` with `KEY`/`VALUE` 0–1 | `2`: `core.fsmonitor=false`, `core.hooksPath=/dev/null` | command-line scope, which beats repo config |
| `GIT_PAGER` | `cat` | no pager program |

- **Don't set `diff.external` to an empty value.** Git then tries to run `""` and plain `git diff` fails ("cannot run :").
- **`GIT_EXTERNAL_DIFF` is never passed.** `CREW_ENV_KEYS` is an allowlist.
- **What this does not cover:**
  - `~/.config/git/attributes` is still read. That's harmless: a driver still needs a config definition, global config is nulled, and the clone is checked (§2).
  - Seats lose the operator's global excludes and aliases. Repo-config aliases still work: the guard sees `git <alias>`, and an alias name can't match the read prefixes, so it's refused.
- The hub's own git already uses `SAFE_CONFIG` (`apps/server/src/runtime/git.ts:38`). These entries are for the seat's own git.
- **Version floor.** `GIT_CONFIG_GLOBAL` needs git 2.32 or later, and `GIT_CONFIG_COUNT` needs 2.31. Older git silently ignores both. The hub checks `git --version` at start: below 2.32, seats refuse to start, with the reason "git ≥ 2.32 required for seat isolation".

### 2. The clone defines no helpers (checked on create and reuse)

- **Who can write the clone's config:** only the hub, because seats can't write `.git/**` (the sandbox's `denyWrite`). Even so, the operator may have configured a driver there.
- **Where the check runs:** `prepareCheckout` (`apps/server/src/runtime/checkouts.ts`) runs it on both paths, the new-worktree path and the reuse path that returns early (~1235), in the worktree's cwd, so the common and worktree config are both read.
- **The env it uses:** `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` only. Without the `GIT_CONFIG_COUNT` entries, the seat's own `core.fsmonitor=false` doesn't appear as a match.
- **The command:**

  `git config --includes --show-origin --get-regexp '^(diff\.external|core\.fsmonitor|(diff|filter|merge)\..+\.(textconv|command|clean|smudge|process|driver))$'`

- **What counts as a helper:** any match, except `core.fsmonitor` set to `false` or empty.
- **On a helper:** the start is refused with `CANNOT_START` and the reason "the clone's git config defines helpers: <keys>". Keys are logged, never values.

### 3. Guard rules, per vendor

**Claude seats.** These go in the shared tokenizer in `packages/core/src/guard.ts`: the assignment handling (~923) and `WRAPPERS` (~197). Each rule judges its own segment. The new rule is `git-env`.

A segment is refused when it:
- assigns any `GIT_*` inline;
- runs `env` with `-i`, a bare `-`, `-u GIT_*`, a `GIT_*=` assignment, or `-S` whose script assigns `GIT_*`;
- runs `git` with `-c`, `--config-env`, `--git-dir`, `--work-tree`, `--exec-path` or `--namespace`, or `-C <path>` that resolves outside the worktree;
- runs `git diff` or `difftool` with `--no-index`;
- passes `--output` (or `--output=`) to `diff`, `log` or `show`;
- passes any `git diff` operand that names a filesystem path resolving outside the worktree. Paths are resolved with `realpath` (nearest existing parent), as Read does. Revisions (`HEAD`, `HEAD~1..HEAD`, `<sha>`, `HEAD:path`) aren't filesystem paths and stay allowed.

The whole line is refused when any segment runs `export`, `declare`, `typeset`, `readonly`, `unset` or `set -a` naming `GIT_*`, because those builtins persist into later segments.

**Codex seats.** `normalise` returns early for Codex (~913), and `codexGitReadCommand` already refuses:
- `-c`, `-C` and `--git-dir`, because `argv[1]` must be the subcommand;
- `--no-index` and `--output`;
- inline assignments and `env`.

Codex therefore needs only:
- operand confinement for `git diff`, resolved with `realpath` through the existing `allowedPath`;
- a test that `export` or `declare` of `GIT_*` is refused, which the Codex tokenizer's `$`, `=` and `()` bans should already do.

### 4. What stays allowed

| Command | Claude | Codex |
|---|---|---|
| `git status`, `git status --short` | ✓ | ✓ |
| `git diff`, `git diff --stat`, `git diff HEAD~1..HEAD` | ✓ | ✓ |
| `git log --oneline -5`, `git log main`, `git log -- apps/server` | ✓ | ✓ |
| any of the above piped to `head`, `wc -l` or `grep` | ✓ | ✓ |
| `git log --format='%h %s' -3` | ✓ | ✗ (not in `CODEX_GIT_READ_OPTIONS`) |
| `git show HEAD:package.json` | ✓ | ✗ (`codexGitRevision` rejects `:`) |
| `git -C apps/server log --oneline -3` (inside the worktree) | ✓ | ✗ (`argv[1]` must be the subcommand) |

Widening Codex to the Claude-only rows is a separate ticket.

## Tests

- **Sentinel tests**, in a new `apps/server/test/seat-git.test.ts` (temp `HOME`, temp repo):
  - a sentinel-writing helper configured as `diff.external` in a temp global config, as a temp system config (`GIT_CONFIG_SYSTEM`), and as a textconv and a clean filter selected by `.gitattributes`;
  - none of them runs under `CREW_GIT_ENV` for `git diff`, `log -p`, `show` or `status`;
  - `git diff` still prints the diff.
- **Checkout check:**
  - a clone with `diff.x.textconv` is refused on both create and reuse, naming the key;
  - a clean clone starts;
  - a clone with `core.fsmonitor=false` starts.
- **Version floor:** a stubbed `git version 2.30.0` refuses seats.
- **Guard tables:**
  - every bypass form in §3, including `env -S`, `git diff /a /b`, `git diff f /outside` and a symlinked operand, is refused with `git-env`, per vendor;
  - every ✓ in §4 is allowed for writer, read-only and scratch seats;
  - the existing positive Claude git tests stay unchanged.

## Residual risk

- **Built-in drivers.** A seat-writable `.gitattributes` can still select git's built-in drivers (such as `diff=cpp`), which run no programs.
- **Claude Code's own git use** for context runs under the same env. That's harmless.
- **Other tools.** A tool other than git that reads `GIT_*` config is unaffected. No seat command does today.

## Build

One PR, built with Codex after the quota resets. One Codex review at high effort. Hard-rule files:
- `packages/core/src/runtime.ts`;
- `packages/core/src/guard.ts`;
- `apps/server/src/runtime/**`.
