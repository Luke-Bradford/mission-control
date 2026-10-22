# Control Centre — Plan 1: Spikes, Inventory, Observe Hub

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settle the two feasibility questions, inventory today's loop practices, and ship a read-only Control Centre that shows the two live loops (shop-app TA loop, studio build loop) as agents with runs, inferred tickets, cost, account limits, boards and escalations — with no change to how the loops run.

**Architecture:** A pnpm workspace with three packages. `packages/core` holds pure domain types and derivations (usage projections, run/agent state, ticket inference). `apps/server` is a Fastify process with collectors that tail the files the loops already write, poll usage and GitHub, store into SQLite via `node:sqlite`, and serve a JSON API plus SSE. `apps/web` is a React/Vite/Tailwind PWA that renders the Agents, Boards and Needs-you views from that API.

**Tech Stack:** Node 25 (verified v25.9.0), TypeScript (strict), pnpm 11 workspaces, Fastify, `node:sqlite` (`DatabaseSync`, verified working on Node 25), zod, yaml, `@octokit/graphql`, React + Vite + Tailwind, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-17-control-centre-design.md` (sections 1a, 4.2, 4.3, 4.3a, 4.5, 5, 6a). UI reference: `docs/prototype/control-centre-v19.html`.

## Global Constraints

- Node ≥ 25; no native npm dependencies (use `node:sqlite`, `node:crypto`).
- TypeScript `strict: true`; `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass before every commit.
- **Do not change how the adopted loops run.** The only write Control Centre makes into a loop's files in Plan 1 is creating/removing the TA loop's `var/autonomy/PAUSE` sentinel when you press pause/resume. GitHub access in Plan 1 is read-only.
- Parameterised SQL only — never interpolate values into SQL strings.
- All text from GitHub, transcripts and logs is untrusted: render as text (React default escaping); never `dangerouslySetInnerHTML`.
- Every `/api/*` route requires an authenticated session and checks the session belongs to the configured operator (authN ≠ authZ).
- The server binds to `127.0.0.1` only in Plan 1 (Tailscale access arrives in a later plan).
- Times are stored as UTC epoch ms and displayed in `Europe/London`.
- Amber (`#e3b341`) is used only for items that need the operator.
- Config path: `~/.config/control-centre/config.yaml`; data path: `~/.local/share/control-centre/cc.sqlite`.
- Usage samples are the source of truth for account limits; projection = latest sample + last-24h pace × hours to reset (spec 4.3a).

## Review Focus

1. **A log line half-written when read** (stream-json or `loop.log` mid-write) → the parser skips the incomplete trailing line and picks it up on the next read; never throws. *Test added in Task 8.*
2. **A configured loop whose directory or launchd job is missing** (e.g. `com.example.ownership-loop` points at a deleted folder) → that agent shows `error` with "source missing: <path>"; the rest of the hub keeps working. *Test added in Task 9.*
3. **Studio fire-log names in local time across a DST change** (fires either side of 25 Oct 2026, Europe/London) → parsed with the Europe/London zone, not as UTC. *Test added in Task 10.*
4. **Very large files** (iteration logs of tens of MB, 3k+ transcripts, a 152 MB error log) → collectors read incrementally from a stored byte offset and never load a whole history file at startup. *Test added in Task 8.*
5. **GitHub or the usage endpoint failing / rate-limited / token missing** → last known data is kept and shown with "stale since HH:MM"; no crash, no data wiped. *Test added in Task 13.*

---

## Phase 0 — Settle and inventory

### Task 1: Spike — can an Agent SDK session run on the Claude Max subscription?

**Files:**
- Create: `spikes/agent-sdk-subscription/run.mjs`, `spikes/agent-sdk-subscription/package.json`
- Create: `docs/spikes/2026-10-agent-sdk-subscription.md`

**Interfaces:**
- Produces: a recorded decision used by the CTO plan: `CTO_RUNTIME = "agent-sdk" | "cli-headless"`.

- [ ] **Step 1:** In `spikes/agent-sdk-subscription`, add `@anthropic-ai/claude-agent-sdk` (latest) and a script that runs one `query()` with prompt `"Reply with the word ok."`, `maxTurns: 1`, and prints every `system/init` and `result` message as JSON.
- [ ] **Step 2:** Run it with `ANTHROPIC_API_KEY` unset: `env -u ANTHROPIC_API_KEY node run.mjs`. Record whether it authenticates, the `apiKeySource` (or equivalent) field in `init`, and `total_cost_usd` in `result`.
- [ ] **Step 3:** Check the claude.ai usage page or the OAuth usage endpoint (Task 2) before and after a 20-turn run; record whether the subscription's 5h/7d utilisation moved.
- [ ] **Step 4:** Write `docs/spikes/2026-10-agent-sdk-subscription.md`: command run, raw evidence (redact tokens), and the decision — `agent-sdk` only if it authenticated without an API key **and** usage landed on the subscription; otherwise `cli-headless` (CTO runs as `claude -p` iterations like the existing loops). Update spec §4.1 "CTO" bullet in the same commit if the decision is `cli-headless`.
- [ ] **Step 5: Commit**
```bash
git add spikes/agent-sdk-subscription docs/spikes/2026-10-agent-sdk-subscription.md docs/superpowers/specs/2026-10-17-control-centre-design.md
git commit -m "docs: spike — Agent SDK on the Max subscription"
```

### Task 2: Spike — can account limits be read with no agent running?

**Files:**
- Create: `spikes/usage-readers/claude-usage.mjs`, `spikes/usage-readers/codex-ratelimits.mjs`
- Create: `docs/spikes/2026-10-usage-readers.md`

**Interfaces:**
- Produces: the exact request + response field paths Task 12 implements, recorded in the spike doc as two tables (`source`, `field path`, `meaning`, `example value`).

- [ ] **Step 1:** Read `~/code/site-builder/loop/claude_usage.py` for the Keychain service name and request it makes (`GET https://api.anthropic.com/api/oauth/usage`, header `anthropic-beta: oauth-2025-04-20`). Reproduce it in `claude-usage.mjs` reading the token with `security find-generic-password -s <service> -w`; print the response with the token redacted. Run it while no loop is mid-fire if possible.
- [ ] **Step 2:** In `codex-ratelimits.mjs`, start `codex app-server` over stdio, send `account/rateLimits/read`, print the response. Then read the newest `~/.codex/sessions/**/rollout-*.jsonl` and print the `rate_limits` object of its last `token_count` event.
- [ ] **Step 3:** Write the spike doc: for each source, the field paths for 5h/7d utilisation (0–1 or %), reset time, and whether it works with no session running. Record the fallback order Task 12 must use: Claude = OAuth usage endpoint → latest `rate_limit_event.rate_limit_info.unifiedWindows` from a transcript; Codex = app-server → latest rollout `token_count.rate_limits`.
- [ ] **Step 4: Commit**
```bash
git add spikes/usage-readers docs/spikes/2026-10-usage-readers.md
git commit -m "docs: spike — reading account limits with no agent running"
```

### Task 3: Inventory today's loop practices

**Files:**
- Create: the loop-practices inventory (kept outside the repo)

**Interfaces:**
- Produces: the practice table Plan 2 implements, one row per practice: `practice | where today (file:line) | common or repo-specific | proposed config key | default value | parity tests to port (file)`.

- [ ] **Step 1:** Read `~/code/.shop-app-autonomy/var/autonomy/bin/ta_loop.sh`, `~/code/studio-loop/drive.sh`, `~/code/studio-loop/run.sh`, `~/code/site-builder/engine/bin/safe_merge.sh`, `board.sh`, `loop/claude_usage.py`, `engine/lib/dashboard_state.py` (SD-32 parser), both repos' `.autonomy/config.yaml`, `hard_rules.md`, loop prompts, and `.claude/CLAUDE.md` workflow sections.
- [ ] **Step 2:** Fill the table. It must contain at least these rows: invocation flags per loop; prompt sync from `origin/main`; worktree reset to `origin/main`; cooldown between iterations (`TA_LOOP_COOLDOWN=120`); blocked-pass sleep (1800 s, sentinel wake time, cap 43200 s); stop after 3 consecutive failures (TA) / 3 stalls or 5 crashes (studio); tool-call budget (~250 soft / ~400 hard); quota guard (`QUOTA_STOP_PCT=80`, fail closed, `.last_quota` cache); work queue source (#2437 comment; `prompt.md` queue); branch naming; PR → review bot → CI polling; Codex checkpoints; `safe_merge.sh` gate; `board.sh` status moves; escalation formats (`[operator-decision]`, `[loop-blocked]`, `[mvp-ready]`, SD-32 `autonomy-question`); PAUSE sentinel; hard rules; telemetry each writes.
- [ ] **Step 3:** List the existing test files that pin each practice (e.g. `loop/test_quota_guard.sh`, `shop-app/tests/test_ta_loop_*.py`, the SD-32 parser tests) in the last column.
- [ ] **Step 4:** Save the inventory (kept outside the repo).

---

## Phase 1 — Observe hub

### Task 4: Workspace scaffold and core types

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `.github/workflows/ci.yml`
- Create: `packages/core/package.json`, `packages/core/src/types.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/types.test.ts`

**Interfaces:**
- Produces (in `packages/core/src/types.ts`, re-exported from `@cc/core`):
```ts
export type RepoId = string; export type AgentId = string; export type AccountId = string;
export type AgentState = 'working' | 'waiting-agent' | 'waiting-you' | 'idle' | 'error';
export type TicketState = 'planned' | 'in progress' | 'review' | 'blocked' | 'done';
export type RunStatus = 'running' | 'ok' | 'failed' | 'blocked' | 'unknown';
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheCreate: number }
export interface Run { id: string; agentId: AgentId; repoId: RepoId; seq: number; startedAt: number; endedAt: number | null; status: RunStatus; sessionId: string | null; model: string | null; branch: string | null; ticket: string | null; costUsd: number | null; tokens: TokenUsage | null; transcriptPath: string }
export interface UsageSample { accountId: AccountId; window: '5h' | '7d'; at: number; pct: number; resetAt: number; source: string }
export interface AutonomyQuestion { question: string; recommendation: string; reasoning_quote: string; effort_sunk: string; default_if_ignored: string; answers: string[] }
export interface Escalation { id: string; repoId: RepoId; issueNumber: number; title: string; kind: 'operator-decision' | 'loop-blocked' | 'mvp-ready' | 'autonomy-question'; openedAt: number; url: string; question: AutonomyQuestion | null }
export interface BoardItem { repoId: RepoId; issueNumber: number; title: string; status: string; state: TicketState; labels: string[]; priority: string | null; updatedAt: number; url: string }
export interface AgentView { id: AgentId; repoId: RepoId; loopKind: 'ta-loop' | 'studio-loop'; accountId: AccountId; state: AgentState; stateSince: number; currentRun: Run | null; paused: boolean; sourceError: string | null }
```

- [ ] **Step 1:** Root `package.json` scripts: `lint` = `biome check .`, `typecheck` = `pnpm -r exec tsc --noEmit`, `test` = `vitest run`. CI workflow runs `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` on pull requests.
- [ ] **Step 2:** Write `types.test.ts` asserting a literal `Run` and `AgentView` object type-check (use `satisfies`) — the test exists so the package builds under Vitest.
- [ ] **Step 3:** Run `pnpm install && pnpm lint && pnpm typecheck && pnpm test` — expected: all pass.
- [ ] **Step 4: Commit** `chore: workspace scaffold and core types`

### Task 5: Usage derivations

**Files:**
- Create: `packages/core/src/usage.ts`
- Test: `packages/core/test/usage.test.ts`

**Interfaces:**
- Consumes: `UsageSample` (Task 4).
- Produces:
```ts
export function usageAt(samples: UsageSample[], at: number): number | null           // linear interpolation; null if no samples
export function pace24h(samples: UsageSample[], at?: number): number | null          // %-points per hour over the 24h before `at` (default: last sample)
export function projectAtReset(samples: UsageSample[], resetAt: number, at?: number): number | null
export function stopForecast(samples: UsageSample[], stopAt: number, resetAt: number): number | null  // epoch ms or null if not before reset
export function latestCrossing(samples: UsageSample[], pred: (s: UsageSample, i: number) => boolean): number | null // epoch ms of the latest false→true sample transition
```

- [ ] **Step 1: Write failing tests** using samples every 30 min, `t0 = Date.UTC(2026,9,17,1,41)`, 7d window `resetAt = t0 + 48h`:
```ts
const s = (h: number, pct: number) => ({ accountId:'codex', window:'7d' as const, at: t0 + h*3600e3, pct, resetAt, source:'test' });
const lin = [s(-24, 50), s(-12, 56), s(0, 62)];
expect(usageAt(lin, t0 - 6*3600e3)).toBeCloseTo(59);
expect(pace24h(lin)).toBeCloseTo(0.5);
expect(projectAtReset(lin, resetAt)).toBeCloseTo(86);
expect(stopForecast(lin, 80, resetAt)).toBe(t0 + 36*3600e3);
expect(stopForecast(lin, 90, resetAt)).toBeNull();
expect(latestCrossing([s(-2,40),s(-1,60),s(0,40),s(1,70)], x => x.pct >= 50)).toBe(t0 + 3600e3);
expect(usageAt([], t0)).toBeNull();
```
- [ ] **Step 2:** Run `pnpm vitest run packages/core/test/usage.test.ts` — expected FAIL (module not found).
- [ ] **Step 3:** Implement in `packages/core/src/usage.ts` (port of the prototype's `uAt/pace24/projAt/stopForecast/firstSample`; samples sorted by `at` inside each function).
- [ ] **Step 4:** Run the test — expected PASS.
- [ ] **Step 5: Commit** `feat(core): usage projections from samples`

### Task 6: Run and agent derivations

**Files:**
- Create: `packages/core/src/runs.ts`
- Test: `packages/core/test/runs.test.ts`

**Interfaces:**
- Consumes: `Run`, `AgentState` (Task 4).
- Produces:
```ts
export function inferTicket(branch: string | null, repoId: RepoId): string | null
export function agentState(input: { runs: Run[]; paused: boolean; sourceError: string | null; waitingOnOperator: boolean }): { state: AgentState; since: number }
```
- [ ] **Step 1: Write failing tests:**
```ts
expect(inferTicket('fix/3349-cart-total-rounding','shop-app')).toBe('shop-app#3349');
expect(inferTicket('feature/3822-wishlist-sync','shop-app')).toBe('shop-app#3822');
expect(inferTicket('feat/studio-1745-run-panel','site-builder')).toBe('site-builder#1745');
expect(inferTicket('fix/loop-812-x','site-builder')).toBe('site-builder#812');
expect(inferTicket('main',"shop-app")).toBeNull();
expect(inferTicket(null,'shop-app')).toBeNull();
// agentState: sourceError wins → 'error'; running run → 'working' since run.startedAt;
// latest run status 'blocked' or waitingOnOperator → 'waiting-you'; paused with no running run → 'idle';
// no runs → 'idle' since 0
```
- [ ] **Step 2:** Run — expected FAIL.
- [ ] **Step 3:** Implement. `inferTicket` regex: `^(?:fix|feature|feat)\/(?:studio-|loop-)?(\d+)(?:-|$)`.
- [ ] **Step 4:** Run — expected PASS.
- [ ] **Step 5: Commit** `feat(core): ticket inference and agent state`

### Task 7: Config loader

**Files:**
- Create: `apps/server/package.json`, `apps/server/src/config.ts`, `config.example.yaml`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AdoptedLoop { id: AgentId; repoId: RepoId; kind: 'ta-loop' | 'studio-loop'; accountId: AccountId; stateDir: string; worktree: string; launchdLabel: string; logsDir?: string }
export interface CcConfig { operator: { timezone: string; passwordHash: string }; accounts: { id: AccountId; vendor: 'claude' | 'codex'; alertAt: number; stopAt: number }[]; repos: { id: RepoId; github: string; project: number; statusMap: Record<string, TicketState> }[]; loops: AdoptedLoop[]; poll: { usageMinutes: number; githubSeconds: number } }
export function loadConfig(path: string): CcConfig   // throws ConfigError with the offending key path
```
- [ ] **Step 1:** `config.example.yaml` with the real values: accounts `claude-main` (claude, alert 85, stop 95) and `codex-main` (codex, alert 70, stop 80); repos `shop-app` (`octo-org/shop-app`, project 2) and `site-builder` (`octo-org/site-builder`, project 3) with their Status → state maps from the prototype; loops `shop-app-ta` (ta-loop, stateDir `~/code/.shop-app-autonomy/var/autonomy`, worktree `~/code/.shop-app-autonomy`, launchd `com.example.ta-loop`, account claude-main) and `studio-builder` (studio-loop, logsDir `~/code/studio-loop/logs`, stateDir `~/code/studio-loop`, worktree `~/code/studio-loop-repo`, launchd `com.example.build-driver`, account claude-main); poll usage 30 min, GitHub 60 s.
- [ ] **Step 2: Write failing tests:** example loads; `~` expands to `os.homedir()`; a loop whose `repoId` is not in `repos` throws `ConfigError` mentioning `loops[0].repoId`; a `statusMap` value outside `TicketState` throws.
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement with zod + `yaml`. **Step 5:** Run — PASS.
- [ ] **Step 6: Commit** `feat(server): config loader with real adopted loops`

### Task 8: Store and incremental stream-json reader

**Files:**
- Create: `apps/server/src/store.ts`, `apps/server/src/tail.ts`, `apps/server/src/streamjson.ts`
- Test: `apps/server/test/store.test.ts`, `apps/server/test/tail.test.ts`, `apps/server/test/streamjson.test.ts`, fixtures `apps/server/test/fixtures/iteration.sample.log`

**Interfaces:**
- Produces:
```ts
// store.ts — node:sqlite DatabaseSync; tables: runs, usage_samples, escalations, board_items, file_offsets, collector_status
export class Store { constructor(path: string); upsertRun(r: Run): void; runs(agentId: AgentId, limit: number): Run[]; addUsage(s: UsageSample): void; usage(accountId: AccountId, window: '5h'|'7d', sinceMs: number): UsageSample[]; replaceEscalations(repoId: RepoId, e: Escalation[]): void; escalations(): Escalation[]; replaceBoard(repoId: RepoId, items: BoardItem[]): void; board(repoId: RepoId): BoardItem[]; getOffset(path: string): number; setOffset(path: string, offset: number): void; setStatus(collector: string, ok: boolean, error: string | null): void; status(): { collector: string; ok: boolean; error: string | null; at: number }[] }
// tail.ts
export function readNewLines(path: string, fromOffset: number): { lines: string[]; nextOffset: number }  // complete lines only
// streamjson.ts
export interface TranscriptFacts { sessionId: string | null; model: string | null; permissionMode: string | null; branch: string | null; costUsd: number | null; tokens: TokenUsage; resultCount: number; isError: boolean; rateLimits: { window: '5h'|'7d'; utilization: number; resetsAt: number; at: number }[] }
export function foldTranscript(prev: TranscriptFacts | null, lines: string[], fileMtime: number): TranscriptFacts
```
- [ ] **Step 1:** Create the fixture by copying ~40 lines from a real TA iteration log — the `system/init`, one `rate_limit_event`, one `system/vcs_state_changed` (branch `fix/3757-fence-reacquire`), two `assistant` messages with `message.id` and `message.usage`, one `result` — with any token-like strings replaced.
- [ ] **Step 2: Write failing tests:**
  - `store.test.ts`: upsertRun twice with the same id keeps one row with the latest fields; usage returns samples ordered by `at`; values with quotes/semicolons round-trip unchanged (parameterised SQL).
  - `tail.test.ts`: a file ending without `\n` returns only complete lines and `nextOffset` at the last newline; appending the rest returns that line next call; a 50 MB file read from offset `size-1000` returns only the tail (assert elapsed < 200 ms).
  - `streamjson.test.ts`: folding the fixture gives `sessionId` from init, `model` `claude-opus-5-5`, `branch` `fix/3757-fence-reacquire`, `costUsd` = the `result.total_cost_usd`, tokens = the sum of `assistant.message.usage` de-duplicated on `message.id` (the method `fire_stats.sh` uses), `rateLimits` containing 5h 0.07 and 7d 0.41; a non-JSON line and a truncated JSON line are skipped without throwing.
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement. **Step 5:** Run — PASS.
- [ ] **Step 6: Commit** `feat(server): sqlite store, incremental tail, transcript folding`

### Task 9: TA loop collector

**Files:**
- Create: `apps/server/src/collectors/ta-loop.ts`
- Test: `apps/server/test/ta-loop.test.ts`, fixtures `test/fixtures/ta/loop.log`, `test/fixtures/ta/status.md`

**Interfaces:**
- Consumes: `AdoptedLoop` (Task 7), `Store`, `readNewLines`, `foldTranscript` (Task 8), `inferTicket` (Task 6).
- Produces:
```ts
export function parseLoopLog(lines: string[]): { seq: number; event: 'start' | 'ok' | 'failed' | 'blocked'; at: number; transcript: string | null; rc: number | null }[]
export function parseStatusMd(text: string): { seq: number; inFlight: boolean; startedAt: number; pid: number; transcript: string } | null
export async function collectTaLoop(loop: AdoptedLoop, store: Store, now: number): Promise<void>  // upserts runs; sets collector_status
export function isPaused(loop: AdoptedLoop): boolean   // exists(stateDir/PAUSE)
```
- [ ] **Step 1:** Fixtures from the real formats: `loop.log` lines such as `2026-10-17T06:10:49Z --- iteration 9 OK (transcript: iteration-20261017T032442Z-7522.9.log)`, `2026-10-17T09:05:12Z --- iteration 11 start`, a `FAILED rc=1` line and a `blocked pass -- sleeping 1800s until wake time …` line; `status.md` with `- iteration: **11** — IN FLIGHT`, `- started: 2026-10-17T09:05:12Z`, `- pid: 7522`, `- transcript: \`…/iteration-20261017T090512Z-7522.11.log\``.
- [ ] **Step 2: Write failing tests:** parseLoopLog returns seq 9 ok with transcript name, seq 11 start; parseStatusMd returns seq 11 inFlight, pid 7522; `collectTaLoop` against a temp dir copy of the fixtures upserts run `shop-app-ta:11` with status `running`, `ticket` from the transcript's branch via `inferTicket`; **a loop whose `stateDir` does not exist sets collector_status `ok=false`, error `source missing: <stateDir>` and does not throw** (Review Focus 2).
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement; run ids are `${loop.id}:${seq}`; transcript reads use `file_offsets`. **Step 5:** Run — PASS.
- [ ] **Step 6: Commit** `feat(server): TA loop collector`

### Task 10: Studio loop collector

**Files:**
- Create: `apps/server/src/collectors/studio-loop.ts`
- Test: `apps/server/test/studio-loop.test.ts`, fixtures `test/fixtures/studio/driver.log`, `test/fixtures/studio/fire.20261017-112003.log`

**Interfaces:**
- Produces:
```ts
export function parseDriverLog(lines: string[]): { kind: 'fire-start' | 'fire-exit' | 'quota' | 'stop'; at: number; fire?: number; rc?: number; pct?: number; reason?: string }[]
export function fireLogStartedAt(fileName: string, tz: string): number   // 'fire.YYYYMMDD-HHMMSS.log' in local time
export async function collectStudioLoop(loop: AdoptedLoop, store: Store, tz: string, now: number): Promise<void>
```
- [ ] **Step 1:** Fixtures from real lines: `[2026-10-17T08:17:53Z] === FIRE 42 (main=6468d94 openPR=0) ===`, `[2026-10-17T10:19:46Z] fire 42 exited 0`, `[2026-10-17T10:19:55Z] quota ok: 7-day utilization 45% (< 80%)`; fire log starting `=== studio-build-loop fire 20261017-112003 START (repo=…) ===` followed by stream-json lines.
- [ ] **Step 2: Write failing tests:** driver parse yields fire 42 start/exit rc 0 and quota 45; `fireLogStartedAt('fire.20261017-112003.log','Europe/London')` = `Date.UTC(2026,9,17,10,20,3)`; **`fireLogStartedAt('fire.20261024-120000.log','Europe/London')` = `Date.UTC(2026,9,24,11,0,0)` (BST) and `fire.20261025-030000.log` = `Date.UTC(2026,9,25,3,0,0)` (GMT; clocks go back at 02:00 BST on Sun 25 Oct 2026 → Review Focus 3)**; collector upserts run `studio-builder:42` status `ok`, and the banner line is skipped by the transcript fold.
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement (`Intl.DateTimeFormat` offset lookup for the zone). **Step 5:** Run — PASS.
- [ ] **Step 6: Commit** `feat(server): studio loop collector`

### Task 11: Live session registry

**Files:**
- Create: `apps/server/src/collectors/sessions.ts`
- Test: `apps/server/test/sessions.test.ts`

**Interfaces:**
- Produces:
```ts
export interface LiveSession { pid: number; sessionId: string; cwd: string; startedAt: number; status: 'busy' | 'idle' | null; name: string; alive: boolean }
export function readSessions(dir: string, isAlive: (pid: number) => boolean): LiveSession[]   // dir = ~/.claude/sessions
export function sessionForLoop(sessions: LiveSession[], loop: AdoptedLoop): LiveSession | null  // match on cwd === loop.worktree, newest startedAt, alive
```
- [ ] **Step 1: Write failing tests** with temp JSON files shaped like the real registry (`pid`, `sessionId`, `cwd`, `startedAt`, `status`, `name`): matches the loop by cwd; ignores dead pids; tolerates a malformed file.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement; `isAlive` default = `process.kill(pid, 0)` in try/catch. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(server): live session registry`

### Task 12: Usage collectors

**Files:**
- Create: `apps/server/src/collectors/usage-claude.ts`, `apps/server/src/collectors/usage-codex.ts`
- Test: `apps/server/test/usage-collectors.test.ts`

**Interfaces:**
- Consumes: the field paths and fallback order recorded in `docs/spikes/2026-10-usage-readers.md` (Task 2); `Store.addUsage`.
- Produces:
```ts
export async function sampleClaude(acct: AccountId, deps: { fetchUsage: () => Promise<unknown>; latestTranscriptLimits: () => TranscriptFacts['rateLimits'] }, now: number): Promise<UsageSample[]>
export async function sampleCodex(acct: AccountId, deps: { appServer: () => Promise<unknown>; latestRollout: () => unknown }, now: number): Promise<UsageSample[]>
```
- [ ] **Step 1: Write failing tests** with stubbed deps: a primary response maps to 5h and 7d samples with `pct` in 0–100 and `source` `'oauth-usage'`; when the primary throws, the fallback is used with `source` `'transcript'`/`'rollout'`; when both fail it returns `[]` and the caller records collector status error (Review Focus 5 for usage).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement; the Keychain token is read by the server only via `security find-generic-password` and never logged. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(server): account usage sampling`

### Task 13: GitHub collector — boards and escalations

**Files:**
- Create: `apps/server/src/collectors/github.ts`, `apps/server/src/sd32.ts`
- Test: `apps/server/test/sd32.test.ts`, `apps/server/test/github.test.ts`

**Interfaces:**
- Produces:
```ts
export function parseAutonomyQuestion(comments: { body: string; createdAt: string }[]): AutonomyQuestion | null
export async function collectGithub(repo: CcConfig['repos'][number], store: Store, gql: (query: string, vars: Record<string, unknown>) => Promise<any>, now: number): Promise<void>
```
- [ ] **Step 1: Write failing tests for SD-32** (parity with `engine/lib/dashboard_state.py` `parse_autonomy_question` — port its test cases from the site-builder test suite listed in the inventory): fence ```` ```autonomy-question ```` tolerant of trailing whitespace and CRLF; object must have exactly the six keys, five strings, `answers` 1–3 strings, else `null`; the newest comment containing a fence wins; a newer prose-only comment does not mask it; a garbage newest block yields `null` (no fallback to older).
- [ ] **Step 2: Write failing tests for the collector** with a stubbed `gql`: Projects v2 items map Status via `statusMap` to `TicketState`; issues titled `[operator-decision] …`, `[loop-blocked] …`, `[mvp-ready] …` become escalations of that kind; **when `gql` rejects, existing board and escalation rows are kept and collector_status records `ok=false` with the error and time (Review Focus 5)**.
- [ ] **Step 3:** Run — FAIL. **Step 4:** Implement; token from `gh auth token` read once at startup, kept in memory, all queries use GraphQL variables. **Step 5:** Run — PASS.
- [ ] **Step 6: Commit** `feat(server): GitHub boards and escalations (read-only)`

### Task 14: Server — auth, API, SSE, scheduler, pause control

**Files:**
- Create: `apps/server/src/auth.ts`, `apps/server/src/api.ts`, `apps/server/src/main.ts`, `apps/server/src/scheduler.ts`
- Test: `apps/server/test/api.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces HTTP (all JSON, all behind auth except `/login`):
  - `POST /login {password}` → sets cookie `cc_session` (httpOnly, sameSite=strict, secure when not on localhost); `POST /logout`.
  - `GET /api/agents` → `AgentView[]`; `GET /api/agents/:id/runs?limit=50` → `Run[]`.
  - `GET /api/limits` → `{ accountId, window, used, projected, stopForecast, resetAt, alertAt, stopAt, stale: boolean }[]` computed with Task 5 functions.
  - `GET /api/boards/:repoId` → `BoardItem[]`; `GET /api/escalations` → `Escalation[]`; `GET /api/health` → collector status rows.
  - `POST /api/agents/:id/pause` / `resume` → TA loop only: create/remove `stateDir/PAUSE`; studio loop → `409 {error:"pause for studio-loop arrives with cutover"}`.
  - `GET /api/stream` (SSE) → `event: changed` with `{topic: 'agents'|'limits'|'boards'|'escalations'}` after any collector write.
- [ ] **Step 1: Write failing tests** (Fastify `inject`): unauthenticated `/api/agents` → 401; wrong password → 401 with no cookie; correct password → cookie; a session whose operator id differs from config → 403 (authZ); pause on `shop-app-ta` creates `PAUSE` in a temp `stateDir` and `agents` then shows `paused: true`; pause on `studio-builder` → 409; `/api/limits` with seeded samples returns `projected` equal to `projectAtReset` for those samples.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Password hash = `node:crypto` `scrypt` (N=2^15, r=8, p=1, 16-byte salt) stored as `scrypt$N$r$p$salt$hash` in `operator.passwordHash`; add `pnpm cc:hash-password` script. Scheduler: TA/studio/sessions every 15 s, GitHub every `poll.githubSeconds`, usage every `poll.usageMinutes`. Listen on `127.0.0.1:7420`.
- [ ] **Step 4:** Run — PASS. Update spec §6a "Login" bullet from argon2 to scrypt (`node:crypto`, no native dependency) in the same commit.
- [ ] **Step 5: Commit** `feat(server): authenticated API, SSE and scheduler`

### Task 15: Web — Agents, Needs you, Boards, limits header

**Files:**
- Create: `apps/web/` (Vite React TS + Tailwind), `apps/web/src/api.ts`, `apps/web/src/pages/{Agents,Boards,NeedsYou,Login}.tsx`, `apps/web/src/components/{LimitsHeader,AgentCard,RunDrawer,BoardColumn}.tsx`, `apps/web/src/theme.css`
- Test: `apps/web/test/*.test.tsx` (Vitest + Testing Library)

**Interfaces:**
- Consumes: the HTTP API of Task 14.
- Produces: routes `/login`, `/` (Agents), `/needs-you`, `/boards/:repoId`; dev proxy to `127.0.0.1:7420`.

- [ ] **Step 1: Write failing tests:**
  - `LimitsHeader` renders `codex-main 7d 69%→103%` for `{used:69, projected:103}` with the projection in the red class when > 100, and shows `stale since HH:MM` when `stale`.
  - `AgentCard` for an agent with `currentRun.ticket = 'shop-app#3349'` shows the ticket, model, run seq, elapsed, cost `$2.47`, and state `working`; a `sourceError` shows the error text and state `error`.
  - `NeedsYou` lists escalations oldest-first with kind, repo, age and a link to the issue; items use the amber class; an `AutonomyQuestion` shows its recommendation and up to three answers as plain text.
  - Text containing `<img src=x onerror=alert(1)>` in an issue title renders literally (no element created).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. Copy colour tokens and the dense table/card styles from `docs/prototype/control-centre-v19.html` `:root`; tabs Agents · Needs you · Boards; SSE subscription refetches the changed topic; below 760 px the layout is single-column with the limits strip kept visible (prototype phone CSS).
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): observe hub — agents, needs-you, boards`

### Task 16: Run it for real and document

**Files:**
- Create: `README.md` (replace), `ops/com.controlcentre.server.plist.tmpl`, `docs/runbook.md`

- [ ] **Step 1:** Start against the real config (`cp config.example.yaml ~/.config/control-centre/config.yaml`, set the password hash): `pnpm --filter server start` and `pnpm --filter web dev`.
- [ ] **Step 2:** Verify by hand and record in `docs/runbook.md` with screenshots: both agents appear; the TA loop's current iteration number matches `var/autonomy/status.md`; the studio fire number matches the last `=== FIRE N` in `driver.log`; the claude 7d % is within 1 point of `~/code/studio-loop/.last_quota`; the shop-app board columns match GitHub project 2; `/api/health` shows every collector `ok` (or a named, explained error).
- [ ] **Step 3:** Verify the loops were untouched: `git -C ~/code/.shop-app-autonomy status` and `git -C ~/code/studio-loop-repo status` unchanged versus before start; `launchctl list | grep -E 'ta-loop|studio-build'` shows the same pids; no files in either `stateDir` modified by Control Centre except `PAUSE` when exercised.
- [ ] **Step 4:** Add the launchd template (KeepAlive, `127.0.0.1` only) and README run instructions; do not load it automatically.
- [ ] **Step 5: Commit** `docs: runbook and launchd template for the observe hub`

---

## Later plans (each written when the previous one ships)

- **Plan 2 — Master common practices.** Implement the inventory's common rows in Control Centre as configurable practices with the ported parity tests (prompt sync, worktree reset, cooldown, blocked-pass wake, failure stop, tool budgets, quota guard, queue sources, PR/review/CI polling, Codex checkpoints, `safe_merge`, `board.sh`, SD-32 writing), plus the agent runtime (launch `claude -p` / `codex exec` in the repo worktree, layered instructions, records ticket/step/cost per run).
- **Plan 3 — Cut over.** shop-app TA loop first, then the studio loop: Control Centre launches the same prompt and rules, old launchd job unloaded, side-by-side comparison of runs; uniform pause/resume for every agent.
- **Plan 4 — CTO and access.** CTO runtime per the Task 1 decision, rules/watches/escalation answering (writes back to GitHub), proposals, plan, digest, Tailscale HTTPS, web push to iPhone/Watch.
- **Plan 5 — Full UI.** Loops (diagram + attempt grids), CTO page, Metrics (history records, KPIs), Config editor with glossary, as in the v19 prototype.
- **Plan 6 — Retire the old engine.** PR to site-builder removing `engine/`, `loop/`, the :8787 dashboard and dead launchd jobs.
- **Plan 7 — Extend.** More agents per repo, moving agents between repos, new-repo rules templates, GitHub App identity, per-role permission allow-lists and plugin/connector scoping, branch apps.
