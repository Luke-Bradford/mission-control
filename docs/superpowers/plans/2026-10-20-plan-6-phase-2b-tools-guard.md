# Plan 6 — Phase 2b: mc tools, the guard, the test lock

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crew seats commit, push their own branch and open a draft PR themselves, through tools Mission Control gives them, with a guard that blocks and records what they must not do. The controller stops bridging.

**Architecture:**
- **mc tools.** The hub serves an MCP endpoint on loopback (`POST /mcp`). Each seat's CLI reaches it through `--mcp-config` with a per-run bearer token, so every call is tied to one seat and one run. The hub does all git writes and `gh` calls itself, in Mission Control's own clone, after its checks.
- **Seats can no longer write git state at all.** The sandbox denies every write into the clone's and the worktree's git dirs. A commit exists only if the hub's commit tool made it, and a push sends only commits the hub recorded.
- **The guard.** A PreToolUse hook passed in the seat's `--settings` asks the hub to judge every tool call (`POST /api/guard/check`, same token). The hub denies and records what breaks a rule. The hook fails closed on any answer it doesn't recognise.
- **The test lock.** The guard takes it when a seat runs a full-suite command, and releases it when that same tool call ends. The suite runs in the seat's sandbox: the hub never runs worktree code outside the sandbox.
- **Stray changes.** The commit tool refuses paths outside the seat's area and turns them into a Needs-you `stray` item.

**Tech Stack:** As Plan 5. CLI `claude` 2.1.302. No new dependencies:
- the MCP endpoint is a small JSON-RPC handler (Task 4);
- the secret scan is built in (Task 3), since gitleaks isn't installed.

**Spec:** `docs/superpowers/specs/2026-10-18-mission-control-design.md` §4.3, §5 (mc tools, Guard, Test lock, Sessions and areas), §8b.1, §8c.
- Catalogue `docs/prototype/mission-control-hud-catalogue.md`: §2.5 (Needs you, Guard drawer), §2.7.4 (Roles, guard and test lock), §5.3, §5.5, §5.9.
- Spike records: `docs/spikes/2026-10-20-runtime-stream-json.md` ("Follow-up probes"), and Task 1's new record.
- Tech debt: #31 ("Must land with 2b").

## Scope and stated deviations

2b builds the mc tools whose other end exists:
- **commit, push, draft_pr;**
- **ask_operator:** a Needs-you question; the operator answers by messaging the seat;
- **the full suite, through the test lock.**

Deferred:
- `ask_flight` and `propose_write` arrive with FLIGHT (phase 3);
- `message_agent` arrives with the mailbox (2d);
- `report_evidence` arrives with the loop engine (2c).

Deviations, each deliberate:
- **The full suite (catalogue §2.7.4, §5.5).**
  - The catalogue says Mission Control "runs full suites itself".
  - Here, a seat typing a full-suite command waits for the lock, then runs it in its own sandbox. A hub-run suite would execute agent-written test code outside the sandbox.
  - 2c's `cmd` checks need the same sandboxed runner.
- **ask_operator (spec §5, catalogue §5.4 #54).** The spec gives it to FLIGHT only, and has agents ask "through FLIGHT". FLIGHT doesn't exist yet, so every seat gets it until phase 3 routes it through FLIGHT.
- **Needs-you actions (catalogue §2.5).** stray → [Ack], not [Ask FLIGHT]. question → [Open], to reply from the Agent page, not [Answer]. lock → [Open], not [Stop the run]; Stop the run waits for 2c.
- **Repo permission levels (spec §8c).** They are not built in 2b: there is still only one repo with crew. `GuardContext` carries a `repo` field (only `"dev"` for now), so the levels slot in without reshaping the guard.
- **Push and PR text.** The push/PR workflow is the mc tools' job in 2b. Per spec §8b.1 it moves to the loop engine in 2c, and the role briefs keep it out of their "how you work" rules.

## Global Constraints

- **Everything in Plans 3–5 still holds.**
  - Live loops are observed only.
  - Previews run no crew.
  - Transcript and GitHub text is rendered inert.
  - Constants are defined once in `@mc/core`.
  - TypeScript is erasable only.
  - Every new route goes in the route table, with a zod body (400 `{ error }`).
- **The GitHub writes 2b allows, exactly:**
  1. A plain (never forced) fast-forward push of a run's own branch, the one `branchFor` gave it, from Mission Control's clone. It sends only commits the hub's commit tool made for that run, never to the default branch, and never to another run's branch.
  2. One draft PR per run for that branch, with no `@mention` and no cross-repo reference in its text.

  Nothing else: no comments, labels, board moves, marking ready, or merging. The PR's security note says so.
- **Tokens.**
  - A per-run token (32 random bytes, hex) authorises mc tool calls and guard checks.
  - It lives in hub memory, keyed by its SHA-256, and in two files in `{DB dir}/crew/`: written atomically at mode 0600, read-denied to the sandbox, and removed when the run's process exits.
  - It never appears in env, argv, logs, transcripts, responses or guard-hit text.
  - A resumed process gets a new token.
- **The guard never fails open.** The hook treats anything but an HTTP 200 carrying `{}` or the recorded deny shape as a deny. It exits 2 on any failure of its own. It has its own deadline, shorter than the CLI's hook timeout. It runs with a stable node path (`crew.node`, default `/opt/homebrew/bin/node`, never a Cellar path).
- **No worktree code runs outside the sandbox.** The hub runs only `git` (through `crewGit`: hooks off, fsmonitor off, no replace refs, git dirs verified, `-c commit.gpgsign=false`) and `gh` there.
- **Path rules are anchored to the worktree** (`//<worktree>/<glob>`, #41/#42), with Bash pinned to the worktree root (`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`).
- **Body limits are per route.** The hub's global `bodyLimit` (16 KiB) stays. `/api/guard/check` gets 64 KiB and `/mcp` gets 256 KiB.
- **Tests never spawn the real `claude` and never bind a port** (`app.inject()`). Child processes a test starts have a lifetime cap and are cleaned up in `finally`. The test has an explicit timeout above the cleanup's.
- **Checks before each task's commit:** `pnpm -s lint`, `pnpm -s typecheck`, `pnpm -s test` and `pnpm -s build`, one at a time, each followed by `echo "exit=$?"`. Never pipe them into `tail`.

## Review Focus

1. **The guard never fails open.**
   - Cases: the hub answers 401, 413 or 500 with a JSON body; the hook crashes; node is missing; the hook's deadline passes; the stdout is invalid.
   - Expected: a deny every time, and the tool does not run. → Tasks 1, 5.
2. **Only hub-made commits leave the machine.**
   - Cases:
     - sandboxed code tries `git commit`, `git update-ref` or writing `.git/objects` (refused by the sandbox);
     - the branch tip isn't the last commit the hub recorded;
     - a merge commit;
     - origin's branch moved;
     - the push is cut off and retried.
   - Expected: the push is refused with its fixed text, or a retry finds origin already at the sha and reports success. Never forced. → Tasks 6, 8, 9.
3. **The test lock under real tool-call shapes.**
   - Cases: two seats at once; parallel Bash calls in one seat; a failing suite or an interrupt; a `run_in_background` suite; a lock granted to a call the CLI then refuses; a hook killed while waiting; the holder re-entering.
   - Expected: FIFO; release paired by `tool_use_id`, with failure paths releasing too; a background suite denied; a phantom waiter dropped; the holder's re-entry granted. → Tasks 1, 5.
4. **The secret scan sees everything that leaves.**
   - Cases: a token in a file under `* -diff` attributes; in a commit message; in a commit later reverted; in the PR title or body; a quoted path.
   - Expected: found, and the push or PR refused. → Tasks 3, 9.
5. **A commit with paths it must not have.**
   - Cases: outside the area; inside another writer's area; a protected file; a rename out of the area; a file changed between status and add; nothing to commit.
   - Expected: refused with an accurate text for each kind, the index reset, strays recorded with the right text, nothing committed. → Task 8.

---

### Task 1: Spike — the hook, MCP over HTTP, and the sandbox without git writes

Everything later rests on facts no record has yet. Check them on the real CLI first (haiku, scratch clone under `/private/tmp/claude-501/mc-plan6-build/`, the hub's own `crewCliArgs`).

**Files:**
- Create: `docs/spikes/2026-10-21-mc-tools-guard.md`.
- Scratch only: a tiny Node MCP server (`initialize`, `tools/list` with one tool `echo`, `tools/call`, and a slow tool that sleeps 90 s), and a hook script that logs its stdin and answers from a scripted table.

- [ ] **Step 1: MCP over HTTP.** Run with `--mcp-config` (`{"mcpServers":{"mc":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <t>"}}}}`) and `mcp__mc__echo` in `--allowedTools`. Record:
  - whether `--restricted` honours `--mcp-config`, and `system/init`'s server status;
  - the tool's name as the model sees it, and the header arriving;
  - the `protocolVersion` sent;
  - what a 401 does;
  - the CLI's MCP tool-call timeout (using the slow tool);
  - whether the token appears in `system/init`, the transcript, `~/.claude` session files or MCP logs.
- [ ] **Step 2: Hooks.** Add a `PreToolUse` (matcher `*`) and a `PostToolUse` plus `PostToolUseFailure` (matcher `Bash`) hook to the `--settings` JSON. Record:
  - **When they fire:** under `--restricted`; for Bash, Edit, Write and an MCP tool.
  - **The stdin shape,** including `tool_use_id` and `tool_response` sizes for a 1 MB Write and a long Bash.
  - **The exact deny form honoured:** the `hookSpecificOutput.permissionDecision` deny vs exit code 2.
  - **What the CLI does on:** a non-zero exit other than 2, a crash, command not found, invalid stdout, and its own hook timeout. Any of these allowing the tool is a gate failure for Task 5's design: note it.
  - **Ordering:** whether PreToolUse runs before the allow and deny rules, and whether an empty `{}` lets the rules still apply (a granted lock must not override `--disallowedTools`).
  - **Post on the awkward paths:** a failing command, an interrupt during the command, a Bash timeout, and `run_in_background: true`.
  - **An interrupt while the hook is waiting:** is the hook killed?
  - **The largest hook `timeout` honoured,** and whether a hook that holds an HTTP request open for 6 minutes with Node's `fetch` is cut off by fetch's own headers timeout. Compare with `node:http`.
  - **A call the hook allowed that the CLI then refuses** (e.g. `pnpm test` with no allow rule): does any event (`PermissionDenied` or a Post) follow?
  - **Reach:** that the hook process can reach `127.0.0.1:<port>` and read a 0600 file in the data dir, i.e. that it runs outside the sandbox. Also its env.
- [ ] **Step 3: The sandbox without git writes.** Give the seat a sandbox with no `allowWrite` into git dirs, and `denyWrite` on the clone's whole `.git` and the worktree's git dir. Record:
  - that `git status`, `git diff` and `git log` still work from sandboxed Bash;
  - that a full `pnpm -s test` still works;
  - that sandboxed `git commit`, `git update-ref`, a write under `.git/objects`, and creating `<worktree git dir>/config.worktree` (#31's item) all fail.
- [ ] **Step 4: Write the record and apply the gate.** If any of these fails, stop and report NEEDS_CONTEXT:
  - hooks fire under `--restricted`;
  - some deny form blocks the tool;
  - every hook failure mode in Step 2 (crash, non-2 exit, command not found, invalid stdout, timeout) blocks the tool, or there is a recorded way to make it block;
  - the hook runs outside the sandbox;
  - `--mcp-config` works with a header;
  - git reads work without git-dir writes.
- [ ] **Step 5: Commit** `docs: spike — mc tools over MCP HTTP, the guard hook, a sandbox without git writes`.

### Task 2: Sandbox escape probe

The operator gave the go-ahead (2026-10-20). Scratch only. Never touch any other launchd label.

- [ ] **Step 1: Probe from sandboxed seat code** (through `pnpm -s test`):
  - `launchctl submit -l mc.probe.escape -- /usr/bin/touch <scratch outside allowWrite>/canary`, then `launchctl remove mc.probe.escape`;
  - `osascript -e 'do shell script "touch <scratch>/canary2"'`;
  - `open -g <scratch>/x.command`, with a script that touches canary3.
- [ ] **Step 2: Record it** in the Task 1 record. If any canary appears, that is Critical: stop and bring it to the operator before any later task merges. A typed `launchctl` is already refused by the allowlist, so a deny-list entry alone would not fix it.
- [ ] **Step 3: Commit** `docs: sandbox escape probe`.

### Task 3: Guard rules, the full-suite matcher and the secret scan (core, pure)

**Files:**
- Create: `packages/core/src/guard.ts`.
- Modify: `packages/core/src/index.ts`, `packages/core/src/types.ts` (the `Topic` union gains `"guard"`), `packages/core/src/topics.ts`, `apps/server/src/config.ts` (`repos[].full_suite?: string[]`, default `[]`; `crew.node?: string`, default `/opt/homebrew/bin/node`), `config.example.yaml`.
- Test: `packages/core/test/guard.test.ts`, `apps/server/test/config.test.ts`.

**Interfaces (Produces):**
- `GUARD_RULES`: id → text. The texts follow catalogue §2.7.4.
  - `git-write`: "git writes only through the mc commit, push and draft-PR tools"
  - `github-write`: "No GitHub comments, labels, board moves or Priority changes without your approval"
  - `merge-push`: "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode"
  - `full-suite`: "Full test suites only through Mission Control (one at a time)"
  - `read-only`: "Read-only roles cannot write"
  - `network`: "No network from a crew's commands"
  - `secret`: "No secrets in a push"
- `type GuardRule = keyof typeof GUARD_RULES`
- `interface GuardHit { id: number; agentId: string; runId: string | null; rule: GuardRule; text: string; at: number }`. `text` is the rule's own text plus the program and subcommand only (e.g. `git push`), never raw argv.
- `interface GuardEvent { tool: string; input: { command?: string; file_path?: string; run_in_background?: boolean } }`
- `interface GuardContext { mode: "writer" | "read-only"; repo: "dev"; fullSuite: readonly string[] }`
- `type GuardVerdict = { kind: "allow" } | { kind: "lock"; command: string } | { kind: "deny"; rule: GuardRule; text: string }`
- `guardDecision(e, ctx): GuardVerdict`. It denies:
  - **git-write:** the git write subcommands, with every spelling in `splitCommands`.
  - **github-write:** `gh` writes.
  - **network:** curl and wget.
  - **read-only:** for a read-only seat, `Edit`, `Write`, `NotebookEdit` and the writer mc tools.
  - **full-suite:**
    - a full-suite command in read-only mode;
    - a full-suite command with `run_in_background: true`, with text `Run the full suite in the foreground: it holds the test lock.`
  - Any other full-suite command → `lock`.
- `splitCommands(cmd: string): string[][]`. It splits on newlines and `; && || |`, and respects single and double quotes (no expansion). It drops leading `NAME=value` words and the wrappers `env`, `command`, `exec`, `time`, `nohup` and `sudo`. It takes the basename of an absolute program path.
- `isFullSuite(argv, fullSuite): boolean`: argv starts with an entry's words, and everything after is a flag.
- `FREE_SUITE_HINT = "the same command with a test file path"`
- `SECRET_KINDS = ["GitHub token", "Anthropic key", "AWS access key", "private key", "Slack token", "local credential"] as const`
- `interface SecretFinding { where: string; line: number; kind: (typeof SECRET_KINDS)[number] }`
- `scanSecrets(text: string, known: readonly string[]): SecretFinding[]`
  - **Input:** `git log -p --text --no-textconv --no-ext-diff --format=%x00commit %H%n%B` output.
  - **What it scans:** added lines (`+`, not `+++`), with `where` = the file and `line` from the hunk header, plus each commit message (`where` = `commit <sha7>`).
  - **Paths:** `+++ "b/…"` quoting and `/dev/null` are handled.
  - **Patterns:** GitHub `gh[pousr]_[A-Za-z0-9]{36,}` and `github_pat_[A-Za-z0-9_]{60,}`; Anthropic `sk-ant-[A-Za-z0-9_-]{20,}`; AWS `AKIA[0-9A-Z]{16}`; `-----BEGIN [A-Z ]*PRIVATE KEY-----`; Slack `xox[abposr]-[A-Za-z0-9-]{10,}`. Plus every `known` string of length ≥ 16, as an exact substring.
  - Findings never contain the match.
- `scanText(where: string, text: string, known): SecretFinding[]` for the PR title and body.
- `config.example.yaml`: mission-control's `full_suite` is `["pnpm -s test", "pnpm -s vitest run", "pnpm -s vitest"]`.
- The config loader refuses a `full_suite` entry that no `WRITER_TOOLS` Bash pattern allows: `repos[{i}].full_suite: {cmd} is not a command crew seats may run`. Otherwise the guard could grant the lock to a call the CLI then refuses. It also refuses a `crew.node` that isn't an executable file.

- [ ] **Step 1: Write failing tests:**
  - **git-write:** each of `git -C . push`, `/usr/bin/git commit -m x`, `FOO=1 git push`, `env git push`, `cd apps && git push`, two lines, `git -c user.name=x commit`, `git commit`, `git add`, `git merge`, `git rebase`, `git reset --hard`, `git tag x`, `git update-ref`, `git branch -D x`, `git checkout -b x`, `git switch -c x`, `git cherry-pick`, `git stash`, `git worktree add`, `git config x y`, `git remote add`, `git fetch` and `git pull` → deny `git-write`.
  - **Allowed reads:** `git status`, `diff`, `log --oneline`, `show HEAD`, `branch` and `branch --list`.
  - **gh:** writes → deny `github-write`; `gh pr view` and `gh api repos/x/y` → allow.
  - **Network:** curl and wget → deny.
  - **Full suite:** `pnpm -s vitest run` with no path → lock, and with a path → allow. A background suite → deny. A suite in read-only mode → deny.
  - **Read-only mode:** `Edit`, `Write`, `NotebookEdit`, `mcp__mc__commit`, `mcp__mc__push` and `mcp__mc__draft_pr` → deny. `mcp__mc__ask_operator` → allow.
  - **scanSecrets:**
    - a token on an added line, with the right `where` and line;
    - none on a removed line;
    - a token in a commit message;
    - a known 40-character secret, but not an 8-character one;
    - quoted and `/dev/null` paths;
    - no finding's JSON contains the match.
  - **Config:** the `full_suite` and `node` defaults; a `full_suite` entry outside the allowlist refused; a missing `crew.node` refused.
  - **merge-push:** has no Bash command of its own; it is the hub-side refusal text for a push of another branch, recorded in Task 9. One test row asserts the text.
- [ ] **Step 2–4:** Run the tests and see them fail, implement, then run the full checks. **Commit** `feat(core): guard rules, the full-suite matcher and the secret scan`.

### Task 4: The MCP endpoint and per-run tokens

**Files:**
- Create: `apps/server/src/mcp/tokens.ts`, `apps/server/src/mcp/server.ts`.
- Modify: `apps/server/src/api.ts` (`AppDeps` gains `tokens: RunTokens`, `mcpTools: () => McTool[]`, `seatMode(seatId): "writer" | "read-only"`), `apps/server/src/main.ts` (it constructs `RunTokens` and passes it to `buildApp` and `createSupervisor`).
- Test: `apps/server/test/mcp.test.ts`.

**Interfaces (Produces):**
- `RunTokens`:
  - `issue(seatId, runId): string`
  - `resolve(token): { seatId; runId } | null`: a SHA-256 map lookup, then a constant-time compare
  - `revoke(runId): void`
- `interface McToolContext { seatId: string; runId: string }`
- `interface McTool { name; description; inputSchema: object; writer: boolean; call(ctx, args: unknown): Promise<{ text: string; isError?: boolean }> }`
- `registerMcp(app, deps)`: `POST /mcp` with `bodyLimit` 256 KiB, JSON-RPC 2.0, stateless, JSON replies.
  - **initialize:** answers the client's `protocolVersion` when it is one Task 1 recorded, else the newest of those. `capabilities: { tools: {} }`, `serverInfo: { name: "mc", version: "1" }`.
  - **notifications/initialized:** 202, no body.
  - **ping.**
  - **tools/list:** a read-only seat sees only non-`writer` tools.
  - **tools/call:** argument and tool errors come back as `{ isError: true }` results.
  - **Calls are serialised per run**, one at a time.
  - **Auth:** no or unknown token → 401 `{ error: "unknown run" }`.
  - **Errors:** unknown method → `-32601`; `GET /mcp` → 405.

- [ ] **Step 1: Write failing tests:**
  - the handshake, including an unknown version;
  - tools/list by mode;
  - a call reaching a fake tool with its context;
  - two concurrent calls run in order;
  - a revoked token → 401;
  - a bad body → 400;
  - a 200 KiB call accepted;
  - the route-table entry;
  - no token in any response.
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(server): the mc MCP endpoint with per-run tokens`.

### Task 5: The guard route, the hook and the test lock

**Files:**
- Create: `apps/server/src/guard/lock.ts`, `apps/server/src/guard/hook.ts`.
- Modify: `apps/server/src/api.ts` (`AppDeps` gains `lock: TestLock`), `apps/server/src/main.ts`, `apps/server/src/store.ts`.
- Test: `apps/server/test/guard.test.ts`, `apps/server/test/store.test.ts`.

**Interfaces:**
- Consumes: Task 3 and Task 4.
- Produces:
  - **The store table and methods.**
    - `guard_hits(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, run_id TEXT, rule TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`, with an index on `at`.
    - `addGuardHit(h)`, `guardHits(sinceMs): GuardHit[]` and `guardHitCounts(sinceMs)`.
    - Each hit publishes the `guard` topic.
  - **`TestLock`.**
    - `acquire(key: { runId; toolUseId }, seatId, command, waitMs, signal: AbortSignal): Promise<boolean>`: FIFO, one holder. It resolves false after `waitMs`. An aborted waiter is dropped, and a grant to an aborted waiter is released at once. The holder's own run re-entering is granted.
    - `release(key)`, `releaseRun(runId)`, and `state(): { holder: { runId; seatId; command; since } | null; waiting: { runId; seatId; since }[] }`.
  - **Constants:**
    - `LOCK_WAIT_MS` = Task 1's largest hook timeout minus 60 s, at most 10 min;
    - `GUARD_HOOK_TIMEOUT_S` = `LOCK_WAIT_MS / 1000 + 30`;
    - `HOOK_DEADLINE_MS` = `GUARD_HOOK_TIMEOUT_S * 1000 − 10_000`.
  - **`POST /api/guard/check`**, `bodyLimit` 64 KiB, bearer token. The body is `{ hook_event_name, tool_name, tool_use_id, tool_input: { command?, file_path?, run_in_background? } }`; the hook sends only these.
    - **PreToolUse:**
      - `deny`: record the hit and answer the deny form Task 1 recorded;
      - `lock`: `acquire`. The abort signal fires on `reply.raw.on("close")` when `!reply.raw.writableEnded`, i.e. the hook hung up. It never fires on the request's own `close`, which fires when the body has been read. Granted → `{}`. Not granted → deny with `The test lock is busy: {CALL} is running {command}. Run {FREE_SUITE_HINT}, or the full suite later.`, not recorded as a hit;
      - `allow`: `{}`.
    - **PostToolUse and PostToolUseFailure** (as Task 1 recorded): release by `{ runId, toolUseId }`.
  - **`GET /api/test-lock`** and **`GET /api/guard/hits?days=7`.**
  - **`hook.ts`.**
    - `hookMain(stdin: string, argv: [tokenFile, url], post: (url, token, body) => Promise<{ status: number; body: string }>): Promise<{ out: string; exit: 0 | 2 }>`.
    - Only status 200 with a body of `{}` or the recorded deny shape passes through. Everything else gives `{ out: <deny with "Mission Control's guard is unreachable; nothing runs until it is back.">, exit: 2 }`.
    - The top level posts with `node:http`, never `fetch`, whose own headers and body timeouts would cut a long lock wait short. It sets no timeout except `HOOK_DEADLINE_MS`. It catches everything, prints `out` and exits with `exit`.

- [ ] **Step 1: Write failing tests:**
  - each verdict through the route, and a deny recorded once, with the hit text holding no argv beyond program and subcommand;
  - lock FIFO across two runs;
  - parallel Bash calls in one run: only the matching `tool_use_id` releases;
  - PostToolUseFailure releases;
  - an aborted waiter is dropped, and a late grant is released, both via `TestLock` and at the route (a request whose reply's socket closes before an answer);
  - a Bash call over 64 KiB → `hookMain` checks the size before posting and answers its own deny, `That command is too long for the guard to check; split it.` (exit 0, since this is a decision), so the route's 413 is never what decides. The test lives with `hookMain`;
  - the holder re-enters;
  - `releaseRun` drops its queue;
  - `hookMain` against 401, 413 and 500 JSON bodies, a throwing post, a non-JSON body, a missing token file and the deadline → deny with exit 2;
  - a 1 MB Write's PreToolUse becomes a small request;
  - the counts by rule over 7 days.
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(server): the guard route, its hook and the test lock`.

### Task 6: Seats start with the tools, the guard, and no git writes

**Files:**
- Modify: `packages/core/src/runtime.ts`, `apps/server/src/runtime/supervisor.ts` (`SupervisorDeps` gains `tokens`, `lock`, `hubPort`, `hubRoot`), `apps/server/src/main.ts`, `apps/server/src/store.ts` (`crewMcpPath`, `crewTokenPath`), `apps/server/src/runtime/brief.ts` (`ticketBrief`), `roles/GUIDO.md`, `roles/INCO.md`, `roles/RETRO.md`, `docs/runbook.md`.
- Test: `packages/core/test/runtime.test.ts`, `apps/server/test/supervisor.test.ts`, `apps/server/test/brief.test.ts`.

**Interfaces:**
- **`CrewCliInput`** gains `mcpConfigFile: string` and `hook: { command: string; timeoutS: number }`.
  - `crewCliArgs` adds `--mcp-config <file>`.
  - `crewSandboxSettings(i: CrewSandboxInput, mode, hook)` writes the hooks block in Task 1's shape.
  - The hook command is `"<crew.node>" --experimental-strip-types "<hub root>/apps/server/src/guard/hook.ts" "<token file>" "http://127.0.0.1:<port>/api/guard/check"`. Each part is single-quoted, and the supervisor refuses to start if a path holds `'` or a newline.
- **The sandbox.**
  - It loses every `allowWrite` entry under the clone's git dir and the worktree's git dir.
  - `denyWrite` gains the clone's whole `.git` and the worktree's git dir. The file-level entries inside those go, now that they're covered. The worktree's own `.git` pointer file (`<worktree>/.git`) stays in `denyWrite`.
  - This closes #31's R19/R24 and the unverified `config.worktree` item.
- **The allowlist.**
  - `WRITER_TOOLS` loses `Bash(git add:*)` and `Bash(git commit:*)`, and gains `mcp__mc__commit`, `mcp__mc__push`, `mcp__mc__draft_pr` and `mcp__mc__ask_operator` (names as Task 1 recorded).
  - `READONLY_TOOLS` gains `mcp__mc__ask_operator`.
  - `DENIED_TOOLS` gains `Bash(git add:*)` and `Bash(git commit:*)`.
  - `PROTECTED_FILES` gains `.gitattributes`.
- **Supervisor `launch`.**
  - It issues a token, then writes the token file and the `.mcp.json` atomically at 0600.
  - On the process's exit, for any reason: revoke, `lock.releaseRun`, and remove both files.
  - A resume gets a new token.
- **Texts.**
  - **`ticketBrief`'s closing sentence** depends on the mode. It replaces `Commit locally with clear messages; do not push, open PRs or comment on GitHub. When your checks pass, reply with a short summary that starts with DONE.`
    - **Writer:** `Commit with the mc commit tool, never git. When the ticket's "Done when" holds, push with mc push and open a draft PR with mc draft_pr, then reply with a short summary that starts with DONE. Ask the operator with mc ask_operator only for a decision you cannot make; carry on with what you can.`
    - **Read-only:** `You read and report; you cannot commit, push or open PRs. Ask the operator with mc ask_operator if you need a decision. Reply with your findings, starting with DONE.`
    - `DONE` stays: nothing parses it yet, but 2c's checks read the reply.
  - **GUIDO.md and INCO.md:** the paragraph under "What you may not do" becomes `Commit, push and open draft PRs only through the mc tools; git writes in Bash are refused. Never comment on GitHub, label, or move board cards. You have no network access and no gh.`
  - **RETRO.md:** the paragraph becomes `Do not commit, push, open PRs or comment on GitHub; you have no tools for them, no network access and no gh. End with your findings list, ordered by severity.`

- [ ] **Step 1: Write failing tests:**
  - the argv carries `--mcp-config`;
  - the settings carry the hook with the token *file*, never a token;
  - no git-dir path in `allowWrite`, and the clone's `.git` in `denyWrite`;
  - the allowlist changes;
  - the files are 0600, and gone after exit;
  - a fake-CLI exit revokes and releases;
  - a resume issues a new token;
  - the ticket brief's sentence for each mode, and the three role paragraphs.
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(server): seats start with the mc tools and the guard, and cannot write git state`.

### Task 7: Confine Bash-run reads; CLAUDE.md from the base

**Files:**
- Modify: `packages/core/src/runtime.ts` (`CrewSandboxInput.denyRead: string[]`), `apps/server/src/runtime/supervisor.ts`, `apps/server/src/runtime/brief.ts`, `apps/server/src/config.ts` (`crew.deny_read?: string[]`), `config.example.yaml`, `docs/runbook.md`.
- Test: `packages/core/test/runtime.test.ts`, `apps/server/test/supervisor.test.ts`, `apps/server/test/brief.test.ts`, `apps/server/test/config.test.ts`.

**Interfaces:**
- **Sandbox `denyRead` gains,** deduped, in this order:
  - the hub's checkout;
  - every loop's `worktree`, `state_dir` and `logs_dir`;
  - every other crew session's checkout;
  - `crew.deny_read`.
- **The config loader** expands `~`, requires absolute paths, and refuses a `crew.deny_read` entry that equals or contains `crew.worktrees`, any session checkout, or the temp dir (`os.tmpdir()`). The error is `crew.deny_read: {path} holds the crew's own folders`.
- **`readRepoClaudeMd`** reads `CLAUDE.md` from the base commit's tree through the hash-verified reader that `checkouts.ts` uses for install inputs. It returns null when there is none.
- **The runbook** asks the operator to list their working folders under `crew.deny_read`. It states the residual: other app data under `~/Library` (browser profiles, Application Support) stays readable to agent-run code, and the push-time scan is the backstop.

- [ ] **Step 1: Write failing tests:**
  - denyRead for a config with two loops and two sessions;
  - the loader refuses `~/code` when the worktrees live under it;
  - an edited worktree CLAUDE.md does not reach the prompt;
  - CLAUDE.md absent at the base → null.
- [ ] **Step 2: Real-CLI checks** (haiku, scratch), recorded in the Task 1 record:
  - sandboxed code can't read a `crew.deny_read` folder, and can still read its worktree;
  - **the data-protection keychain (#31):** a `swiftc`-built probe calls `SecItemCopyMatching` with `kSecUseDataProtectionKeychain` for a service that doesn't exist. Record the status: `-25300` = reachable, `-34018` = no entitlement, a denial = blocked. Never query a real item.
- [ ] **Step 3–4:** Implement, then run the full checks. **Commit** `feat: confine crew reads to granted folders; CLAUDE.md from the base`.

### Task 8: mc commit, stray changes and ask_operator

**Files:**
- Create: `apps/server/src/mcp/tools.ts`.
- Modify: `apps/server/src/main.ts` and `apps/server/src/api.ts` (register the tools as `mcpTools`; pass `lock.state()` into `crew()` and `attentionItems`), `apps/server/src/store.ts`, `apps/server/src/hud.ts` (`attentionItems`), `apps/server/src/runtime/git.ts` (`CrewGitOptions.env?: NodeJS.ProcessEnv`, merged after the safe env), `apps/server/src/runtime/supervisor.ts` (a message marks questions answered).
- Test: `apps/server/test/mcp-tools.test.ts`, `apps/server/test/hud.test.ts`.

**Interfaces:**
- **Store.**
  - `run_commits(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, repo_id TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (run_id, sha))`, with `addRunCommit`.
    - `runCommits(runId): string[]`, in `id` order.
    - `branchCommits(repoId, branch): Set<string>`: every commit any run made on that branch. A later run on the same ticket reuses the branch, and its earlier, unpushed hub commits must still count.
  - `strays(key TEXT PRIMARY KEY, session_id, path, agent_id, kind TEXT, at)`. `key` = `stray:` + the first 16 hex characters of SHA-256 of `session\0path`. `kind` is `outside` or `other-area`. Methods: `addStrays`, `strays()`, and `clearStrays(sessionId, paths)`, which runs on a later commit that includes or reverts the path, and at run end for that run's strays.
  - `seat_questions(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id, run_id, text, at, answered_at)`, with `addQuestion`, `openQuestions()` and `answerQuestions(agentId, at)`. A run's open questions close when the run ends.
  - `crew_errors(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id, run_id, text, at, acked INTEGER DEFAULT 0)`.
- **`commit {message: string 1..2000}`** (writer). Inside the session clone's `inClone` queue:
  1. **The branch:** `symbolic-ref HEAD` must be `refs/heads/<run branch>`, else refuse with `Not committed: your worktree is not on {branch}.`
  2. Run `add -A`.
  3. **The paths:** read `diff --cached -z --name-status -M HEAD`, with both sides of a rename.
  4. **Nothing staged** → `Nothing to commit.`
  5. **Paths it must not have.** Any path outside the seat's area, inside another writer's area, or matching `PROTECTED_FILES`:
     - `reset -q` (unstage), refuse, and record each non-protected path as a stray of its kind;
     - name at most 10 paths per group, then "and {n} more";
     - the texts, each group on its own line:
       - `Not committed: {paths} {is|are} outside your area ({globs}).`
       - `Not committed: {paths} {is|are} in {CALL}'s area.`
       - `Not committed: {paths} {is|are} protected (build, install and CI files); ask the operator if the ticket needs {it|them}.`
       - then `Revert what you didn't mean to change.`
  6. **Otherwise** `commit -m <message>`, with `env` = the run's author names, then `addRunCommit`. Answer `Committed {sha7} on {branch}: {subject}`.
- **`ask_operator {question: string 1..2000}`** (any mode): record it, then answer `Asked the operator. The answer arrives as a message; carry on with what you can meanwhile.`
- **`attentionItems` adds:**
  - strays: `{path} changed in s/{session} outside every agent's area`, or `{path} changed in s/{session} inside {CALL}'s area`;
  - `ask:{id}` questions: `{CALL} asks: {text}`;
  - unacked `crew_errors` (kind `error`);
  - the `lock` item: `{CALLs} waiting for the test lock, held by a stalled run ({holder})`.
  - **A waiting seat** is shown as `waiting for the test lock`, not Stalled.

- [ ] **Step 1: Write failing tests** against a temp clone and worktree:
  - every Review Focus 5 case, with each text;
  - a path changed between status and add (refused, index reset);
  - HEAD moved off the branch;
  - a normal commit, with the author and a `run_commits` row;
  - strays cleared on the revert commit;
  - questions open and close;
  - `crew_errors` items.
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(server): mc commit with stray detection, and ask_operator`.

### Task 9: mc push and mc draft_pr

**Files:**
- Modify: `apps/server/src/mcp/tools.ts`, `apps/server/src/store.ts` (`run_pushes(run_id TEXT PRIMARY KEY, sha TEXT, at INTEGER)`), `apps/server/src/api.ts` / `main.ts` (`deps.gh`; env `MC_GH_COMMAND` is honoured only by a preview started with `MC_CREW=1`).
- Test: `apps/server/test/mcp-tools.test.ts`.

**Interfaces:**
- **`push {}`** (writer). Inside `inClone`, with `CREW_GIT_SLOW_MS` timeouts. The order is fixed, and each step has its fixed refusal:
  1. **The remote tip** comes from `ls-remote origin refs/heads/<branch>` (it may be absent). The branch tip is `<sha>` (`rev-parse refs/heads/<branch>`).
     - `<sha>` equals the remote tip → record `run_pushes`, then answer `Already on origin: {sha7}.` This recovers a push cut off by a restart, and a reused branch with nothing new.
     - The remote tip exists and is not an ancestor of `<sha>` → `Not pushed: origin's {branch} has commits this run doesn't have.`
  2. **The new commits** are `rev-list <sha> --not origin/<default> <remote tip, if any>`. These are exactly what this push sends. If there are none → `Nothing to push.`
  3. **Every new commit** is in `branchCommits(repo, branch)` and has exactly one parent. Commits already on origin, from an earlier run or from the operator, are not re-checked.
     - Not all hub-made → `Not pushed: your branch has commits the commit tool didn't make.`, plus a `crew_errors` row.
     - A merge commit → `Not pushed: merge commits can't be pushed.`
  4. **`fsck --no-dangling --no-progress`** passes. If not → `Not pushed: the clone failed an object check. The operator has been told.`, plus a `crew_errors` row.
  5. **`scanSecrets`** over `git log -p --text --no-textconv --no-ext-diff --format=…` for exactly those new commits finds nothing.
     - `known` = `githubToken()` and the Claude OAuth token, read for this push and never logged.
     - On a finding → `Not pushed: {where}:{line} looks like a {kind}. Remove it from the branch's history, then push again.`, plus a hit with rule `secret`.
  6. **`push --porcelain --no-follow-tags --no-recurse-submodules origin <sha>:refs/heads/<branch>`.** No lease and no `+`.
     - A non-fast-forward is refused by git and answered with the step 1 text.
     - A branch that isn't the run's own → `Not pushed: {GUARD_RULES["merge-push"]}`, plus a hit with rule `merge-push`. This can't come from a tool argument: push takes none. It guards the supervisor's own state.
     - On success, record `run_pushes` and answer `Pushed {sha7} to {branch}.`
- **`draft_pr {title: 1..200, body: 1..20000}`** (writer).
  - It needs `run_pushes` for the run, equal to the branch tip. If not → `Push first: the PR shows what is on origin.`
  - `scanText` on the title and body. On a finding → refuse as in push.
  - A mention or cross-repo reference outside code spans and code blocks → `Not opened: mentions and cross-repo references notify people; remove {first one}.`
    - A mention is `@` + a GitHub login (`[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`), not preceded by a word character, `.` or `/`, and not followed by `/`. So `@mc/core` and `operator@example.com` pass.
    - A cross-repo reference is `<owner>/<repo>#<n>`, or a URL to another repo's issue or PR.
  - An open PR for the branch (`gh pr list --repo <github> --head <branch> --state open --json url`) → `A PR is already open: {url}`.
  - Otherwise `gh pr create --repo <github> --draft --head <branch> --base <default> --title=<title> --body-file <0600 temp file in crew/>`.
    - It runs in `crew/`, with `GH_PROMPT_DISABLED=1`.
    - The body gets `Closes #{issue}.` when it has no `#{issue}`, and ends with `Opened by {CALL} (Mission Control).`
    - The temp file is removed after.
  - It answers with the URL.

- [ ] **Step 1: Write failing tests** with a local bare repo as origin and a fake `gh`:
  - every Review Focus 2 and 4 case;
  - a normal push, then the PR;
  - "Already on origin" after a simulated cut-off;
  - a token under `* -diff`;
  - a token in a commit message;
  - a token in the PR body;
  - a mention refused; `@mc/core`, an email address, and a mention inside a code span or code block pass;
  - a second run on a ticket whose branch is already on origin with an earlier run's commits pushes only its own;
  - run A commits and ends unpushed, then run B commits: B's push sends both;
  - a second PR;
  - nothing logged holds a known secret (spy on the logger).
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(server): mc push (hub commits only, plain fast-forward, secret scan) and mc draft_pr`.

### Task 10: The HUD — guard drawer, test lock, Needs you

**Files:**
- Modify: `apps/web/src/comms/NeedsList.tsx` (`#cGuard`), `apps/web/src/setup/Roles.tsx`, `apps/web/src/shell/Header.tsx` (the `Lock: —` line) and the Overview Machine lock box, `apps/web/src/data.ts`, `packages/core/src/runtime.ts` (`CREW_FILES_NOTE` → `Files for crew seats arrive with the mailbox (phase 2d).`).
- Test: `apps/web/test/Comms.test.tsx`, `apps/web/test/Setup.test.tsx`, `apps/web/test/Overview.test.tsx`, `apps/web/test/Header.test.tsx`.

**Copy (catalogue §2.5, §2.7.4, §5.5):**
- **Guard drawer** (`<details id="cGuard">`).
  - Summary: `Guard: {n} blocked command(s){, m new} (for information)`.
  - Rows: ⊘ · agent tag · text · `{time} · rule: {id}` · [Ack]. The ack key is `guard:{id}`. Acks persist for the 7-day window; the ack prune is fine.
  - Empty: `Guard: nothing blocked this week.`
- **Setup › Roles, guard and test lock.**
  - **Guard:** Rule · Hits (this week), one row per rule, and the note `The guard catches agent mistakes and ordinary spellings, not deliberate evasion.`
  - **Test lock:** Repo profile · Full suite (takes the lock) · Runs freely, the last column reading `{FREE_SUITE_HINT}`. Below: `{CALL} holds it: {command} · {elapsed}` or `No full-suite run in progress.`, then the waiting seats.
- **Lock box and header line:** the holder and waiting seats, from `/api/test-lock`. Lock history and the Lock-wait KPI (spec §4.4) wait for 2c's run records: say so in the box's title.
- **Needs you:** stray, question, crew error and lock items, with the actions from "Scope and stated deviations".

- [ ] **Step 1: Write failing tests** for each element, both empty states, and a waiting seat's line.
- [ ] **Step 2–4:** Run the tests, implement, then run the full checks. **Commit** `feat(web): guard drawer, test lock, stray, question and error items`.

### Task 11: End-to-end on the real CLI

**Files:**
- Modify: `docs/spikes/2026-10-21-mc-tools-guard.md` (results), `docs/runbook.md` (a "Crew pushes and PRs" section).

- [ ] **Step 1: Run one haiku writer seat** through the real supervisor:
  - **the preview:** port 7431, `MC_DB` a copy, `MC_NO_LOOP_WRITES=1`, `MC_CREW=1`, a scratch `crew` config, and `MC_GH_COMMAND` pointing at a fake that records argv;
  - **the clone:** a scratch clone whose origin is a local bare repo.

  Ask the seat to change one line, commit, run the full suite, push and open a draft PR, and record each result. Then check each of these, recording the result:
  - typed `git push` and `git commit` → denied, and in `/api/guard/hits`;
  - sandboxed `git commit` → fails;
  - a fake `ghp_` token committed, then pushed → refused;
  - a second seat's full suite waits for the first.

  Stop the preview by PID.
- [ ] **Step 2: Runbook:**
  - what seats can do now, and the exact GitHub writes;
  - `repos[].full_suite`, `crew.deny_read` and `crew.node`;
  - before the first crew push, list your working folders under `crew.deny_read`;
  - how to land a needed protected-file change: by hand, or a controller PR;
  - the scan's limits: known formats and your local credentials only, no encoded secrets;
  - the mention filter's limit: a team mention (`@org/team`) passes it.
- [ ] **Step 3: Commit** `docs: crew pushes and PRs — end-to-end check and runbook`.
