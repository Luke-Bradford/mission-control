# Spike: what the hub needs to crew a non-pnpm repo with an organisation's board

Date: 2026-10-22, against `main` at `b7d0254`. Code reading, the probes recorded in the
2026-10-20 and 2026-10-21 spikes, and read-only GraphQL with the hub's `gh` token. No product code
changed. This answers #52.

**Decision.** Three changes come before a crew works in another team's repo: seat commands and
protected files per repo from local config, Projects read through whatever owner GitHub reports,
and the hub installing a non-pnpm repo's dependencies. The sandbox stays closed to localhost TCP
for as long as the hub's API has no sign-in; whether a test database can be reached over one
named Unix socket waits on a probe. One login per vendor per machine is enough.

## 1. Seat commands

How it works today:

- **The CLI's allowlist decides what runs.** `WRITER_TOOLS` names `pnpm -s lint`, `typecheck`,
  `test`, `build` and `vitest` as `Bash(<prefix>:*)` rules (`packages/core/src/runtime.ts` 198),
  passed as `--allowedTools`. `autoAllowBashIfSandboxed: false` (557) keeps the list in force
  inside the sandbox. A command with no rule is refused as "requires approval" (2026-10-21 spike).
  Read-only and scratch seats get only `pnpm -s vitest` (`READONLY_TOOLS` 216, `SCRATCH_TOOLS`
  227).
- **The guard is a deny layer and the test lock, not an allowlist.** It parses the shell line,
  looks through the wrappers in `WRAPPERS` (`packages/core/src/guard.ts` 164: `env`, `timeout`,
  `xargs` and the like), and denies git writes, gh writes, and `curl`/`wget` by name (1211-1221).
- **`full_suite`** entries must be commands seats may run (`seatsMayRun`,
  `apps/server/src/config.ts` 807). The lock takes a later word as a single test path when it
  holds a `/` or ends in a JS file ending, and any `--` keeps a full run (vitest's rule;
  `guard.ts` 964-975). So `pytest tests/x.py::test_y` runs unlocked, `pytest test_x.py` takes
  the lock, and `pytest tests/unit` runs a whole folder unlocked.

Decision: a repo's seat commands come from local config, per repo, with today's pnpm list as the
default so this repo is unchanged. Each entry is checked when the config loads:

- **Plain words only:** no shell metacharacters, redirection or `$`.
- **No bare runner.** Refuse an entry that ends at a word which runs whatever follows it:
  `uv run`, `uvx`, `npx`, `pnpm exec`, `pnpm dlx`, `python`, `node`, a bare `just` or `make`.
  The guard does not look through these (they are not in `WRAPPERS`), so an allowed `uv run`
  would let `uv run git …` past the guard's git rules. Refuse `sh` and `bash` too: the guard reads
  an `sh -c` script (`guard.ts` 875-880), but not a script file the seat wrote. `uv run pytest`
  and `uv run ruff check` are fine.
- A tool that runs code the seat wrote (pytest running a test, `just test` running a recipe) adds
  nothing new: seats already write and run test code, and that code is contained by the sandbox,
  not the allowlist (`runtime.ts` 257-259).

The real risks are elsewhere, and go in the same change:

- **Gate files.** `PROTECTED_FILES` (`runtime.ts` 263) covers JS and pnpm config. A Python repo's
  gates (`pyproject.toml`, `conftest.py`, `setup.cfg`, `ruff.toml`, `justfile`,
  `.pre-commit-config.yaml`) are writable, so a seat could weaken a check to pass it. Each repo
  needs its own protected list beside its commands.
- **Nothing outside the sandbox.** `allowUnsandboxedCommands: false` (555) stays, and
  `excludedCommands` stays unset.
- **The test lock** needs each runner's single-test form (`pytest tests/x.py::test_y`).
- **Prompts.** The RETRO brief and role text name pnpm (`apps/server/src/runtime/brief.ts` 150,
  `roles/RETRO.md` 8), and FLIGHT's role names this repo's areas (`roles/FLIGHT.md` 9). They should
  take the repo's commands and areas.

`runtime.ts`, `guard.ts`, `apps/server/src/runtime/**` and `roles/**` are hard-rule files: the
operator merges these changes.

## 2. Dependencies and caches

The hub installs dependencies only when the worktree has `pnpm-lock.yaml`
(`apps/server/src/runtime/checkouts.ts` 601), from the lockfile with no lifecycle scripts
(`INSTALL_ARGS` 197). A Python repo gets nothing, and a seat cannot fetch packages (no network).
The hub needs a per-repo install from the repo's lockfile with the same no-scripts rule; whether
each tool has one (`uv sync --frozen` can build source packages, which runs their build code) is
for that ticket to settle.

Only pnpm's store is moved out of the worktree (`apps/server/src/runtime/supervisor.ts` 712), and
the commit tool's `add -A` leaves out only `.pnpm-store` (`apps/server/src/mcp/tools.ts` 275).
`.pytest_cache` and `__pycache__` would be committed unless the repo ignores them.

## 3. Organisation Projects

How it works today: three reads go through `user(login:)`: the board collector
(`apps/server/src/collectors/github.ts` 62), Setup's board check, which also creates fields
(`apps/server/src/github-setup.ts` 62, 78), and the repo profile, whose error already says
"organisation projects are not supported yet" (`apps/server/src/repo-profile.ts` 66, 104). The
HUD's board link builds `/users/<owner>/projects/<n>` (`apps/web/src/board/lanes.ts` 34). The
Project's owner is the repo's owner. Card moves read `repository.issue.projectItems`, which works
for either owner.

Live check: `repositoryOwner(login:)` reports `__typename` `User` for this repo's owner and
`Organization` for an organisation the account belongs to; both answer through the
`ProjectV2Owner` interface. `repositoryOwner(login:) { ... on ProjectV2Owner { projectV2(number:) } }`
returned this repo's Project.

Decision: detect the owner, don't configure it. One query through `ProjectV2Owner` serves both;
the HUD link uses `/orgs/` for an organisation. Reads need `read:project`, field writes `project`.
An organisation that enforces SAML SSO needs the token authorised for it; how `gh` reports a token
that isn't is unverified (the organisation read above succeeded and sent no `X-GitHub-SSO` header), so the
change should make health name that refusal with its fix.

## 4. Sandbox network

A seat's settings set `network: { allowedDomains: [] }` (`runtime.ts` 558) and none of
`allowUnixSockets`, `allowLocalBinding` or `excludedCommands`.

| Check | Result | Source |
|---|---|---|
| Hub API from sandboxed code | `fetch('http://127.0.0.1:7420/api/health')` → EPERM; curl could not connect | 2026-10-20 spike |
| Localhost TCP through an allowed test command | `SANDBOX-NET-ERR fetch failed EPERM` | 2026-10-21 spike, run B |
| Unix socket | Not run | below |

The Unix-socket probe was not run here. A seat's typed `nc` or `python3` is refused by the
allowlist before it runs, so the probe has to be a committed test run through an allowed test
command, which needs a seat run on a branch. The steps: outside the sandbox, `nc -lU
/tmp/mc-probe.sock` and `python3 -m http.server 8765 --bind 127.0.0.1`; inside, a vitest case that
calls `net.connect({ path: "/tmp/mc-probe.sock" })` and `net.connect({ host: "127.0.0.1", port: 8765 })`
and logs `connect` or the error code within 3 s.

Decision:

- **Localhost TCP stays closed.** The hub listens on 127.0.0.1:7420 with no sign-in
  (`apps/server/src/main.ts` 3). Its only request checks are `Host` and `Origin`
  (`apps/server/src/api.ts` 359-378), and a POST with no `Origin` passes them, as any local process
  sends. Sandboxed code that could reach localhost could start seats and message them through the
  API.
- **A test database** is reached over one named Unix socket (`allowUnixSockets`, per repo) only if
  the probe shows that the setting admits that socket and nothing else. Until then, tests that need
  a service don't run in seats; they stay in the repo's CI.

## 5. Accounts

The config refuses a second account of a vendor (`config.ts` 846-857), because usage is read from
the machine's one login (Keychain service `Claude Code-credentials`,
`apps/server/src/collectors/usage-sources.ts` 13, and `codex app-server`). Nothing in the server
sets `CLAUDE_CONFIG_DIR`, so every seat runs on the machine's one Claude login, whatever its
`account_id`.

Decision: no change. Crewing another repo needs no second account. Whether a repo should run on a
different subscription is the operator's call; if it should, the seat needs its own
`CLAUDE_CONFIG_DIR`, the hub a usage reader per account, and that directory a place in the deny
list.

## Also checked

- **Hard rules.** A repo with no `## Mission Control` block gets `DEFAULT_HARD_RULES`
  (`apps/server/src/engine/rules.ts` 106), which name this repo's paths; for another repo only
  `CLAUDE.md` and `.github/**` match. Nothing auto-merges in `draft`, so no change: a repo crewed in
  `merge` carries its own block.
- **CI files.** `PROTECTED_FILES` holds `.github/**` for every repo. Edit and Write are denied
  there, and the commit tool leaves protected files out of a commit
  (`apps/server/src/mcp/tools.ts` 1256), so a seat's change to CI never reaches its branch, even
  one its test code wrote.
- **The repo's own agent settings.** `--restricted` ignores the repo's `.claude` settings and hooks
  (`runtime.ts` 178-183). The hub's guard and sandbox apply instead; the repo's own hooks don't run.

## Follow-ups

1. **area:server**: `repos[].commands` and `repos[].protected` in the config, with the entry rules
   in §1, defaulting to today's pnpm list.
2. **area:core**: seat allowlists, protected-file rules and the test lock's single-file rule built
   from the repo's commands and protected list (hard-rule files). Depends on 1.
3. **area:server**: the brief and role prompts take the repo's commands and areas, not pnpm and
   this repo's (hard-rule files). Depends on 1.
4. **area:server**: the hub installs a non-pnpm repo's dependencies from its lockfile without
   running package code, and keeps tool caches out of the worktree and its commits.
5. **area:server**: Projects read through `repositoryOwner` (collector, Setup, repo profile), and
   health names an SSO refusal with its fix.
6. **area:web**: the board link uses `/orgs/` for an organisation's Project. Depends on 5.
7. **research**: the Unix-socket probe in §4, and the `allowUnixSockets` decision it settles.
