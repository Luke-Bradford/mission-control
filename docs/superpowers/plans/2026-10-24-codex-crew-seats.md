# Codex Crew Seats Implementation Plan

> **For agentic workers:** Codex runs started by the controller build this one step at a time. Each step ends in its own PR, which gets one Opus review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a crew seat on a Codex account runs a confined, guarded `codex app-server` thread. It has the same floor and the same lifecycle as a Claude seat: start, send, steer, interrupt, end, set aside, resume, and survive a hub restart. (#426, #427)

**Architecture.**
- The keeper still owns the process. For a Codex seat it spawns `codex app-server` instead of `claude -p`.
- A second session driver, `runtime/codex-session.ts`, implements the same `CrewSession` interface as `runtime/session.ts`:
  - it speaks Codex JSON-RPC over the keeper socket;
  - it maps notifications onto the existing `SessionEvent`s, so `supervisor.ts`'s event handling barely changes;
  - it answers every approval request through the hub's checks.
- Confinement has four parts:
  - a Codex permission profile built from the same inputs as `crewSandboxSettings`;
  - a per-run `CODEX_HOME` holding only what the hub writes;
  - approval answers from the hub;
  - a start check that verifies the thread really runs under all of them.

**Tech stack:** TypeScript on Node 24 (`--experimental-strip-types`: no enums, parameter properties or other non-erasable syntax), vitest, codex-cli ≥ 0.154.0.

**Spike:** `docs/spikes/2026-10-24-codex-seat-confinement.md`, including its follow-up. Read it first: it records the exact protocol shapes this plan relies on.

## Global constraints

- **The floor is not lowered.** A Codex seat gets no read, write, network, git or GitHub ability that a Claude seat in the same mode lacks. Where a control cannot be applied or confirmed, the seat refuses to start with `CANNOT_START` and logs why. It never runs looser.
- **Approvals: only `untrusted`, reviewer `user`.**
  - Every `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` is decided by the hub.
  - The hub answers only `"accept"` or `"decline"`. Never `acceptForSession`, `acceptWithExecpolicyAmendment` or `applyNetworkPolicyAmendment`.
  - Any other server request (`item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `applyPatchApproval`, `execCommandApproval`, or any unknown request) is declined.
- **Codex config: only the hub's.**
  - Each run gets its own `CODEX_HOME` in the run folder under the hub's data dir, which seats can't read. It holds a copy of the account's `auth.json` (mode 0600) and a hub-written `config.toml`.
  - The seat never loads the operator's `~/.codex/config.toml` or `AGENTS.md`, nor the worktree's `AGENTS.md` or `.codex/`.
  - The run's `CODEX_HOME` is deleted when the run ends.
- **No `--sandbox`, `sandbox_mode` or `dangerously…` flag** for a Codex seat. Permission profiles only.
- **Claude seats are unchanged.** Every existing supervisor, keeper and session test passes untouched.
- **Configuration still refuses Codex seats until Step D.** Steps A–C are exercised only by tests, through a fake app-server fixture, plus the controller's live checks.
- **Hard-rule files.** Every PR in this plan carries a Security section. All new floor code goes in hard-rule files: `packages/core/src/runtime.ts` and `packages/core/src/guard.ts`, `apps/server/src/runtime/**` and `apps/server/src/config.ts`. No new `codex.ts` in core.
- **No UI.** #428 (web, work lane) follows Step D.

## Review focus

Each is pinned by a test in the named step.

1. **A command whose text the hub can't parse exactly is declined.** That includes a different shell, a different flag, or extra words. (A)
2. **A file edit outside the area, on a protected file, through a rename (`move_path`), or outside the worktree is declined.** (A, B)
3. **An approval replayed after a hub restart is re-answered only if no `serverRequest/resolved` followed it.** It is never auto-accepted. (C)
4. **A thread that reports anything other than the start check's values is closed before its first turn.** The values are policy `untrusted`, reviewer `user`, profile `mc_seat`, network off and no instruction sources. (B)
5. **A test command queues for the test lock at approval, and holds it until that item completes, the turn ends or the process exits.** (B)

---

### Step A: the Codex floor as pure functions (`packages/core/src/runtime.ts`, `packages/core/src/guard.ts`)

**Files:**
- Modify: `packages/core/src/runtime.ts` (the profile and the run config) and `packages/core/src/guard.ts` (the approval checks).
- Test: `packages/core/test/runtime.test.ts` and `packages/core/test/guard.test.ts`.

**Interfaces produced:**

- `codexSeatConfig(i: CrewSandboxInput, mode: CrewMode, mcpUrl: string, tmpDir: string): string`, in `runtime.ts`. It returns the run's `config.toml` text:
  - `approvals_reviewer = "user"`, `project_doc_max_bytes = 0`, and `web_search = "disabled"`;
  - no `notify`, no `[features]` except as below, and the unified/background exec feature off. Confirm the key names on 0.154 with `codex app-server generate-json-schema` (the `Config` definition), and record them in a test comment;
  - `shell_environment_policy.exclude = ["MC_SEAT_TOKEN"]`;
  - `[mcp_servers.mc]` with `url = mcpUrl` and `bearer_token_env_var = "MC_SEAT_TOKEN"`;
  - `default_permissions = "mc_seat"` and the `[permissions.mc_seat]` profile:
    - **filesystem:**
      - `":root"="read"`;
      - every path in the seat's `denyRead` (`SANDBOX_DENY_READ_HOME` under `home`, `dataDir`, then `CrewSandboxInput.denyRead`) is `"deny"`;
      - under `":workspace_roots"`, writer mode gets `"."="write"` and read-only/scratch modes get `"."="read"`. The area is **not** used here: it is checked at approval (`codexEditAllowed`), so builds and tests can write `dist/` and caches as a Claude seat's Bash can;
      - `".git"="read"`. `gitCommonDir` and `worktreeGitDir` sit outside the workspace and stay read-only through `":root"`;
      - `tmpDir` (the seat's own temp dir, an absolute path Step B passes) gets `"write"`. That's a per-run dir under `crewSandboxTmp`, which `TMPDIR`, the pnpm store and the Python caches point at, as `crewEnv` does today;
    - **network:** off, with no `features.network_proxy`.
  - Every string goes through one TOML-quoting helper, which throws on `"`, `\` and characters U+0000–001F and U+007F.
- `codexCommand(raw: string, parsed: readonly string[] | null): string | null`, in `guard.ts`. It returns the shell script a command approval will run, or `null`, which means decline.
  - `raw` is `params.command`. It parses as exactly three POSIX shell words with a strict parser:
    - bare characters;
    - single-quoted runs;
    - double-quoted runs whose only escapes are `\"`, `\\`, `\$` and `` \` ``;
    - concatenated runs within a word;
    - an unescaped `$` or backtick inside double quotes means `null`.
  - Word 1 must equal the shell the hub configured (see Step B), word 2 must be `-lc`, and word 3 is the script.
  - `parsed` is `params.proposedExecpolicyAmendment`. When it is `[shell, "-lc", s]`, `s` must equal the script. When it is a plain argv, its words must equal the script split by the same parser. Any mismatch returns `null`.
- `codexApproval(req: { method: string; params: unknown }, paths: readonly string[] | undefined, ctx: CodexApprovalContext): GuardEvent[] | null`, in `guard.ts`. It maps an approval request to the guard events to check, or returns `null` (decline) unless all of these hold:
  - **Command approval:** `kind === "command"`, `command !== null`, `networkApprovalContext` and `environmentId` are absent or `null`/`"local"`, `realpath(cwd)` is inside `ctx.cwd`, and `codexCommand` succeeds. It yields `[{ tool: "Bash", input: { command: script } }]`.
  - **File-change approval:** `grantRoot` is null and `paths` is known. It yields one `{ tool: "Edit", input: { file_path } }` per path.
  - **Any other method:** `null`.
- `codexCommandAllowed(script: string, mode: CrewMode, commands: SeatCommands, cwd: string): boolean`, in `guard.ts`.
  - It parses the script with the guard's existing `lineCommands` walker. It refuses on anything that walker flags as unreadable, and on any substitution, background (`&`), or redirect to a file.
  - Every argv must token-prefix-match an entry from the right list:
    - **writer:** `commands.writer` plus `GIT_READ_TOOLS`;
    - **read-only and scratch:** `commands.review` plus `GIT_READ_TOOLS`;
    - **plus a fixed read set:** `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `sed -n`, `find` without `-exec`/`-delete`, `diff` and `stat`, whose path operands are checked by `codexReadAllowed`.
  - The repo's commands are picked exactly as `crewCliArgs` picks them. `DENIED_TOOLS` still apply.
- `codexReadAllowed(path: string, cwd: string): boolean`: `realpath` (or the nearest existing parent's) is inside `realpath(cwd)`, so a Codex seat reads only what a Claude seat's `--restricted` Read could. The OS profile still denies the credential paths on top.
- `codexEditAllowed(path: string, cwd: string, area: readonly string[], protectedFiles: readonly string[]): boolean`:
  - the realpath of the path, or of its nearest existing parent, is inside `realpath(cwd)`;
  - the relative path has no `..`;
  - `pathInArea(area, rel)` holds;
  - `!isProtectedPath(rel, protectedFiles)` holds;
  - `.codex/**` is added to `PROTECTED_FILES`.

- [ ] **Write the tests** (in `runtime.test.ts` and `guard.test.ts`):
  - **Config:** the TOML text for a writer seat with `home=/home/you` contains `"/home/you/.ssh"="deny"`, `":root"="read"`, `"."="write"`, `".git"="read"`, `approvals_reviewer = "user"` and `exclude = ["MC_SEAT_TOKEN"]`. A path containing `"` throws.
  - **Command parsing**, using the spike's real strings as fixtures:
    - `codexCommand("/bin/zsh -lc ls", ["ls"]) === "ls"`;
    - `codexCommand("/bin/zsh -lc 'cat a.txt'", ["cat","a.txt"]) === "cat a.txt"`;
    - the spike's mixed-quote echo string, with its amendment, gives `echo 'it'"'"'s' "$HOME" \$x`;
    - the heredoc string gives `cat <<'E'\nline1\nE`;
    - `/usr/bin/env zsh -lc x`, `/bin/zsh -c x`, a fourth word, or a mismatched amendment give `null`.
  - **Approval mapping:**
    - `kind: "writeStdin"` gives `null`;
    - a set `networkApprovalContext` gives `null`;
    - `cwd` outside the worktree gives `null`;
    - a set `grantRoot` gives `null`;
    - `paths === undefined` gives `null`;
    - `item/permissions/requestApproval` gives `null`.
  - **Command allowlist:**
    - `pnpm -s test` (writer) and `rg foo src` are true;
    - each of these is false:
      - `pnpm -s test && rm x`;
      - `pnpm -s test $(id)`;
      - `git status; curl x`;
      - `sleep 20 &`;
      - `cat ../../etc/passwd`;
      - `cat /home/you/.ssh/id_rsa`;
      - `rm -rf /`.
  - **Edit checks:**
    - a path inside the area is true;
    - each of these is false:
      - `package.json` with area `["apps/web/**"]`;
      - `.github/workflows/x.yml`;
      - `.codex/config.toml`;
      - `../other/x`;
      - a symlinked parent that resolves outside.
- [ ] **Implement and run:** `pnpm -s exec vitest run --project core packages/core/test/runtime.test.ts packages/core/test/guard.test.ts`.
- [ ] **Lint, typecheck, then commit:** `feat(#426): the Codex seat floor as pure functions`.

### Step B: a Codex seat starts and reports its stream (#426)

**Files:**
- Modify: `apps/server/src/runtime/keeper.ts`. The spec gains `turnEnd: "claude" | "codex"` and `marker: string`.
  - **Turn end:** for Claude, a line starting with `RESULT_PREFIX`. For Codex, a stdout line that parses as JSON with `method === "turn/completed"`. Parse it; don't match a prefix.
  - **`awaiting`:**
    - `in` lines marked `user: true` set it; for Codex only `turn/start` is.
    - an error response to that request's id clears it.
  - **Identity** checks for `marker` in argv. For Claude the marker is the CLI session id; for Codex it is `mc_run="<runId>"`.
  - Old `spec.json` files read as `"claude"` and `cliSessionId`.
- Create: `apps/server/src/runtime/codex-session.ts`. It exports `startCodexSession(i: CodexSessionInput): CrewSession`, which is **synchronous**, like `startSession`:
  - the handshake sits behind `ready`;
  - `send` queues until the session is ready;
  - a failed start check closes the session, with an exit reason.

  Share the keeper start and attach code with `session.ts` rather than copy it.

  ```ts
  interface CodexSessionInput {
    args: string[]; cwd: string; env: Record<string, string>; transcriptPath: string;
    node: string; entry: string; dir: string; spawn: string; marker: string;
    model: string; effort: string | null; developerInstructions: string;
    resumeThreadId: string | null;
    approve: (req: { id: number | string; method: string; params: unknown }, paths: readonly string[] | undefined, signal: AbortSignal) => Promise<"accept" | "decline">;
    log?: (line: string) => void;
  }
  ```

  - **Handshake:**
    1. `initialize`, then `initialized`.
    2. `thread/start` (or `thread/resume` when `resumeThreadId` is set) with `{cwd, model, approvalPolicy:"untrusted", approvalsReviewer:"user", developerInstructions, ephemeral:false}`.
  - **Start check** on the response:
    - `approvalPolicy === "untrusted"` and `approvalsReviewer === "user"`;
    - `permissionProfile.id === "mc_seat"`;
    - `sandbox.networkAccess === false`;
    - `instructionSources` is empty.

    Otherwise close the session and fail with `CANNOT_START`.
  - **Events:**
    - `thread/started` or a successful start → `init { sessionId: threadId }`;
    - `turn/started` → `turn-start`;
    - `turn/completed` → `result { isError: turn.status === "failed", stopReason: turn.status }`;
    - `item/completed` of `commandExecution` → `tool-result { toolUseId: item.id }`;
    - every line → `output`, stderr → `stderr`, exit → `exit`;
    - `account/rateLimits/updated` → `rate-limit` only when the payload's primary or secondary window reports `usedPercent >= 100`. Record the field in the fake from the schema.
  - **Controls:**
    - `send(text)` sends `turn/start { threadId, input:[{type:"text", text}], effort }`;
    - `control("interrupt")` sends `turn/interrupt { threadId, turnId }`;
    - `control("get_context_usage")` returns `{ categories: [], totalTokens, maxTokens }`, built from the last `thread/tokenUsage/updated` and the model's context window, with `null` where Codex gives none. That's the shape `toContextUsage` reads.
  - **Approvals:**
    - the session remembers `item/started` fileChange paths by item id: both `changes[].path` and any `move_path`;
    - every server request goes to `approve`, keyed by `approvalId ?? itemId`, and is answered with its result;
    - a request still open when the session closes is answered `decline`.
- Modify: `apps/server/src/runtime/supervisor.ts`.
  - **`onEvent`** gains an `init` case. For a Codex run, it writes the thread id to `seat_sessions.cli_session_id` and `runs.session_id`, in place of the hub-made UUID.
  - **`launch()`** picks the driver by the seat's account vendor. `claude` keeps today's path exactly. For `codex`:
    - **Binary:** `deps.codexCommand ?? "codex"`.
    - **Version:** checked with `codex --version` against `CODEX_MIN_VERSION = "0.154.0"`. Older or unreadable refuses with `CANNOT_START`.
    - **Shell:** fixed to `/bin/zsh`, by setting `SHELL=/bin/zsh` in the app-server's env. The same constant feeds `codexCommand`'s word-1 check.
    - **Args:** `["app-server", "-c", 'mc_run="<runId>"']`.
    - **Env:** `CODEX_HOME=<run dir>/codex-home`, `MC_SEAT_TOKEN`, `SHELL`, and `crewEnv`'s keys without the `CLAUDE_*` ones. `TMPDIR`, the pnpm store and the Python caches point at the seat's temp dir.
    - **Run folder:** written before spawn, 0700. It holds `config.toml` from `codexSeatConfig` and `auth.json` copied from `~/.codex/auth.json` at 0600, and is removed when the run ends.
  - **`approve`** runs four checks in order:
    1. `codexApproval`;
    2. for commands, `codexCommandAllowed`;
    3. for edits, `codexEditAllowed`;
    4. then `crewGuardDecision` (`apps/server/src/guard/decision.ts`) for each event, passing `superuserTools` and `seatGrants` as `api.ts` does for the hook.

    Every refusal is recorded like a guard refusal today, with a new `GuardRule` `"codex-allowlist"` for allowlist misses. A command the guard marks as a test command awaits `lock.acquire({runId, toolUseId: approvalId ?? itemId}, …, LOCK_WAIT_MS, signal)` first. A timeout answers `decline` with `lockBusyText`; an interrupt, exit or close aborts the wait.
- Test:
  - Create `apps/server/test/fixtures/fake-codex.mjs`, a fake app-server speaking the spike's shapes. It has modes to:
    - request approval for a given command or file change;
    - send a `writeStdin` or network approval;
    - report a bad start-check field;
    - end a turn failed;
    - send `serverRequest/resolved`.
  - Create `apps/server/test/codex-session.test.ts`, and extend `supervisor-start.test.ts` and `keeper.test.ts`.

- [ ] **Write the tests**, through the fake codex driven by a test-only seat on a codex account. Config rejection is bypassed only through the harness's direct `createSupervisor` deps.
  - **Launch:** spawn args are exactly `app-server -c mc_run="<runId>"`, with no `--sandbox`. The run folder holds `config.toml` and `auth.json` at 0600. `CODEX_HOME` points at it, and the folder is gone after the run ends.
  - **Turns:** a turn's `turn/started` then `turn/completed` sets the seat `running`, then `idle`. The thread id lands in `seat_sessions.cli_session_id`.
  - **Approvals:**
    - `git commit -m x` is declined, with a guard refusal recorded;
    - `pnpm -s test` is accepted, holds the test lock and releases it at `item/completed`;
    - `writeStdin` is declined, and so is a network approval;
    - a `fileChange` outside the area is declined and one inside is accepted;
    - a rename whose `move_path` lands outside the area is declined;
    - `item/permissions/requestApproval` is declined.
  - **Start check:** each bad field fails the start with `CANNOT_START` before any `turn/start`, one case per field.
  - **Keeper:** an old `spec.json` without `turnEnd` or `marker` still attaches as Claude, and a `turn/start` error response clears `awaiting`.
- [ ] **Implement.** The controller runs the four test files outside the Codex sandbox.
- [ ] **Live check (controller):** a real `codex app-server` started by this code in a scratch repo. It must show:
  - the hub's MCP server answers one `mcp__mc__*` call (this proves `bearer_token_env_var`);
  - a denied-path read from a script fails;
  - loopback to the hub's port fails;
  - `env` shows no `MC_SEAT_TOKEN`;
  - `git commit` and `sleep 1 &` are declined.

  Record the results in the PR.
- [ ] **Commit:** `feat(#426): a Codex crew seat starts confined and reports its stream`.

### Step C: lifecycle parity (#427)

**Files:**
- Modify: `apps/server/src/runtime/supervisor.ts`, `codex-session.ts` and `store.ts`.
- Test: `supervisor-restart.test.ts`, `supervisor-events.test.ts` and `codex-session.test.ts`.

**Changes:**
- **Vendor column:** `runs.vendor` and `seat_sessions.vendor`, defaulting to `'claude'`. Resume reads `seat_sessions.cli_session_id`, which holds the thread id for Codex runs.
- **Resume, wake and the no-keeper restart:** `thread/resume { threadId, …the same overrides }` replaces `--resume`. The start check runs on the resume response too. The `RESUME_WINDOW_MS` failure rules are unchanged.
- **Reattach after a hub restart:**
  - while replaying from the keeper cursor, the session tracks each server request id and any later `serverRequest/resolved` for it;
  - once replay catches up, every request with no `resolved` after it is re-answered through `approve`, which re-takes the test lock where it applies;
  - nothing is auto-accepted.
- **Interrupt-and-send:**
  - mid-turn with `interrupt: false`, it sends `turn/steer`;
  - with `interrupt: true`, it sends `turn/interrupt` then `turn/start`;
  - between turns, `turn/start` only.
- **End, set aside and stop:** the same paths as Claude. `close()` ends stdin, and the keeper's grace and kill rules are unchanged.
- **Folding:**
  - `thread/tokenUsage/updated` folds into run tokens and `RunDigest.minuteTokens`;
  - cost is `null`, shown as "—";
  - `turn/plan/updated` is stored as the run's latest plan text for #428.

**Tests:**
- [ ] **Restart:** a Codex seat's keeper survives `stopAll`. The next hub attaches, and of two replayed approvals it answers only the one without `serverRequest/resolved`.
- [ ] **No-keeper restart:** the next hub resumes with `thread/resume` and the same thread id. The start check runs, and a bad field ends the run with a reason.
- [ ] **Steer:** a mid-turn `send` with `interrupt: false` sends `turn/steer`.
- [ ] **Interrupt-and-send:** sends `turn/interrupt`, then `turn/start`.
- [ ] **Set aside, then wake:** the thread id survives.
- [ ] **Usage:** tokens fold, and cost stays null.
- [ ] **Commit:** `feat(#427): Codex seats resume, steer, stop and survive a hub restart`.

### Step D: configuration accepts Codex seats (#427)

**Files:**
- Modify: `apps/server/src/config.ts` (`checkCrew`, ~945) and `apps/server/src/config-write.ts`.
- Test: `config.test.ts` and `config-write.test.ts`.

**Changes:**
- A seat may reference a codex account.
- A seat's `model` must suit its account's vendor.
- `effort` must be one of the model's own advertised `ReasoningEffort` values. The hub reads `model/list` once at start and caches it. A value the model doesn't list is refused.
- `updates.cli` stays Claude-only: Codex seats keep the binary they started on. Note this in `docs/runbook.md`.

**Tests:**
- [ ] A codex seat with a `gpt-*` model loads.
- [ ] A Claude model on a codex account is refused, and so is the reverse.
- [ ] An effort the model doesn't list is refused.
- [ ] A config write that pairs them wrongly answers 400.
- [ ] **Commit:** `feat(#427): configuration accepts Codex crew seats`.

**After Step D:**
- the controller runs a draft-mode trial with one Codex seat on a `chore` ticket;
- #428 (web, work lane) moves to Ready.
