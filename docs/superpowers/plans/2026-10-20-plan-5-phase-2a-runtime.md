# Plan 5 — Phase 2a: the agent runtime and the first crew

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mission Control starts, drives, messages, interrupts and stops its own Claude agents ("seats") on tickets in its own clone of a repo. The HUD shows them like the observed loops, they survive a hub restart, and the operator can update the hub from the HUD.

**Architecture:** Each running seat is one long-lived `claude -p` process. The server talks to it over stream-json in both directions (spike `docs/spikes/2026-10-20-runtime-stream-json.md`):
- A **driver** wraps one process: write user lines and control requests, read events, and tee every stdout line to a transcript file.
- A **supervisor** owns the seats. It starts a run (branch + git worktree in Mission Control's own clone, then the process), routes Send / Interrupt-and-send / Stop, folds the transcript with the existing fold, and reattaches after a restart with `--resume`.
- Crew runs are ordinary `runs` rows, so the Agent page, Overview, Telemetry and Activity read them as they read the loops.
- Until the guard (phase 2b), each seat's safety rests on the CLI's own tool allowlist, which denies anything not listed in `-p` mode.

**Tech Stack:** As Plans 3–4 — Fastify 5, React 19, SQLite via `node:sqlite`, zod 4, `yaml` 2, Vitest + Testing Library + jsdom, Biome, Vite 7. CLI: `claude` 2.1.302 (`claude --version`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-mission-control-design.md` §2, §4.3, §5 (Agent runtime, Accounts, Sessions and areas, Machine), §7 phase 2, §8a.1, §8a.4, §8b.1–2; catalogue `docs/prototype/mission-control-hud-catalogue.md` §2.4.3–2.4.4 (Agent header, composer), §2.7.1 (Sessions), §2.7.3 (Accounts). Spike: `docs/spikes/2026-10-20-runtime-stream-json.md`.

## Phase 2 roadmap (why this plan is 2a)

Spec §7's phase 2 covers several subsystems, and each consumes the previous one's real interfaces. Each part gets its own plan once the one before it has merged:
- **2a (this plan):** the runtime, the first crew (seats in config), start/message/interrupt/stop, reattach, the Update button.
- **2b:** mc tools (an MCP server: commit, push, draft PR, run the full suite, propose a write, ask FLIGHT/the operator, message another agent, report loop evidence), the guard (PreToolUse hook passed through `--settings`, with recorded hits), the test lock, and stray-change detection (a change outside every writer's area becomes a Needs-you `stray` item, catalogue §5.3). Pushes and PRs start here.
- **2c:** the loop engine. YAML templates with steps, gates and checks; the retry rule; budgets; the merge workspace setting (§4.2); seats taking their next ticket.
- **2d:** the mailbox and threads, Work in flight driven by the engine, the loop panels, and Setup editing (sessions, seats and accounts from the HUD).

## Global Constraints

- **Everything in Plans 3 and 4 still holds.** In particular: live loops are observed only; previews never use port 7420; transcript text is cleaned and rendered inert; links go through `githubHref`; numbers are computed or `—`; constants are defined once in `@mc/core`; TypeScript is erasable only; storage keys live in `storage.ts`.
- **Where crew processes may run.** Only inside `crew.worktrees` (from config). Each session's `checkout` is Mission Control's own clone of that repo. The config loader refuses a `checkout` or `worktrees` path that is, or lies inside, the hub's own checkout (`process.cwd()`'s git top level) or any loop's `worktree` / `state_dir` / `logs_dir`.
- **No GitHub writes in 2a.**
  - Crew agents cannot push or call `gh`: those patterns are absent from the allowlist and present in the deny list.
  - The server itself only reads: `git fetch` in its own clones, and `fetchTicket`.
- **Every crew process starts with** `--setting-sources project,local --strict-mcp-config --disable-slash-commands`, plus the seat's `--allowedTools` / `--disallowedTools`, `--model` and `--append-system-prompt-file roles/<CALL>.md`. The operator's hooks, MCP servers and CLAUDE.md never reach the crew (§8b.1).
- **Starting, stopping and messaging an agent are outward actions** (§4.3). Each happens only on the operator's click in the HUD; the click is the approval. Nothing starts a seat on its own in 2a.
- **Previews never run crew.**
  - `MC_NO_CREW=1`: the supervisor is off, crew routes answer 409 `crew is disabled on this server`, and nothing is reattached.
  - The preview command in the runbook gains `MC_NO_CREW=1`.
  - Independently, only one process may run crew: the supervisor takes an exclusive lock file `<crew.worktrees>/.mc-crew.lock` holding its pid. A second process finds a live pid there and stays off, with the status note `crew lock held by pid {n}`.
- **New POST bodies are validated with zod at the route**; an invalid body gets 400 `{ error }`. Every new route goes into the route-table test.
- **Checks before each task's commit:** `pnpm -s lint && pnpm -s typecheck && pnpm -s test && pnpm -s build`.
- **Tests never spawn the real `claude`.** They use the fake CLI (Task 2). Each task that touches the driver has one manual check against the real CLI on `--model haiku` in a scratch directory, recorded in its report.
- **Browser output** goes under `/private/tmp/claude-501/`, never the live checkout (memory: browser MCP writes into the live checkout).

## Review Focus

1. **A crew process that misbehaves.**
   - Cases: it exits mid-turn or with a non-zero code; it writes half a line and dies; it never answers a control request; it prints a non-JSON line; it emits `rate_limit_event` with status `rejected`.
   - Expected: the seat goes to error (or parked for the rate limit) with a reason; the run is `failed` (or kept for the rate limit); control requests time out after `CONTROL_TIMEOUT_MS`; nothing hangs; the transcript keeps every line received. → Tasks 2, 5.
2. **A hub restart while a seat is mid-run.**
   - Cases: the hub is restarted while a run is active; a preview is started with a copy of the DB; two servers start against the same crew directory.
   - Expected: the live hub reattaches each active run once (`--resume`, same transcript file, seat idle with "resumed after a restart"). The preview reattaches nothing. The second server stays off because of the lock. → Tasks 5, 6.
3. **Messages that race.**
   - Cases: Send twice within 100 ms; Interrupt and send when no turn is running; Send after the process has exited; Stop during a tool call.
   - Expected: lines are written in order exactly once; Interrupt with no turn just sends; a dead process answers 409 `{CALL} has no live session; start it on a ticket`; Stop interrupts, closes stdin, then sends SIGTERM after `STOP_GRACE_MS`, and the run ends `ok`. → Tasks 5, 8.
4. **Checkouts that are not as expected.**
   - Cases: the branch already exists; the worktree path exists; the session checkout is missing, dirty, or on a detached HEAD; origin is unreachable; the ticket number does not exist.
   - Expected: a fixed error text for each; nothing half-created (a worktree made by a failed start is removed); an existing branch is reused, never reset. → Task 4.
5. **Update when it should not.**
   - Cases: the hub's checkout is dirty, not on `main`, or already up to date; the build fails; a crew turn is running; the server is a preview.
   - Expected: refuse with the reason, or report "up to date". A failed build leaves the old `dist` serving and the hub running. → Task 11.

---

### Task 1: Crew config, roles and runtime constants

**Files:**
- Create: `packages/core/src/runtime.ts`, `roles/GUIDO.md`, `roles/INCO.md`, `roles/RETRO.md`, `docs/spikes/2026-10-20-runtime-stream-json.md` (already written on this branch).
- Modify: `packages/core/src/index.ts`, `packages/core/src/types.ts` (`ConfigView.crew`), `apps/server/src/config.ts` (`crew` section), `apps/server/src/views.ts` (`configView`), `config.example.yaml`.
- Test: `packages/core/test/runtime.test.ts`, `apps/server/test/config.test.ts`.

**Interfaces:**
- Core `runtime.ts`:
  - `CREW_ROLES = ["GUIDO", "INCO", "RETRO"] as const`, typed `CrewRole`. This is a subset of `ROLES` call signs; the mode comes from `ROLES`.
  - `CREW_ISOLATION_FLAGS = ["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"]`.
  - `WRITER_TOOLS`: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `TodoWrite`, and the Bash patterns `Bash(pnpm -s lint:*)`, `Bash(pnpm -s typecheck:*)`, `Bash(pnpm -s test:*)`, `Bash(pnpm -s build:*)`, `Bash(pnpm -s vitest:*)`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git add:*)`, `Bash(git commit:*)`.
  - `READONLY_TOOLS`: `Read`, `Grep`, `Glob`, `TodoWrite`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(pnpm -s vitest:*)`.
  - `DENIED_TOOLS`: `Bash(git push:*)`, `Bash(gh:*)`, `Bash(git -c:*)`, `Bash(git config:*)`, `Bash(curl:*)`, `Bash(wget:*)`, `WebFetch`, `WebSearch`, `Task`.
  - `crewCliArgs(i: { model: string; mode: "writer" | "read-only"; rolePromptFile: string; sessionId: string; resume: boolean }): string[]` returns `-p`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--model`, the isolation flags, `--allowedTools …` / `--disallowedTools …` (one argument per pattern), `--append-system-prompt-file`, and then `--session-id <id>` for a new session or `--resume <id>` when `resume` is set.
  - `CONTROL_TIMEOUT_MS = 10_000`, `STOP_GRACE_MS = 10_000`.
  - `SEAT_STATES = ["idle", "starting", "running", "parked", "stopped", "error"] as const`, typed `SeatState`.
- Config (file shape, snake_case; transformed to camelCase as the rest is):
  ```yaml
  crew:                       # optional; absent = no crew
    worktrees: ~/code/mc-crew/worktrees
    max_seats: 8
    sessions:
      - id: mission-control
        repo_id: mission-control          # a configured repo
        checkout: ~/code/mc-crew/mission-control
        seats:
          - { id: guido-1, role: GUIDO, account_id: claude-main, model: sonnet, area: ["apps/server/**", "packages/core/**"] }
          - { id: inco-1, role: INCO, account_id: claude-main, model: sonnet, area: ["apps/web/**"] }
          - { id: retro-1, role: RETRO, account_id: claude-main, model: opus }
  ```
- Validation in `parseConfig`. Each rule fails with a `ConfigError` naming its path:
  - Seat ids are unique across all seats and all loop ids, and match `/^[a-z][a-z0-9-]{0,30}$/`.
  - `repo_id` must be a configured repo.
  - `account_id` must be a configured account with vendor `claude`.
  - `role` must be in `CREW_ROLES`.
  - A writer's `area` is optional; empty means the whole checkout. A read-only seat must have no `area`.
  - Writer areas in one session must not overlap. Compare each glob's static prefix (the text before its first `*`, trimmed to the last `/`); two writers overlap when either prefix starts with the other, and an empty area overlaps everything. Error text: `areas overlap: {a} and {b}`.
  - The seat count is at most `max_seats` (1–32, default 8).
  - The path rules from Global Constraints apply, with `~` expanded.
- `ConfigView.crew`: `{ worktrees: string; sessions: { id; repoId; checkout; seats: { id; role; mode; accountId; model; area: string[] }[] }[] } | null`.
- **Role briefs (`roles/<CALL>.md`).** Short Markdown carrying the operator's engineering standards from `~/.claude/CLAUDE.md`:
  - TDD; lint, typecheck and test before saying done.
  - No magic strings; a single source of truth for constants.
  - Parameterised SQL only; validate at boundaries.
  - Match the surrounding code.
  - The role's job, from the `ROLES` row (`here`).
  - Explicitly **not** the push/PR/merge workflow. Instead: "Commit locally with clear messages. Do not push, open PRs or comment on GitHub; Mission Control does that."
  - RETRO's brief: read-only; findings with file:line; report everything and classify severity afterwards.

- [ ] **Step 1: Write failing tests.**
  - `crewCliArgs` for a writer with `resume: false` contains each isolation flag, `--session-id`, every `WRITER_TOOLS` entry once, and every `DENIED_TOOLS` entry.
  - `crewCliArgs` with `resume: true` uses `--resume` instead of `--session-id`.
  - The read-only mode uses `READONLY_TOOLS`.
  - Config errors, each with its error path: overlap `apps/**` vs `apps/web/**`; an empty writer area next to another writer; a read-only seat with an area; an unknown repo; a codex account; a duplicate of a loop id; a checkout inside the hub's checkout; a checkout inside a loop's worktree; too many seats.
  - The example config loads.
  - `configView` includes `crew`.
- [ ] **Step 2: Run** `pnpm -s vitest run packages/core/test/runtime.test.ts apps/server/test/config.test.ts`. Expect the new tests to fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Manual check against the real CLI.** In a scratch dir with a stub role file, run `claude $(crewCliArgs…) --model haiku` and send one user line asking it to `git push`. Confirm a `permission_denied` event. Ask for `pnpm -s lint` in a dir with no package.json and confirm the tool was allowed (it fails as a command, not as a permission). Record both in the report.
- [ ] **Step 5: Run** full checks. **Commit** `feat: crew config, roles and the runtime's CLI flags`.

### Task 2: The CLI session driver

**Files:**
- Create: `apps/server/src/runtime/session.ts`, `apps/server/test/fixtures/fake-claude.mjs`.
- Test: `apps/server/test/runtime-session.test.ts`.

**Interfaces:**
- `startSession(i: { command: string; args: string[]; cwd: string; transcriptPath: string; env?: NodeJS.ProcessEnv }): CrewSession`. The default `command` is `"claude"`; tests pass `process.execPath` plus the fake's path as the first argument. It spawns with `stdio: ["pipe","pipe","pipe"]`, appends each complete stdout line plus `\n` to `transcriptPath` (mode 0600, created if absent, opened for append), parses each line as JSON when it starts with `{` (skip `stream_event`), and emits typed events.
- `CrewSession` (a class or closure object; erasable TS):
  - `send(text: string): void` writes `{"type":"user","message":{"role":"user","content":text}}`.
  - `control(subtype: "interrupt" | "get_context_usage" | "get_usage"): Promise<unknown>` resolves with `response.response`. It rejects with `Error("control timeout")` after `CONTROL_TIMEOUT_MS`, and with `Error("session ended")` if the process exits first.
  - `close(): Promise<number | null>` ends stdin, sends SIGTERM after `STOP_GRACE_MS`, and resolves with the exit code.
  - `on(listener: (e: SessionEvent) => void): () => void`.
  - `pid: number | undefined`, `alive: boolean`.
- `SessionEvent` (core `runtime.ts`):
  - `{ kind: "init"; sessionId: string; model: string | null }`
  - `{ kind: "turn-start" }` (the first assistant or tool event after a user line or an init)
  - `{ kind: "result"; isError: boolean; stopReason: string | null }`
  - `{ kind: "rate-limit"; status: string; resetsAt: number | null }`
  - `{ kind: "output"; at: number }` (any line)
  - `{ kind: "stderr"; text: string }` (cleaned, cut at 500 characters)
  - `{ kind: "exit"; code: number | null; signal: string | null }`
- The **fake CLI** reads stdin lines and copies the shapes in the spike doc:
  - On start it prints an `init` line carrying the `--session-id` / `--resume` value.
  - A user line makes it print an assistant text and a `result`. If the text contains `SLOW`, it first prints a `tool_use` and waits 2 s.
  - `interrupt` during that wait prints `control_response {still_queued: []}`, the `[Request interrupted by user]` user line and a `result`.
  - `get_context_usage` returns two categories.
  - Text containing `DIE` makes it exit 3 mid-turn, after half a line.
  - `NOCONTROL` makes it ignore control requests.
  - `RATELIMIT` makes it print a `rate_limit_event` with `status: "rejected"`.
  - It writes stderr only when asked (`STDERR`).

- [ ] **Step 1: Write failing tests** against the fake:
  - A turn emits init, turn-start, result, and the transcript holds every line.
  - Two `send`s 10 ms apart reach the fake in order.
  - An interrupt during `SLOW` resolves and a result follows.
  - `get_context_usage` returns the categories.
  - `NOCONTROL` rejects after the timeout (fake timers or an injected timeout).
  - `DIE` emits `exit {code: 3}`, keeps the half line out of the parsed events but in the transcript, and rejects pending controls with "session ended".
  - `close()` resolves when the fake exits on EOF, and sends SIGTERM to a fake that ignores EOF (`HANG`).
  - A non-JSON stdout line goes into the transcript and parses to nothing.
- [ ] **Step 2: Run** `pnpm -s vitest run apps/server/test/runtime-session.test.ts`. Expect failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Manual check against the real CLI** (haiku, scratch dir, isolation flags): one turn, `get_context_usage`, and an interrupt during `sleep 8`. Use a stub role prompt and `--allowedTools "Bash(sleep:*)"`. Record the event sequence in the report.
- [ ] **Step 5: Run** full checks. **Commit** `feat(server): drive a claude session over stream-json`.

### Task 3: Seats and crew runs in the store

**Files:**
- Modify: `apps/server/src/store.ts`, `packages/core/src/types.ts`.
- Test: `apps/server/test/store.test.ts`.

**Interfaces:**
- Table `seat_sessions`: `seat_id TEXT PRIMARY KEY`, `run_id TEXT`, `cli_session_id TEXT`, `state TEXT NOT NULL`, `reason TEXT`, `worktree TEXT`, `updated_at INTEGER NOT NULL`. `run_id` is null when no run is active. `reason` is shown in the doing line.
- Store methods:
  - `seatSession(seatId): SeatSessionRow | null`
  - `setSeatSession(row: SeatSessionRow): void` (upsert)
  - `activeSeatSessions(): SeatSessionRow[]` (rows with `run_id` set and a state in `idle | starting | running | parked`)
- `SeatSessionRow` (core) = `{ seatId; runId: string | null; cliSessionId: string | null; state: SeatState; reason: string | null; worktree: string | null; updatedAt: number }`.
- **Crew runs** reuse `runs`: `id` = `{seatId}:{compactUtc(startedAt)}`, `agentId` = seat id, `repoId`, `seq` = that seat's run count + 1, `status` (`running` while the run is active, `ok` when the operator ends it, `failed` on a crash), `branch`, `ticket`, `transcriptPath` = `{MC_DB dir}/crew/{runId}.jsonl`. `crewTranscriptPath(dbPath, runId)` is exported from `store.ts`; the `crew` directory is created with mode 0700.

- [ ] **Step 1: Write failing tests.** Round trip of a seat session row. `activeSeatSessions` excludes `stopped`/`error` rows and rows with no `run_id`. `crewTranscriptPath` creates the directory with mode 0700. Migrating an old DB adds the table.
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat(server): seat sessions and crew transcripts in the store`.

### Task 4: Run checkouts

**Files:**
- Create: `apps/server/src/runtime/checkouts.ts`.
- Test: `apps/server/test/checkouts.test.ts` (uses real git in temp dirs: a bare "origin", a clone as the session checkout).

**Interfaces:**
- `branchFor(issue: number, title: string): string` = `feature/{issue}-{slug}`. The slug is the title lower-cased, with runs of characters outside `[a-z0-9]` replaced by `-`, trimmed of `-`, and cut to 40 characters at a word boundary. An empty slug gives `feature/{issue}`.
- `prepareCheckout(i: { checkout: string; worktreesRoot: string; seatId: string; issue: number; title: string; git?: GitExec }): Promise<{ branch: string; path: string; created: boolean }>`:
  1. `checkout` must be a git top level and be clean (`status --porcelain` empty). Otherwise `CheckoutError("checkout", "the crew checkout is missing or has uncommitted changes")`.
  2. `git fetch origin` (failure: `CheckoutError("fetch", "could not reach origin")`).
  3. The base is `origin/HEAD` resolved with `symbolic-ref` (missing: `CheckoutError("base", "origin has no default branch")`).
  4. `path` = `{worktreesRoot}/{seatId}-{issue}`. If `path` exists and is a worktree of that branch, reuse it (`created: false`). If it exists otherwise, fail with `CheckoutError("path", "{path} exists and is not this ticket's checkout")`.
  5. A branch that exists locally or on origin is reused: `worktree add {path} {branch}`, tracking origin's branch if only that exists. Otherwise `worktree add -b {branch} {path} {base}`.
  6. Any failure after the worktree was created removes it (`worktree remove --force {path}`, only a path this call created).
- `removeCheckout(checkout, path)`: `git worktree remove {path}`. Refuse when the worktree has uncommitted changes, with `CheckoutError("dirty", "…has uncommitted changes")`. It never deletes branches.
- Git runs through the `files.ts` pattern (`gitEnv`, timeout). It is not read-only here, because this is Mission Control's own clone. `GIT_TERMINAL_PROMPT=0` is set.

- [ ] **Step 1: Write failing tests:**
  - `branchFor(42, "Fix the stop() race in the Claude adapter!")` gives `feature/42-fix-the-stop-race-in-the-claude-adapter`.
  - A long title is cut at a word boundary.
  - A fresh branch is created from `origin/HEAD`.
  - An existing local branch is reused (its commits are kept).
  - An existing origin-only branch is checked out tracking origin.
  - An existing worktree for the same branch is reused.
  - A foreign path gets the `path` error.
  - A dirty checkout gets the `checkout` error.
  - An unreachable origin gets the `fetch` error, and nothing is created.
  - A failure after `worktree add` leaves no worktree.
  - `removeCheckout` refuses a dirty worktree and keeps the branch.
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat(server): crew checkouts — a branch and worktree per ticket`.

### Task 5: The supervisor

**Files:**
- Create: `apps/server/src/runtime/supervisor.ts`, `apps/server/src/runtime/brief.ts`.
- Modify: `apps/server/src/main.ts` (create and start it; `MC_NO_CREW`), `apps/server/src/shutdown.ts` (stop it first).
- Test: `apps/server/test/supervisor.test.ts` (fake CLI, temp git repos, temp DB).

**Interfaces:**
- `createSupervisor(deps: { config: CcConfig; store: Store; bus: ChangeBus; dbPath: string; now?: () => number; command?: string; commandArgs?: string[]; fetchTicket: (repo, n) => Promise<TicketView | null>; enabled: boolean }): Supervisor`.
- `Supervisor` methods:
  - `start(): void` takes the lock, then reattaches (Task 6).
  - `stopAll(): Promise<void>`.
  - `startRun(seatId, issue): Promise<{ runId; branch }>`.
  - `message(seatId, text, opts: { interrupt: boolean }): Promise<void>`.
  - `interrupt(seatId): Promise<void>`.
  - `endRun(seatId): Promise<void>`.
  - `contextUsage(seatId): Promise<ContextUsage | null>`.
  - `seat(seatId): SeatSessionRow | null`.
  - `status(): { enabled: boolean; note: string | null }`.
- `ContextUsage` (core) = `{ categories: { name: string; tokens: number }[]; total: number; window: number | null }`.
- **startRun:**
  1. Refuse with `SupervisorError(409, "{CALL} already has a run")` when the seat has an active run.
  2. Fetch the ticket (missing → `SupervisorError(404, "unknown issue")`).
  3. `prepareCheckout`.
  4. Mint the run row and a UUID `cliSessionId`.
  5. Spawn the process with `crewCliArgs` in the worktree.
  6. Set the seat to `starting`, then to `running` on the first `turn-start`.
  7. Send `ticketBrief(…)` as the first message.
  8. Emit `agents`.
- **`ticketBrief`** (in `brief.ts`). Exact copy:
  ```
  You are {CALL}, the {ROLES.here} on {repo}. Ticket {repo}#{n}: {title}

  {body, cut at 8000 characters}

  You are working in a checkout of branch {branch}. {Writers: "Change files only inside your area: {globs or 'the whole checkout'}." Read-only: "Read and report only; do not change files."} Commit locally with clear messages; do not push, open PRs or comment on GitHub. When your checks pass, reply with a short summary that starts with DONE.
  ```
- **message:**
  - With no live session: `SupervisorError(409, "{CALL} has no live session; start it on a ticket")`.
  - With `interrupt` set and a turn running: send `control("interrupt")` first, then write the line.
  - Otherwise write the line. It reaches the agent mid-turn, or starts a turn when between turns.
  - Lines are written through one per-seat promise chain, so they keep their order.
- **Events:**
  - `turn-start` → `running`.
  - `result` → `idle`, with reason `null`, or `"last turn ended in an error"` when `isError`.
  - `rate-limit` `rejected` → `parked`, with reason `"rate limited until {HH:MM}"`. The process is kept; the next Send resumes.
  - `exit`: if the operator ended the run, the seat goes to `stopped` and the run to `ok`. Otherwise the seat goes to `error` (reason `"process exited {code}"`) and the run to `failed`, with `endedAt` set.
  - Every event updates `seat_sessions` and emits `agents`, coalesced by the scheduler's bus.
- **Folding:** on each `output` event (throttled to once per second per seat), fold the new transcript bytes with `foldPath` into a supervisor-owned `Map`, `applyFacts`, `upsertRun`, and `persistDigest`, exactly as the collectors do.
- **endRun:** `interrupt` (ignore a timeout), then `close()`. The run gets `endedAt`; the seat becomes `stopped` with `run_id` cleared and its worktree kept.
- **Lock:** `<worktrees>/.mc-crew.lock`, created with `wx` and holding `{pid}`. If it exists, read the pid: a live pid (`process.kill(pid, 0)`) means stay off, with note `crew lock held by pid {n}`; a dead one means replace it. It is removed in `stopAll`.
- **`enabled: false`** (`MC_NO_CREW=1`, or no `crew` config): every method throws `SupervisorError(409, "crew is disabled on this server")`, and `start()` does nothing.

- [ ] **Step 1: Write failing tests** with the fake CLI:
  - startRun creates the branch and worktree and spawns with `--session-id`; the first line written is the brief.
  - The seat goes starting → running → idle on the result.
  - Two messages sent 5 ms apart arrive in order.
  - Interrupt-and-send during `SLOW` produces the interrupt and then the line.
  - Send with no session gives 409 with the text above.
  - `DIE` puts the seat in error and the run in failed, with the transcript intact.
  - `RATELIMIT` parks the seat with its reason.
  - `endRun` makes the run `ok` and the seat `stopped`, and keeps the worktree.
  - A second supervisor on the same worktrees root stays off, with the lock note.
  - `enabled: false` gives 409 everywhere.
  - Folding fills the run's tokens and digest from the transcript.
  - startRun for a busy seat gives 409.
- [ ] **Step 2: Run** `pnpm -s vitest run apps/server/test/supervisor.test.ts`. Expect failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Manual check against the real CLI.** Use a throwaway clone under `/private/tmp/claude-501/` as the checkout and `--model haiku`. Start a run on a real issue number of `octo-org/mission-control` and let it answer. Send a message, interrupt, then end the run. Record the outcome; no push can happen.
- [ ] **Step 5: Run** full checks. **Commit** `feat(server): the crew supervisor — start, message, interrupt, end`.

### Task 6: Reattach after a restart

**Files:**
- Modify: `apps/server/src/runtime/supervisor.ts`.
- Test: `apps/server/test/supervisor.test.ts`.

**Interfaces:**
- `start()`, after taking the lock: for each row in `activeSeatSessions()` whose seat is still configured and whose worktree exists, spawn with `resume: true` (`--resume {cliSessionId}`) in that worktree, appending to the same transcript. The seat becomes `idle` with reason `"resumed after a restart; send a message to continue"`, and the run stays `running`. Nothing is sent.
- A row whose seat was removed from config, or whose worktree is gone, gets state `error` with reason `"could not resume: {seat removed | checkout missing}"`, and its run is marked `failed`.
- A resumed process that exits within 5 s of spawning means a failed resume: the seat goes to `error` with reason `"could not resume the session"`.

- [ ] **Step 1: Write failing tests.** A supervisor started on a DB holding one active row resumes it once: the fake sees `--resume <id>`, and the transcript is appended to, not truncated. A removed seat gives an error row. A missing worktree gives an error row. `enabled: false` resumes nothing. A fake that exits at once on `--resume` gives "could not resume the session".
- [ ] **Step 2–4:** Run, implement, full checks.
- [ ] **Step 5: Manual check.** On a preview server (`MC_PORT=7431`, DB copy, `MC_NO_LOOP_WRITES=1`, *without* `MC_NO_CREW` for this one check, crew config pointing at a scratch clone and scratch worktrees root): start a run, kill the preview server, start it again, and confirm the resume and that a message continues the conversation. Then re-enable `MC_NO_CREW=1` for every later preview. **Commit** `feat(server): crew runs survive a hub restart`.

### Task 7: Crew in the HUD's server views

**Files:**
- Modify: `packages/core/src/types.ts` (`CrewRow`, `AgentView`), `packages/core/src/hud.ts`, `apps/server/src/hud.ts` (`loopViews`/`crew`/`attentionItems`), `apps/server/src/views.ts` (`overview`, `activity`), `apps/server/src/telemetry.ts`, `apps/web/test/fixtures.ts`.
- Test: `apps/server/test/hud.test.ts`, `apps/server/test/views.test.ts`, `apps/server/test/telemetry.test.ts`.

**Interfaces:**
- `CrewRow` and `AgentView` gain:
  - `kind: "loop" | "crew"`;
  - `role: CrewRole | null`;
  - `mode: "writer" | "read-only" | null`;
  - `area: string[]`;
  - `model: string | null` (crew: from config);
  - `sessionId: string | null` (crew: the config session id).
  - `loopKind` becomes `"ta-loop" | "studio-loop" | "crew"`.
- Crew rows come after loop rows. `index` continues the config order (loops, then seats), so the agent colours stay stable.
- `crewHudState(row: SeatSessionRow | null, lastOutputAt, now): HudState`, in core:
  - no row, or no run → `idle`;
  - `starting`/`running` → `running`, or `stalled` by the `STALL_MS` rule on `lastOutputAt`;
  - `idle` → `idle`;
  - `parked` → `parked`;
  - `stopped` → `stopped`;
  - `error` → `error`.
- The doing line uses `reason` when it is set. Attention items: crew stalls and errors follow the loops' rules (keys `stall:{seat}:…`, `error:{seat}:{updatedAt}`).
- `overview`, `activity` and `telemetry` iterate `config.loops` plus the crew seats, through one helper `agentIds(config): AgentId[]` (core or server). No other code path enumerates agents.

- [ ] **Step 1: Write failing tests.**
  - A config with two seats and a seat-session row produces crew rows with role, area, model and state.
  - Stall after `STALL_MS` without output.
  - A parked seat's doing line carries its reason.
  - An error seat makes an `error` attention item.
  - Telemetry totals include a crew run.
  - Activity shows crew run-start and run-end rows.
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat: crew seats in the crew rows, attention, activity and telemetry`.

### Task 8: Crew API

**Files:**
- Modify: `apps/server/src/api.ts`, `apps/web/src/data.ts` (`ACTIONS`, `RESOURCES.seatContext`).
- Test: `apps/server/test/api.test.ts`.

**Interfaces** (all 409 when the supervisor is disabled; 404 for an unknown seat):
- `POST /api/seats/:id/start` with body `{ issue: number }` (int 1..2³¹−1) → 200 `{ runId, branch }`. Errors: 409 busy, 404 unknown issue, 422 `{ error }` for a `CheckoutError` (its fixed text), 502 when GitHub fails.
- `POST /api/seats/:id/message` with body `{ text: string (1..8000), interrupt?: boolean }` → 200 `{ ok: true }`.
- `POST /api/seats/:id/interrupt` with body `{}` → 200.
- `POST /api/seats/:id/end` with body `{}` → 200.
- `GET /api/seats/:id/context` → `ContextUsage | null` (null when no live session), read live with `get_context_usage`.
- `GET /api/crew/status` → `{ enabled, note }`.
- Every success emits `agents`. Responses carry fixed text; never paths or stderr.

- [ ] **Step 1: Write failing tests** with a stub supervisor:
  - Each route's 200, 400 (bad bodies: `text: ""`, `issue: 0`, extra keys), 404 and 409.
  - 422 carries the checkout text.
  - Route-table entries with valid bodies.
  - A foreign Origin is refused (existing hook).
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat(server): crew routes — start, message, interrupt, end, context`.

### Task 9: The Agent page drives a seat

**Files:**
- Modify: `apps/web/src/agent/StreamPanel.tsx` (composer), `apps/web/src/agent/Header.tsx`, `apps/web/src/agent/Tiles.tsx` (Context tile), `apps/web/src/pages/Agent.tsx`, `apps/web/src/hud.css`.
- Test: `apps/web/test/Agent.test.tsx`.

**Interfaces / copy** (catalogue §2.4.3–2.4.4, verbatim where the feature exists):
- **Composer** (crew seats only; loops keep the `ENGINE_NOT_RUNNING` line):
  - An input with aria "Message this agent" and placeholder `Message {CALL}…`.
  - [Send] and [Interrupt and send] (title "Stop the current turn, then send"). An empty input gives the toast "Type a message first."
  - Hint while running: `Reaches {CALL} mid-turn, alongside its next tool result. Smaller models can ignore a mid-turn note; use Interrupt and send if it matters.`
  - Hint when there is a live session between turns: `{CALL} is idle; your message starts its next turn.`
  - Hint with no live session: `{CALL} has no live session; start it on a ticket from the Board.`
  - **Decision:** the catalogue's "queued for its next turn" is replaced by the two lines above, because 2a has no queue (the mailbox is 2d).
  - Toast on send: `Delivered to {CALL}.`
  - `{CALL}` is the seat id upper-cased (`GUIDO-1`).
- **Header:**
  - Role, mode, model and account pills, plus `area: {globs | whole checkout | read-only}`.
  - [Interrupt] (when running) and [End the run] (warn, with confirm text `End {CALL}'s run? The checkout and branch stay; nothing is pushed.`).
  - The page's `i` key calls interrupt for a crew seat.
- **Context tile** (crew): `GET /api/seats/:id/context`, refetched on `agents`.
  - Value: `{pct}% of {window/1000}k`.
  - A segmented bar using the catalogue's colours (system, tools, messages, free).
  - Detail: `msgs {n}k · tools {n}k · system {n}k · {n} compaction{s}` (compactions from the digest).
  - Category mapping: the category names containing "System prompt" are system; "tool" (any case) is tools; "Messages" is msgs.

- [ ] **Step 1: Write failing tests:**
  - The composer appears for a crew row only.
  - Send posts `{text}`; Interrupt and send posts `{text, interrupt: true}`.
  - An empty input shows the toast.
  - The hint follows the state.
  - End the run confirms, then posts.
  - The Context tile renders categories from a stub.
  - `i` interrupts a crew seat.
  - Loop rows are unchanged.
- [ ] **Step 2–4:** Run, implement, full checks.
- [ ] **Step 5: Preview check** with `MC_NO_CREW=1`: the composer shows "crew is disabled on this server" as an inline error on Send, and the page does not break. **Commit** `feat(web): message, interrupt and end a crew seat from the Agent page`.

### Task 10: Start a seat on a ticket; Work in flight; Setup › Sessions

**Files:**
- Modify: `apps/web/src/components/TicketDetail.tsx`, `apps/web/src/flight/` (Work in flight panel `wifP`), `apps/web/src/setup/Sessions.tsx`, `apps/web/src/setup/Accounts.tsx`, `apps/server/src/api.ts` (`GET /api/crew/sessions`: each session's top-level folders), `apps/web/src/data.ts`.
- Test: `apps/web/test/TicketDetail.test.tsx`, `apps/web/test/Setup.test.tsx`, `apps/web/test/Flight.test.tsx` (or the existing FLIGHT page test), `apps/server/test/api.test.ts`.

**Interfaces / copy:**
- **Ticket panel.** For an open issue in a repo that has a crew session, a section `Start a seat` appears:
  - A `<select>` of that session's seats that have no active run, labelled `{CALL} · {role here}`.
  - The line `Mission Control makes branch {branchFor(n, title)} in its own clone and starts {CALL} on it. Nothing is pushed.`
  - [Start {CALL}] (primary) → `POST /api/seats/:id/start`. Success: toast `{CALL} started on {repo}#{n}.` and navigate to the Agent page. Errors are shown inline.
  - With no free seat: `Every seat in s/{session} is busy.`
- **Work in flight** (`#wifP`, FLIGHT page): one row per active crew run, showing seat tag · state pill · ticket chip · branch · elapsed · doing line. Empty: `No crew runs. Start a seat from a ticket on the Board.` Loops are not listed here.
- **Setup › Sessions** (crew sessions, read-only in 2a; editing is 2d):
  - Panel title `s/{id}`, subtitle `{checkout} · {repo}`.
  - Seat buttons: tag · area or "read-only" · state pill → Agent page.
  - Folder tiles: the top-level folders of the checkout (`GET /api/crew/sessions` → `{ id, folders: { name, owner: AgentId | null }[] }[]`, read with `readdir` on the checkout, directories only, dot-folders skipped), showing the owner tag or "free".
  - Note (catalogue §2.7.1): `Tiles show who owns each folder; areas can't overlap.`
  - The catalogue's `[Add session]` / `[Add agent]` buttons are absent. **Decision:** in 2a sessions and seats come from config.yaml.
- **Setup › Accounts:** a crew account row shows `Signed in` when the latest `get_usage` from any of its seats reported `subscription_type`, or else when the usage collector is ok for it. Plan: from `usage:{account}` status. [Sign in] / [Check] stay `—` with title `ENGINE_NOT_RUNNING`. **Decision:** one login per vendor until phase 5.

- [ ] **Step 1: Write failing tests** for each element above, including:
  - The ticket panel hides the section for a closed issue and for a repo with no crew session.
  - The start error shows inline.
  - The Work in flight rows and the empty state.
  - Folder tiles with owners from areas (a `apps/**` area owns `apps`; a whole-checkout writer owns every folder).
  - The sessions route skips dot-folders and files.
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat(web): start a seat from a ticket; work in flight; crew sessions in Setup`.

### Task 11: The Update button

**Files:**
- Create: `apps/server/src/update.ts`.
- Modify: `apps/server/src/api.ts`, `apps/server/src/main.ts`, `apps/web/vite.config.ts` (`build.outDir` from `MC_WEB_OUTDIR`, default `dist`), `apps/web/src/pages/Setup.tsx` (toolbar), `docs/runbook.md`.
- Test: `apps/server/test/update.test.ts` (temp git repos; fake `pnpm` through an injected exec), `apps/server/test/api.test.ts`, `apps/web/test/Setup.test.tsx`.

**Interfaces:**
- `GET /api/version` → `{ sha: string; behind: number | null; checkedAt: number | null; canUpdate: boolean; reason: string | null }`. It runs `git fetch origin main` at most once per `VERSION_CHECK_MS = 10 * 60_000` (cached), then `rev-list --count HEAD..origin/main`. `canUpdate` is false, with a reason, for:
  - a preview (port ≠ `DEFAULT_PORT` or `MC_NO_LOOP_WRITES=1`): `"this is a preview server"`;
  - not on `main`: `"not on main"`;
  - uncommitted changes: `"the checkout has uncommitted changes"`;
  - any crew seat `running`: `"{CALL} is mid-turn"`.
- `POST /api/update` with body `{}`:
  - re-checks every condition (409 with the reason);
  - `behind === 0` → 200 `{ upToDate: true }`;
  - otherwise it runs in order, logging each step's output to `{MC_DB dir}/update.log`, mode 0600:
    1. `git pull --ff-only origin main`
    2. `pnpm install --frozen-lockfile`
    3. `pnpm --filter @mc/web build` with `MC_WEB_OUTDIR=dist-next`
    4. swap: rename `dist` to `dist-prev`, `dist-next` to `dist`, remove `dist-prev`
  - On success it responds 202 `{ restarting: true }`, then calls `supervisor.stopAll()` and exits 0 after 500 ms; launchd's `KeepAlive` restarts it (`ThrottleInterval` 30 s), and crew runs resume (Task 6).
  - A failure at any step → 500 `{ error: "update failed at {step}; see update.log" }`. The hub keeps running, and the old `dist` stays in place.
  - Every command is fixed text with no request input; each runs with a 5-minute timeout.
- **Setup toolbar:** `Version {sha7}` plus `· {n} commits behind main` when `behind > 0`, and [Update] (disabled with `title={reason}` when `!canUpdate`).
  - Confirm text: `Update to the latest main and restart? Crew runs resume after the restart.`
  - On 202: the toast `Updating… the HUD reconnects when the hub is back.` The existing SSE reconnect brings the page back.
- **Runbook:** the Update section points at the button and keeps the manual commands as the fallback. The preview command gains `MC_NO_CREW=1`.

- [ ] **Step 1: Write failing tests:**
  - `canUpdate` reasons for a dirty tree, a non-main branch, a preview and a running seat.
  - Up to date → `upToDate`.
  - The command order with fake exec.
  - A build failure leaves `dist` untouched and returns 500 naming `build`.
  - The swap leaves only `dist`.
  - Exit is scheduled only after 202 (inject the exit function).
  - The fetch cache honours `VERSION_CHECK_MS`.
  - The web toolbar renders the reasons and the confirm.
- [ ] **Step 2–4:** Run, implement, full checks. **Commit** `feat: update the hub from Setup`.

**Security note for the PR** (Tasks 5, 8, 11). The implementers draft it into their reports; the controller merges them into the PR:
- **New local actions, all on the operator's click on loopback,** behind the existing Host, JSON-POST and Origin checks:
  - start, message, interrupt and end a crew agent;
  - update the hub.
- **Crew agents:**
  - They run only inside Mission Control's own clone and worktrees root; the config refuses the live checkout and any loop directory.
  - They are isolated from the operator's hooks, MCP servers and CLAUDE.md.
  - Their tools are an allowlist, with push, `gh`, `git config`, network fetches and subagents denied by the CLI itself.
  - They bill to the operator's subscription (spike).
- **The server's own git writes** are branches and worktrees in its clone only.
- **No GitHub writes.**
- **Update** runs a fixed command list in the hub's own checkout. It refuses on a dirty tree, off main, in a preview, or with a crew turn running. It builds beside the live `dist` and swaps only on success.
- **Previews never run crew** (`MC_NO_CREW=1`), and the crew lock keeps a second server from adopting runs.

---

## After the tasks

- Final whole-branch review on the most capable model, then fixes on the branch.
- **PR:** `Phase 2a: the agent runtime and the first crew`, with the security note and the manual real-CLI records. It closes the phase 2a issue.
- **The operator's first crew.** These are setup steps, not code; the runbook gets a section for them.
  1. Create a GitHub Project for `mission-control`, or reuse one, and add the repo in Setup › Repos.
  2. `git clone git@github.com:octo-org/mission-control ~/code/mc-crew/mission-control`.
  3. Add the `crew` section from Task 1 to config.yaml.
  4. Press Update.
  5. From a small Ready ticket's panel, start GUIDO-1.
