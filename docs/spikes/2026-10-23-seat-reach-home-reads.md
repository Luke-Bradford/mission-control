# Spike: what a seat's code can read in the operator's home (#203, probe 1)

Date: 2026-10-23. Claude Code 2.1.308 (macOS).

This note covers probe 1 of #203 (home-folder reads). Probes 2 (the data-protection keychain) and 3 (launch paths) need the operator's go-ahead before they run, and are not covered here.

## Method

A harness on a throwaway branch built a writer seat's exact CLI arguments and sandbox settings with the real `crewCliArgs` and `crewSandboxSettings` (`packages/core/src/runtime.ts`), mirroring the supervisor's writer-seat call (`apps/server/src/runtime/supervisor.ts`).

- It used no hub, no MCP server, no network, no keychain and no launchd job.
- It ran one `claude -p` session in the seat's worktree.
- A hook allowed only the probe's exact commands.

The seat ran a vitest file that tried to read two canary files and list `~/Library/Application Support`, and printed only whether each read worked. Each canary held a random string:
- one in a fresh folder under `~/Library/Application Support/`;
- one in a fresh folder directly in `~`.

The harness deleted both canary folders and its scratch folder afterwards. A check after each run found none left.

## Results

| Run | Settings | Canary in `~/Library/Application Support` | Canary in `~` | List `~/Library/Application Support` | Checks run in the seat |
|---|---|---|---|---|---|
| 1 | Today's writer-seat settings | read | read | listed (47 entries) | probe only |
| 2 | Whole home denied for reads; seat paths re-allowed (below) | `EPERM` | `EPERM` | denied | typecheck passed; build passed; lint failed only on the probe's own files; `pnpm -s test` failed: git couldn't read `~/.gitconfig` |
| 3 | As run 2, plus `~/.gitconfig` and `~/.config/git` re-allowed | `EPERM` | `EPERM` | denied | `vitest run apps/server/test/files.test.ts` (git-backed): 51 passed |

Run 2 re-allowed these paths for reads:
- the seat's worktree;
- its clone's git dirs (`gitCommonDir`, `worktreeGitDir`);
- the sandbox temp root `/tmp/claude-<uid>`;
- the seat's pnpm store;
- the node and pnpm install folders resolved from `PATH`.

What run 2 showed:
- The CLI accepts a read deny on a folder with `allowRead` entries under it, and enforces both.
- Typecheck and build pass with the home folder denied.
- `pnpm -s test` also hit the CLI's 2-minute command limit. Seats run only the test files for their change and leave the full suite to CI (CONTRIBUTING.md), so that limit isn't a sandbox finding.

## Decision for gap 1 (home reads)

**Close it with a settings change.** A seat's sandbox denies reads of the whole home folder, and re-allows only:
- its worktree and its clone's git dirs;
- `/tmp/claude-<uid>` and its pnpm store;
- the node and pnpm toolchain folders;
- `~/.gitconfig` and `~/.config/git`.

This adds to today's deny list for credential folders, which stays: everything else in home becomes unreadable by default too, browser profiles and `~/Library/Application Support` token files included. The build work is #487: `crewSandboxSettings` gains the home deny and the re-allow list, and the supervisor passes the toolchain and store paths.

Still to check when that's built: a real seat running each repo's own commands. Repos whose tools read other files in home (for example a global npm or pip config) may need an entry in the new `crew.allow_read` that #487 adds.

## Security review follow-up for #487

The review probed the real CLI sandbox on **Claude Code 2.1.302**:

| Rule arrangement | Observed result |
|---|---|
| A deny nested inside an allowed parent | The nested path is denied. |
| A grant equal to or inside a denied path | The grant reopens that path. |
| A symlink to a denied file | Reading through the symlink is denied. |

Consequently, extra and computed read grants must never equal or lie inside credential,
data-directory or operator-denied paths. Only the broad home denial is intentionally reopened.
The config validator checks real paths, and the runtime backstop rejects conflicting computed
grants before starting the CLI. Worktree and git-dir grants are exempt from that backstop.

The implementation grants resolved node/pnpm executable files, plus a verified package folder
only when its package.json names pnpm; that folder may not hold home or the pnpm store. It also
resolves global git config and discovered include files, retaining a credentials denial under
the resolved git config directory. Redundant temp/store grants are omitted because those paths
are outside home. Seat temp-root isolation remains a separate ticket.
