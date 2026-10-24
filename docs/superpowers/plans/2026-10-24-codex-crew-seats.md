# Codex Crew Seats Implementation Plan

> **For agentic workers:** this is built step by step by Codex runs that the controller starts. Each step ends in its own PR and gets one Opus review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a crew seat on a Codex account runs a confined, guarded `codex app-server` thread. It has the same floor and the same lifecycle (start, send, steer, interrupt, end, set aside, resume, survive a hub restart) as a Claude seat. (#426, #427)

**Architecture.** The keeper stays the owner of the process. For a Codex seat it spawns `codex app-server` instead of `claude -p`.

A second session driver, `runtime/codex-session.ts`, implements the same `CrewSession` interface as `runtime/session.ts`:

- it speaks Codex JSON-RPC over the keeper socket;
- it maps Codex notifications onto the existing `SessionEvent`s, so `supervisor.ts`'s event handling barely changes;
- it answers approval requests through the hub's guard.

Confinement comes from a Codex permission profile built from the same inputs as `crewSandboxSettings`.

**Tech stack:** TypeScript on Node 24 (`--experimental-strip-types`, so no enums, parameter properties or other non-erasable syntax), vitest, codex-cli ≥ 0.154.0.

**Spike:** `docs/spikes/2026-10-24-codex-seat-confinement.md`. Read it first: it records the protocol shapes this plan relies on.

## Global constraints

- **The floor is not lowered.**
  - A Codex seat gets no read, write, network, git or GitHub ability that a Claude seat in the same mode lacks.
  - Where a Codex control cannot be applied or confirmed, the seat refuses to start with `CANNOT_START` and logs why. It never runs looser.
- **Approval policy `untrusted`, always.**
  - Every `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` is decided by the hub.
  - Any other server request (`item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `applyPatchApproval`, `execCommandApproval`, or one unknown to this code) is declined.
- **No `--sandbox`, `sandbox_mode` or `dangerously…` flag** for a Codex seat; permission profiles only.
- **Claude seats are unchanged.** Every existing supervisor, keeper and session test passes untouched.
- **Configuration still refuses Codex seats until Step D.** Steps A–C are exercised only by tests, through a fake app-server fixture.
- **Hard-rule files:** `apps/server/src/runtime/**`, `apps/server/src/mcp/**`, `apps/server/src/config.ts`, `packages/core/src/runtime.ts` and `packages/core/src/guard.ts`. Every PR in this plan carries a Security section.
- **No UI.** #428 (work lane) does the web part after Step D.

## Review focus

The cases most likely to bite, with the step that pins each:

1. **A command wrapper hides the real command.** Codex sends `"/bin/zsh -lc '<cmd>'"`. The guard must judge `<cmd>`, and refuse anything it cannot unwrap exactly: other shells, other flags, nested quoting it cannot parse. (A)
2. **A file edit outside the seat's area or on a protected file.** `fileChange` approvals carry only an `itemId`. The paths come from the matching `item/started`; an approval with no known paths is declined. (A, B)
3. **An approval request replayed after a hub restart.** The new hub answers it from the guard again. It never auto-accepts, and never leaves the turn hanging. (C)
4. **A Codex binary too old for permission profiles, or one that silently ignores them.** The seat refuses to start. (B)
5. **The test lock.** A Codex test command takes the lock at approval and releases it at that item's `item/completed`, the turn's end or the process's exit. (B)

---

### Step A: the Codex floor as pure functions (`packages/core`)

**Files:**
- Create: `packages/core/src/codex.ts`
- Test: `packages/core/test/codex.test.ts`
- Modify: `packages/core/src/index.ts` (export)

**Interfaces it produces:**
- `codexPermissions(i: CrewSandboxInput, mode: CrewMode, area: readonly string[]): string[]` returns the `-c` arguments, in pairs: `["-c", 'default_permissions="mc_seat"', "-c", 'permissions.mc_seat.filesystem={…}']`. It maps `crewSandboxSettings`' inputs as follows:
  - `":root"="read"`.
  - Every path in the Claude seat's deny-read list (`SANDBOX_DENY_READ_HOME`, `dataDir`, `seatDeny`) is set to `"deny"`.
  - Under `":workspace_roots"`:
    - a writer seat gets `"."="write"`, or each area glob as `"write"` with `"."="read"` when `area` is not empty;
    - `.git`, `gitCommonDir` and `worktreeGitDir` are `"deny"` for writes. Keep them readable; git reads them. If a profile cannot say "read but not write" for a path inside a write root, map it to `"read"` and note it.
    - every `PROTECTED_FILES` entry is `"read"`;
    - read-only and scratch modes follow `crewSandboxSettings`.
  - TOML values are quoted with a dedicated helper. It rejects paths containing `"`, `\` or newlines and throws, rather than emit a broken profile.
- `codexCommand(raw: string): string | null` unwraps exactly `/bin/zsh -lc '<cmd>'`, `/bin/bash -lc '<cmd>'` and `/bin/sh -c '<cmd>'` (single-quoted, with `'\''` escapes). Anything else returns `null`.
- `codexGuardEvent(req: { method: string; params: unknown }, paths: readonly string[] | undefined): GuardEvent[] | null` maps an approval request to the guard events to check:
  - a command approval → `[{tool:"Bash", input:{command}}]`;
  - a file change → one `{tool:"Edit", input:{file_path}}` per path;
  - anything else, or an unwrappable command or unknown paths → `null`, which means decline.
- `codexCommandAllowed(command: string, mode: CrewMode, commands?: SeatCommands): boolean` applies the same Bash allowlist `crewCliArgs` gives a Claude seat (`bashEntries`), so a Codex seat can run only the commands a Claude seat could.

- [ ] **Write the tests**
  - **Permissions:**
    - a writer seat with no area yields `"."="write"` plus deny for every `SANDBOX_DENY_READ_HOME` entry and `dataDir`;
    - an area `["apps/web/**"]` yields `"."="read"` and `"apps/web/**"="write"`;
    - a path containing `"` throws.
  - **Unwrapping:**
    - `codexCommand("/bin/zsh -lc 'git status --short'") === "git status --short"`;
    - `codexCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")` unescapes;
    - `codexCommand("/usr/bin/env zsh -lc 'x'") === null`;
    - `codexCommand("/bin/zsh -c 'x'") === null`, because only `-lc` is accepted for zsh.
  - **Guard events:**
    - a `fileChange` with paths `["/w/a.ts","/w/b.ts"]` yields two Edit events;
    - `paths === undefined` yields `null`;
    - `item/permissions/requestApproval` yields `null`.
  - **Allowlist:** `codexCommandAllowed("pnpm -s test", "writer")` is true, and `codexCommandAllowed("rm -rf /", "writer")` is false. Mirror an existing `crewCliArgs` allowlist test.
- [ ] **Implement and run:** `pnpm -s exec vitest run --project core packages/core/test/codex.test.ts`.
- [ ] **Run lint and typecheck, then commit:** `feat(#426): the Codex seat floor as pure functions`.

### Step B: a Codex seat starts and reports its stream (#426)

**Files:**
- Modify: `apps/server/src/runtime/keeper.ts`. The spec gains `turnEnd: "claude" | "codex"` and `marker: string`:
  - turn end is detected by `RESULT_PREFIX` for Claude, and by a line starting `{"method":"turn/completed"` for Codex;
  - process identity checks `marker` in argv. For Claude the marker is the CLI session id; for Codex it is `mc_run="<runId>"`.
  - Old spec files without these fields read as `"claude"` and `cliSessionId`, so live keepers keep working.
- Create: `apps/server/src/runtime/codex-session.ts`. It exports `startCodexSession(i: CodexSessionInput): Promise<CrewSession>`, built on the same keeper start and attach code as `startSession` and `attachSession`; extract the shared part rather than copy it. Responsibilities:
  - **Handshake:**
    - `initialize`, then `initialized`;
    - `thread/start` with `{cwd, model, approvalPolicy:"untrusted", developerInstructions: rolePrompt, ephemeral:false, config:{mcp_servers:{mc:{url, bearer_token_env_var:"MC_SEAT_TOKEN"}}}}`;
    - the token reaches the app-server through env `MC_SEAT_TOKEN` in the keeper spec's `env`.
  - **Start check:** the thread id is recorded through the `init{sessionId: threadId}` event. If the `thread/start` response's `approvalPolicy` is not `"untrusted"`, the session is closed and start fails.
  - **`send(text)`:** `turn/start {threadId, input:[{type:"text", text}], effort}`.
  - **`control("interrupt")`:** `turn/interrupt {threadId, turnId}`.
  - **`control("get_context_usage")`:** built from the last `thread/tokenUsage/updated` and the model's context window. Return `null` fields where Codex gives none; never invent them.
  - **Events:**
    - `turn/started` → `turn-start`;
    - `turn/completed` → `result{isError: turn.status === "failed", stopReason: turn.status}`;
    - `item/completed` commandExecution → `tool-result{toolUseId: item.id}`;
    - `account/rateLimits/updated` with a rejected status → `rate-limit`;
    - every line → `output`; stderr → `stderr`; exit → `exit`.
  - **Approvals:** an approval request calls `deps.approve(req, paths)`. The supervisor supplies that callback; see below. The session remembers `item/started` fileChange paths by item id.
- Modify: `apps/server/src/runtime/supervisor.ts`.
  - `launch()` picks the driver from the seat's account vendor: `claude` keeps today's path exactly.
  - Codex args: `["app-server", "-c", 'mc_run="<runId>"', ...codexPermissions(...)]`.
  - Codex env: `crewEnv` without the `CLAUDE_*` keys, plus `MC_SEAT_TOKEN`.
  - `approve` runs `codexGuardEvent` → `codexCommandAllowed` (commands) → `crewGuardDecision` for each event. Every refusal is recorded like a guard refusal today.
  - The test lock is taken at approval with `{runId, toolUseId: itemId}` and released by the existing `tool-result` and `result` handling.
  - Before launch, a codex seat checks `codex --version` against `CODEX_MIN_VERSION = "0.154.0"`. If it is older or unreadable, the seat refuses with `CANNOT_START`.
- Modify: `apps/server/src/mcp/server.ts`, only if a Codex call lacks `claudecode/toolUseId` `_meta`. In that case the test-lock key falls back to the approval's item id. Check this first with the fake.
- Test:
  - Create `apps/server/test/fixtures/fake-codex.mjs`, a fake app-server speaking the spike's shapes. It has modes to request approval for a given command or file change, and to end a turn failed.
  - Create `apps/server/test/codex-session.test.ts`.
  - Extend `supervisor-start.test.ts`.

- [ ] **Write the tests**, through the fake codex driven by a test-only seat on a codex account (config rejection is bypassed only through the test harness's direct `createSupervisor` deps):
  - the spawn args contain `app-server`, `mc_run="<runId>"` and `default_permissions="mc_seat"`, and contain no `--sandbox`;
  - a turn's `turn/started` and `turn/completed` set the seat `running`, then `idle`;
  - an approval for `/bin/zsh -lc 'git commit -m x'` is answered `decline`, and a guard refusal is recorded;
  - an approval for `/bin/zsh -lc 'pnpm -s test'` is answered `accept`, holds the test lock and releases it at `item/completed`;
  - an approval for `/usr/bin/env zsh -lc x` is declined;
  - a `fileChange` approval for a path outside the area is declined; one inside the area is accepted;
  - `item/permissions/requestApproval` is declined;
  - a `thread/start` response with `approvalPolicy:"never"` makes the start fail;
  - an old `spec.json` without `turnEnd` or `marker` still attaches as Claude. This is a keeper test.
- [ ] **Implement.** Run the two test files plus `keeper.test.ts` and `supervisor-start.test.ts` (outside the Codex sandbox; the controller runs these).
- [ ] **Live check, by the controller:** a real `codex app-server` started by this code in a scratch repo. Confirm:
  - the hub's MCP server answers the seat's `mcp__mc__*` call, which confirms `bearer_token_env_var`;
  - a denied-path read from a script fails;
  - `git commit` is declined.
  Record the result in the PR.
- [ ] **Commit:** `feat(#426): a Codex crew seat starts confined and reports its stream`.

### Step C: lifecycle parity (#427)

**Files:**
- Modify: `apps/server/src/runtime/supervisor.ts`, `codex-session.ts` and `store.ts`.
- Test: `supervisor-restart.test.ts`, `supervisor-events.test.ts` and `codex-session.test.ts`.

**Changes:**
- **Store:** `runs.vendor` and `seat_sessions.vendor` columns, `'claude'` by default. `runs.session_id` holds the Codex thread id for codex runs.
- **Resume, wake and the no-keeper restart:** `thread/resume {threadId, …same overrides}` in place of `--resume`. The `RESUME_WINDOW_MS` failure rules apply unchanged.
- **Reattach after a hub restart:** the replay from the keeper cursor may contain approval requests with no response after them. The session answers each one again through `approve`, and never auto-accepts.
- **Interrupt-and-send:** `turn/steer` when mid-turn and the operator did not ask to interrupt; otherwise `turn/interrupt` then `turn/start`.
- **End, set aside and stop:** the same paths as Claude. `close()` ends stdin; the keeper's grace and kill rules are unchanged.
- **Folding:** `thread/tokenUsage/updated` → run tokens; cost is `null` (shown "—"). Plan updates (`turn/plan/updated`) are stored as the run's latest plan text for #428 to show.

**Tests:**
- [ ] **Restart:** a codex seat's keeper survives `stopAll`, the next hub attaches, and the replayed unanswered approval is answered once.
- [ ] **No keeper:** the next hub resumes with `thread/resume` and the same thread id.
- [ ] **Interrupt-and-send** mid-turn sends `turn/interrupt` then `turn/start`; send between turns sends `turn/start` only.
- [ ] **Set aside, then wake:** the thread id survives.
- [ ] **Usage:** tokens fold from `thread/tokenUsage/updated`; cost stays null.
- [ ] **Commit:** `feat(#427): Codex seats resume, steer, stop and survive a hub restart`.

### Step D: configuration accepts Codex seats (#427)

**Files:**
- Modify: `apps/server/src/config.ts` (`checkCrew` ~945) and `apps/server/src/config-write.ts`.
- Test: `config.test.ts` and `config-write.test.ts`.

**Changes:**
- A seat may reference a codex account.
- A seat's `model` must suit its account's vendor: Claude model ids for claude, `gpt-*` for codex.
- `effort` maps to Codex's `effort` values (`low|medium|high`; `max` → `high`, noted).
- `updates.cli` stays Claude-only: Codex seats keep the binary they started on, and a CLI Update never restarts an active seat. Note this in `docs/runbook.md`.

**Tests:**
- [ ] A codex seat with a `gpt-*` model loads.
- [ ] A claude model on a codex account is refused, and so is the reverse.
- [ ] A config write that pairs them wrongly answers 400.
- [ ] **Commit:** `feat(#427): configuration accepts Codex crew seats`.

**After Step D:**
- the controller runs a draft-mode trial with one Codex seat on a `chore` ticket;
- #428 (web, work lane) moves to Ready.
