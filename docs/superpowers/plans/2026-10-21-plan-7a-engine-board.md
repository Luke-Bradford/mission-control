# Plan 7a — The first loop: board to merged PR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seat takes its next Ready ticket from the board on its own; when it reports the work done, Mission Control pushes, opens the draft PR, waits for CI, feeds a CI failure back to the seat, moves the card to In review when CI passes, and starts the seat's next ticket when the PR merges. The controller only reviews and merges.

**Architecture:**
- **One implicit loop, four phases:** `working` → `ci` → `review` → (merged: the run ends, the next ticket starts), plus `parked`, entered on any limit, with a Needs-you item and the card Blocked. Templates, gates and multi-step nodes (design §5) come in a later plan once this runs; this is the smallest loop that takes the controller off push, PR, CI-watching, card moves and starting the next ticket.
- **Level-triggered reconciliation.** A pure function in `@mc/core`, `reconcile(snapshot) → { loop, actions }`, runs for each looped run on every trigger (the 60 s tick, a seat leaving a turn, `report_evidence`, the GitHub poll). It decides from **durable facts only**: the run's evidence rows, the last pushed sha (Plan 6's `run_pushes`), the PR row (state, draft, head sha, CI rollup, mergeable), the card's column, the seat's state, and the keyed lines already sent. A lost trigger does not matter: the next tick re-derives the same decision. Every action is idempotent or keyed.
- **Sends are keyed and at-most-once.** Each engine line has a key (`ci:<runId>:<sha>`, `refused:<runId>:<evidenceId>`, `nudge:<runId>:<n>`, `resume:<runId>:<hubStart>`); the key row is inserted first (unique), the line written second. A crash between them loses that one line; the nudge rule recovers the seat.
- **The engine writes to a seat only between turns** (`!l.inTurn`, checked inside the seat's queue), so its lines never fold into a turn the operator started.
- **Verify is CI.** The hub runs no worktree code; it reads the PR's `statusCheckRollup` for the pushed head sha. CI is a gate, not a proof: a seat can still weaken a test it may edit, which is what review (the controller now, RETRO in 7b) is for.
- **The board is the queue.** Seats' queues are filled by rule (Priority, then age, filtered by area labels). The setup action creates the Priority and Size fields and the type and area labels.

**Tech Stack:** As Plans 5–6. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-build-loop-flight-design.md` §4, §5 ("Verify runs on CI"), §9, §12, §16 item 1 (as revised alongside this plan). Parent: `docs/superpowers/specs/2026-10-18-mission-control-design.md` §4.3, §8a. **Prerequisite: Plan 6 (merged).**

## Scope and stated deviations

In: records; supervisor events and the between-turns send; `report_evidence`; repo rules and `autonomy`; board writes and the setup action; `reconcile`; the engine server (push, draft PR, CI read, card moves, Needs-you items); queues and picking; the HUD's loop phase; the end-to-end test.

Out (later plans): templates and per-node checks, go/no-go and hard-rule asks, retries with escalation to a stronger model, RETRO review and the merge gate (7b), FLIGHT (7c), the update policy (7d), a hub-run check runner.

Deviations, each deliberate:
- **The supervisor starts seats on its own**, only in a `merge` repo (spec §8a.3).
- **Push and draft PR are engine actions**; `MC_TOOLS.push` and `MC_TOOLS.draftPr` leave the seat's tool lists.
- **No templates or per-step checks in 7a** (design §5's engine is the target; 7a ships one implicit loop). **Hard-rule files are flagged, not gated**: a PR touching one gets a Needs-you note, and since the controller merges by hand in 7a nothing auto-merges.
- **Blocked moves** are an outward write §8a.3 does not name; design §12 declares it.
- **A two-area ticket is not queued** and raises a Needs-you question.
- **`pick_from` is read; only `Ready` is honoured** (Backlog promotion is FLIGHT's, 7c).

## Global Constraints

- **Everything in Plans 3–6 still holds.** The hub runs only `git` and `gh` against a run.
- **GitHub writes added, exactly:** (1) board Status moves of a run's own ticket to `In progress`, `In review`, `Blocked` in a `merge` repo, via `updateProjectV2ItemFieldValue`; (2) the setup action's `createProjectV2Field` (Priority, Size) and `createLabel` (type and area labels), on the operator's click only. Push and the draft PR stay Plan 6's writes, made by the engine. **GitHub reads added:** `gh run list --repo=<owner/name> --commit=<sha>` and `gh run view --repo=<owner/name> <id> --log-failed` (a CI failure's excerpt); `gh pr list` by head branch (finding an already-open PR); the project's field and option ids (`FIELDS_QUERY`) and the repository id for `createLabel`. **Done is not moved by the engine:** the PR's `Closes #n` and the project's own workflow close the issue and move the card on merge (design §4 says the engine moves it; 7a leaves that to GitHub).
- **Every seat-derived string that reaches GitHub passes Plan 6's filters:** commit messages through `firstCommitNotifier` (also in the commit tool, so the seat can reword before anything is pushed); the evidence note through `firstPrNotifier` at `report_evidence`; the PR title and body through `openDraftPr`'s own checks. No new filter.
- **The engine is off** when crew is disabled, in a preview, or with `MC_NO_LOOP_WRITES=1`: no reconcile, no actions, no takes.
- **Exact copy in `@mc/core`** (`packages/core/src/loop.ts`).
- **The engine is off in previews** as well; it is trialled through the e2e test and then on the live hub with a `draft` repo first (no board moves), then `merge`.
- **Constants:** `ENGINE_TICK_MS = 60_000`, `QUEUE_DEPTH = 3`, `CI_TRIES = 3`, `REFUSAL_TRIES = 3`, `CI_PENDING_MAX_MS = 30 * 60_000`, `NO_CI_AFTER_MS = 10 * 60_000`, `CI_EXCERPT_LINES = 80`, `CI_EXCERPT_MAX = 8192`, `TAKE_STALE_MS = 5 * 60_000`.

## Review Focus

1. **Nothing is lost across an Update.** Cases: restart after `report_evidence` but before the push; after the push but before the PR; after the PR but before the card move; with a CI excerpt due; mid-turn (the seat's turn cut short); with a queue row taken but no run started. Expected: the next reconcile pushes (Plan 6 answers "Already on origin" if done), finds the open PR by branch, moves the card (no-op if there), sends the excerpt once (keyed), sends one "carry on" line to the resumed seat, untakes the stale row. → Tasks 1, 5, 6, 7.
2. **The seat cannot drive the loop past its gates.** Cases: `report_evidence` with uncommitted changes, with no new commit, with a mention in the note; reporting while in `ci`; reporting while parked. Expected: refused with the reason each time. Nothing the seat sends moves a card, ends a run or starts a ticket. → Tasks 2, 5.
3. **Limits park visibly.** Cases: CI fails `CI_TRIES` times; the same push refusal `REFUSAL_TRIES` times; CI pending past 30 min; no CI after 10 min; the PR conflicts with main; the PR closed unmerged; the seat idle twice without reporting; Stop or a crash; the run's token budget. Expected: parked with the exact text, card Blocked, one Needs-you item; the operator's message to the seat un-parks (except a run that has ended). → Tasks 5, 6.
4. **Board writes are idempotent.** Cases: already in the column; two options mapping to review; unknown item id; a 502; a `draft` repo. Expected: no call; the one named `In review`; poll then retry; one retry then a failed row; no call. → Task 4.
5. **Two seats, one ticket.** Cases: two seats matching one card; a two-area card; a `research` card; a card moved out of Ready before the take; a hand-start in a `merge` repo, in a `draft` repo, of a read-only seat. Expected: one take; one question; skipped; skipped; looped with In progress / looped with no board moves / no loop. → Task 7.

---

### Task 1: Records

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/views.ts` (`ActivityKind` gains `loop`, `board`, `push`), `apps/server/src/store.ts`, `apps/server/src/collectors/github.ts` (the PR query's `commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }` gains `oid`, and the PR selects `mergeable`; `PullRequestView.headSha: string | null`, `PullRequestView.mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null`; `BoardItem.createdAt`, `itemId`, the project id).
- Test: `apps/server/test/store.test.ts`, `apps/server/test/github.test.ts`.

**Interfaces:**
- Core: `type LoopPhase = "working" | "ci" | "review" | "parked" | "done"`; `RunLoop` as Task 5 defines it (the type lives in `packages/core/src/types.ts`); `Run.loop?: RunLoop | null`; `Run.endedBy?: "operator" | "engine" | "exit" | null`.
- Store (migrations idempotent):
  - `runs` gains `loop TEXT` (JSON) and `ended_by TEXT`; `upsertRun`'s `ON CONFLICT` lists only the Plan-5 columns; `setRunLoop(runId, loop)`; `setRunEnded(runId, at, status, endedBy)`.
  - `pull_requests` gains `head_sha TEXT` and `mergeable TEXT`, written by the existing upsert, and `polled_at`.
  - `run_evidence(id INTEGER PRIMARY KEY, run_id, note, at)` (append-only): `addEvidence(runId, note, at): number`, `latestEvidence(runId)`, `evidenceCount(runId)`.
  - `seat_lines(key TEXT PRIMARY KEY, run_id, seat_id, origin, text, at)`: `claimLine(key, row): boolean` (insert; false when the key exists), `dropLine(key)`, `claimedKeys(runId): Record<string, number>`, `lastEngineLineAt(runId)`; `message()` writes operator rows with key `op:<runId>:<at>:<random 8 hex>`.
  - `loop_events(key TEXT PRIMARY KEY, run_id, text, at)` (Activity `loop` rows; `addLoopEvent(key, …)` ignores a repeated key, so a re-emitted event is recorded once; the server keys events `<runId>:<epoch>:<reportedEvidenceId>:<text>`). Push events are `loop_events` rows too (`pushed {sha7}`), since `run_pushes` keeps one row per run.
  - `queues(seat_id, pos, repo_id, issue, taken_at, PRIMARY KEY(seat_id, pos))`: `replaceQueue(seatId, items)` (transaction; keeps a taken row; skips an issue queued for another seat), `queue(seatId)`, `takeQueued(seatId, at)` (transaction), `untake(seatId, issue)`, `dropQueued(seatId, issue)`, `staleTakes(before): QueueRow[]`.
  - `attention_notes(key TEXT PRIMARY KEY, kind, run_id, seat_id, repo_id, text, at, cleared_at)` with `kind` `blocked` | `review` | `flag` | `question`: `raiseNote(n)` (insert, or re-open a cleared row with the new text), `clearNote(key, at)`, `clearNotesFor(runId, at)`, `notes()`, `openNoteKeys(runId)`. Keys always carry what makes them unique: `blocked:<runId>:<epoch>`, `review:<runId>:<sha>`, `flag:<runId>:hard-rules`, `question:two-areas:<repoId>#<n>`. `ATTENTION_KINDS` in `packages/core/src/hud.ts` gains `blocked`, `review` and `flag` (`question` exists); labels `Blocked`, `Ready for review`, `Check before merging`.
  - `board_moves(id INTEGER PRIMARY KEY, run_id, repo_id, issue, column, state, detail, at)`.
  - `board_items` gains `created_at`, `item_id`, `project_id`.

- [ ] **Step 1: Write the failing tests**: migration twice; `loop` round-trips and survives `upsertRun`; `head_sha`, `mergeable` and `polled_at` parsed from a PR fixture and stored; `claimLine` twice → `true` then `false`; `raiseNote` after `clearNote` re-opens; `takeQueued` on two `Store`s over one file grants one; `replaceQueue` keeps a taken row; `staleTakes`; board item columns stored.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** `pnpm -s lint`, `typecheck`, `test`, `build`, each exit 0; commit `feat(server): loop state, evidence, keyed seat lines, loop events, queues, notes; PR head sha and mergeable`.

### Task 2: Supervisor events, the between-turns send, `report_evidence`

**Files:**
- Create: `packages/core/src/loop.ts` (texts; `reconcile` arrives in Task 5).
- Modify: `packages/core/src/runtime.ts` (`WRITER_TOOLS` and `READONLY_TOOLS` gain `MC_TOOLS.reportEvidence`; `WRITER_TOOLS` loses `push` and `draftPr`), `packages/core/src/mcp.ts`, `packages/core/src/guard.ts` (its mc tool lists follow), `apps/server/src/runtime/supervisor.ts`, `apps/server/src/store.ts` (`seat_sessions.last_turn_ended_at`), `apps/server/src/mcp/tools.ts` (`report_evidence`; the MCP `push`/`draft_pr` registrations removed, `pushRun`/`openDraftPr` kept as exports; the commit tool refuses a message `firstCommitNotifier` flags), `apps/server/src/runtime/brief.ts` (`WRITER_CLOSE`), `roles/GUIDO.md`, `roles/INCO.md`, `docs/runbook.md`.
- Test: `apps/server/test/supervisor.test.ts`, `apps/server/test/mcp-tools.test.ts`, `apps/server/test/brief.test.ts`, `packages/core/test/guard.test.ts`.

**Interfaces:**
- `Supervisor.on(fn: (e: SupervisorEvent) => void): () => void`; `type SupervisorEvent = { kind: "idle"; seatId; runId; resumed: boolean } | { kind: "run-ended"; seatId; runId; endedBy: "operator" | "engine" | "exit" } | { kind: "evidence"; seatId; runId }`. `idle` fires whenever a seat with an active run leaves a turn (the `result` path's `setState(l, "idle", …)`; `last_turn_ended_at` written) and after a resume (`resumed: true`; `last_turn_ended_at` untouched; the seat's `resumedAt` kept in memory for the snapshot). `run-ended` fires after the store write from every end path: `onExit` after Stop → `operator`, after a crash → `exit`; `failResume` → `exit`; `endRun` with no live process → `operator`; `endRunByEngine` → `engine`.
- `send(runId, key: string, text: string): Promise<"sent" | "busy" | "dup" | "gone">`: `gone` when the run ended or is not its seat's current run; `busy` when the seat has no live process (not yet resumed); inside the seat's `enqueue` chain: `busy` when `l.inTurn`; `dup` when `claimLine(key, …)` is false; otherwise `writeLine` (a write failure → `dropLine(key)` and `busy`). Allowed while the seat is rate-limited (`parked`), as `message()` is. Never answers questions.
- `startRun(seatId, issue, opts?: { loop: RunLoop })`: with `opts`, the run row is created with `loop` in the same insert; the opening line is the ticket brief as today. The supervisor also exposes `seatFacts(seatId): { inTurn: boolean; resumedAt: number | null; rateLimitedUntil: number | null } | null` for the snapshot.
- `endRunByEngine(runId): Promise<void>`: run-scoped; closes the process only if the seat's current run is this one; ends the run `ok`, `endedBy: "engine"` **first** (so a later failure cannot repeat it); then removes the run's worktree with `removeCheckout(checkout, path, { force: true })` (Plan 6's function gains the option: `git worktree remove --force`, then the branch delete as today); a removal failure is logged and leaves a `blocked`-kind note `cleanup:<runId>`; leaves the seat `idle` with no reason (not `stopped`); an ended run is a no-op with no event.
- `report_evidence { note: string }` (both modes; 1–4000 chars). Refusals, in order (texts in `loop.ts`): `EVIDENCE_NO_LOOP`; `EVIDENCE_PARKED`; `EVIDENCE_IN_CI` ("CI is running on your last push; Mission Control will message you the result."); `EVIDENCE_UNCOMMITTED` (`git status --porcelain=v1 -z --untracked-files=all` in the worktree via `crewGit`, non-empty; names up to 10 paths); `EVIDENCE_NO_COMMIT` (no `run_commits` row after the latest evidence's `at`, or the newest commit is the sha CI last failed on — `loop.ciFailedSha` — unless the note starts with `Ruling:`); `EVIDENCE_TEXT(what)` (Plan 6's PR-text checks flag the note: `firstPrNotifier(note, { repo, issue })`, its unclosed-block check and the PR secret scan — exported from `tools.ts` as one `prTextProblem(text, own)` so `report_evidence` and `openDraftPr` share it). Otherwise `addEvidence`, answer `EVIDENCE_RECORDED` ("Recorded. Mission Control is pushing and will message you when CI has run."), emit `evidence`.
- `WRITER_CLOSE` = `Commit with the mc commit tool, never git. When the ticket's work is done and committed, call mc report_evidence with a short note of what changed and how to deploy it. Mission Control pushes, opens the draft PR and runs CI; it messages you if CI fails. For a review comment, fix it, commit, and report again. Write package names such as @scope/name inside backticks; a bare one reads as a mention and is refused. Ask the operator with mc ask_operator only for a decision you cannot make.` Role files: Mission Control pushes and opens PRs.

- [ ] **Step 1: Write the failing tests** (fake CLI): `idle` after a turn (with `last_turn_ended_at`) and after a resume (`resumed: true`, column untouched); `run-ended` with each `endedBy`; `send` → `busy` while `inTurn` (including right after `message()` wrote a line, before `turn-start`), `sent` between turns, `dup` on a reused key, `gone` for an ended run and for a seat on another run, `sent` to a rate-limited seat; `startRun` with `opts` stores `loop`; `endRunByEngine` leaves the seat `idle` and touches only the named run; each `report_evidence` refusal in order and the recorded case; `Ruling:` passes with no new commit; the commit tool refuses `Closes #123`; guard lists allow `report_evidence` in both modes and drop push and draft_pr; `WRITER_CLOSE` pinned.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** runbook and role lines. **Step 6:** checks; commit `feat(server): supervisor events, a keyed between-turns send, and mc report_evidence`.

### Task 3: Per-repo rules and `autonomy`

**Files:**
- Create: `packages/core/src/repo-rules.ts`, `apps/server/src/engine/rules.ts`.
- Modify: `apps/server/src/config.ts` (`repos[].autonomy`, `crew.run_token_budget`), `config.example.yaml`, `CLAUDE.md`, `docs/runbook.md`.
- Test: `packages/core/test/repo-rules.test.ts`, `apps/server/test/rules.test.ts`, `apps/server/test/config.test.ts`.

**Interfaces:**
- Core: `interface RepoRules { pickFrom: string[]; promoteBacklog: boolean; areas: Record<string, string[]>; hardRules: string[]; alwaysAsk: string[] }`; `DEFAULT_HARD_RULES` = design §5's list; `DEFAULT_REPO_RULES = { pickFrom: ["Ready"], promoteBacklog: false, areas: {}, hardRules: DEFAULT_HARD_RULES, alwaysAsk: [] }`; `areaLabelsFor(rules, seatArea: string[]): string[]`: a seat area of `[]` (the whole checkout) matches every label; otherwise a label matches when each of its globs, with any trailing `/**` removed, is a path `pathInArea(path, seatArea)` accepts.
- Server: `parseRepoRules(markdown: string | null): RepoRules` (the `## Mission Control` heading, its first fenced `yaml` block, key `mc:`; the design §4 block's keys this plan does not use — `needs`, `templates`, `ci` — are accepted and ignored; an unknown key throws `RepoRulesError` naming it; `hard_rules` absent or null → defaults, `[]` → none); `readRepoRules(repo, checkout): Promise<RepoRules | RepoRulesError>`: resolve `origin/HEAD` to a sha (`git rev-parse --verify origin/HEAD^{commit}` via `crewGit`), then Plan 6's `readRepoClaudeMd(checkout, sha)`, cached by that sha. An error stops refills for that repo and is a note on `/api/crew/status`; in-flight runs carry on.
- Config: `repos[].autonomy: "draft" | "merge"` (default `draft`; `merge` requires a crew session for that repo); `crew.run_token_budget` (default `400000`, input + output tokens per run).
- This repo's `CLAUDE.md` gains the block with `areas` `area:server` → `apps/server/**`, `area:web` → `apps/web/**`, `area:core` → `packages/core/**`.

- [ ] **Step 1: Write the failing tests**: the design's block parses; `foo: 1` throws naming `foo`; no heading → defaults; `hard_rules` absent → defaults, `[]` → `[]`; `areaLabelsFor(rules, ["apps/server/**","packages/core/**"])` → `["area:server","area:core"]`; one read per sha; config accepts `autonomy: merge` with a session, rejects it without one and rejects `autonomy: yes`, defaults the budget.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** the `CLAUDE.md` block, the example config, the runbook paragraph. **Step 6:** checks; commit `feat(server): per-repo board rules from CLAUDE.md; autonomy and the run token budget`.

### Task 4: Board writes and the setup action

**Files:**
- Create: `apps/server/src/github-board.ts`.
- Modify: `apps/server/src/github-setup.ts` (`FIELDS_QUERY` selects field and option ids; `ensureFields` adds Priority `P0,P1,P2` and Size `XS,S,M,L,XL`; `ensureLabels`), `packages/core/src/repos.ts` (`optionForColumn`), `packages/core/src/board.ts` (`TYPE_LABELS`), `apps/server/src/api.ts` (the setup route reads the repo's rules for area labels), `apps/server/src/views.ts` (Activity `board` rows).
- Test: `apps/server/test/github-setup.test.ts`, `apps/server/test/github-board.test.ts`, `packages/core/test/repos.test.ts`, `apps/server/test/views.test.ts`.

**Interfaces:**
- `moveCard(deps: { gql; store; config; poll: (repoId: RepoId) => Promise<void> }, m: { runId: string; repoId: RepoId; issue: number; column: "In progress" | "In review" | "Blocked" }): Promise<{ ok: true; changed: boolean } | { ok: false; reason: string }>`: `draft` repo → `{ ok: true, changed: false }`, no call, no row; ids from `FIELDS_QUERY`, cached per repo for an hour, refreshed on a miss; unknown item → `poll(repoId)` once then retry, else `{ ok: false, reason: "card not polled yet" }`; already there → `{ ok: true, changed: false }`, no call; one retry on a network error; a `board_moves` row `pending` → `done` | `failed`; mutation `updateProjectV2ItemFieldValue(input: { projectId, itemId, fieldId, value: { singleSelectOptionId } })`.
- `optionForColumn(options, map, column): string | null` = the option named `column` (case-insensitive) whose mapped state is `COLUMN_STATE[column]`; else the first option with that state whose name is not another column's; else null.
- `ensureLabels(gql, repo, labels): Promise<string[]>` via `createLabel` (repository id from a query); "already exists" is done; returns those created. `TYPE_LABELS`: `type:feature` `1d76db`, `bug` `d73a4a`, `chore` `c5def5`, `test` `bfd4f2`, `docs` `0075ca`, `research` `5319e7`; area labels from `areas` keys, `ededed`.
- Activity `board`: `{ref} → {column}`; `{ref} → {column} failed: {detail}`.

- [ ] **Step 1: Write the failing tests** with a fake `gql`: one mutation with fixture ids; none when already there; `draft` → no call, no row; two review options → `In review`; unknown item → poll then mutation; 502 → one retry then `failed`; `ensureFields` creates only the missing two; `ensureLabels` creates only missing ones, area labels included; `optionForColumn` cases; both Activity texts.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** checks; commit `feat(server): board Status moves and the setup action's fields and labels`.

### Task 5: `reconcile` (pure)

**Files:**
- Modify: `packages/core/src/loop.ts`.
- Test: `packages/core/test/loop.test.ts`.

**Interfaces:**
- `interface LoopSnapshot { runId: string; runStartedAt: number; loop: RunLoop; ticket: { ref: string; title: string; issue: number }; now: number; hubStartedAt: number; seat: { state: SeatState; inTurn: boolean; lastTurnEndedAt: number | null; resumedAt: number | null; rateLimitedUntil: number | null; openQuestion: boolean }; evidence: { id: number; at: number; ruling: boolean } | null /* latest */; evidenceCount: number; headCommit: string | null /* newest run_commits sha */; pushed: { sha: string; at: number } | null /* run_pushes */; pr: { number: number; state: "open" | "merged" | "closed"; headSha: string | null; ci: "passing" | "failing" | "pending" | null; mergeable: string | null; polledAt: number } | null; card: string | null /* the card's column from the poll */; claimed: Record<string, number> /* this run's seat_lines keys → at */; openNotes: string[] /* this run's uncleared note keys */; lastEngineLineAt: number | null; tokens: number; budget: number; ended: { reason: string } | null }`.
- `type LoopAction = { kind: "push" } | { kind: "open-pr" } | { kind: "send"; key: string; text: string } | { kind: "ci-excerpt"; key: string; sha: string } | { kind: "move-card"; column: "In progress" | "In review" | "Blocked" } | { kind: "note"; key: string; noteKind: "blocked" | "flag" | "review"; text: string } | { kind: "clear-note"; key: string } | { kind: "end-run" } | { kind: "take-next" } | { kind: "event"; text: string }`.
- `reconcile(s: LoopSnapshot): { loop: RunLoop; actions: LoopAction[] }` in two steps, both pure. **The state step** may change `loop` (first matching row). **The desired-state step** then runs on every call, whatever the state step did, and emits the actions that make the world match the (new) loop — so a crash, a `busy` seat or a failed call between two passes only delays an action; the next pass emits it again.

**State step** (`park(kind, reason)` = `phase: parked`, `parked = { kind, reason, ended: false }`, plus `event("parked: {reason}")`; events are the only one-shot actions and are deduplicated by the server, below):

| # | Condition | New loop |
|---|---|---|
| 1 | `pr.state === "merged"` and `phase !== "done"` | `phase: done`; actions `end-run`, `take-next`, `event("merged")` |
| 1a | `phase === "done"` | unchanged; actions `end-run`, `take-next` again (both idempotent: `endRunByEngine` on an ended run is a no-op, `takeNext` takes only for an idle seat with no run), so a lost pass still finishes |
| 2 | `ended` and not `parked?.ended` | `phase: parked`, `parked = { kind: "ended", reason: "run ended (" + reason + ")", ended: true }` |
| 3 | `phase === "parked"` | unchanged |
| 4 | `pr.state === "closed"` | `park("pr-closed", "PR #{n} was closed without merging")` |
| 5 | `phase` is `working` or `review`, `evidence.id > loop.reportedEvidenceId`, `headCommit !== null`, `headCommit === loop.ciFailedSha` | `reportedEvidenceId = evidence.id`; `evidence.ruling` → `park("ruling", "{CALL} ruled on the CI failure on {sha7} instead of fixing it; see its last report")`; else stays `working` and the desired step sends `nonew:<runId>:<evidenceId>` (`NO_NEW_COMMIT_TEXT`) |
| 6 | `phase` is `working` or `review`, `evidence.id > loop.reportedEvidenceId` | `reportedEvidenceId = evidence.id`, `phase: ci`, `pushStartedAt = now`, `event("reported; pushing")` |
| 7 | `phase === "ci"`, `loop.transient >= REFUSAL_TRIES` | `park("refused", loop.lastRefusal)` |
| 8 | `phase === "ci"`, (`pushed?.sha !== headCommit` or `pr === null` or `pr.headSha !== pushed.sha`), `now - pushStartedAt > NO_CI_AFTER_MS` | `park("stuck", "the push or PR for {sha7} has not shown up on GitHub after 10 minutes")` |
| 9 | `phase === "ci"`, any of the same three not yet true | unchanged (the desired-state step pushes / opens the PR; the poll catches up) |
| 10 | `phase === "ci"`, `pr.mergeable === "CONFLICTING"` | `park("conflict", "PR #{n} conflicts with main")` |
| 11 | `phase === "ci"`, `ci === "passing"` | `phase: review`, `ciFails = 0`, `event("CI passed on {sha7}")` |
| 12a | `phase === "ci"`, `ci === "failing"`, `ciFailedSha === pushed.sha` (a race: the report arrived while that sha was already known to fail) | `phase: working` (no count; the excerpt was already relayed or is relayed now) |
| 12 | `phase === "ci"`, `ci === "failing"`, `ciFailedSha !== pushed.sha` | `ciFails += 1`, `ciFailedSha = pushed.sha`; `ciFails >= CI_TRIES` → `park("ci", "CI failed {n} times; last on {sha7}")`; else `phase: working`, `event("CI failed on {sha7}")` |
| 13 | `phase === "ci"`, `ci === "pending"`, `now - pushed.at > CI_PENDING_MAX_MS` | `park("ci-pending", "CI pending for 30 minutes on {sha7}")` |
| 14 | `phase === "ci"`, `ci === null`, `pr.polledAt - pushed.at > NO_CI_AFTER_MS` | `park("no-ci", "no CI reported for {sha7}")` |
| 15 | `phase === "working"`, `tokens > budget + loop.budgetExtra` | `park("budget", "over its {budget}-token budget")` |
| 16 | `phase === "working"`, the nudge key `nudge:<runId>:<epoch>:<evidenceCount>` is in `claimed` at time `t`, `seat.state === "idle"`, not `inTurn`, not `openQuestion`, `lastTurnEndedAt > t` | `park("silent", "stopped twice without reporting")` |
| 17 | otherwise | unchanged |

**Desired-state step** (on the new loop; `let` = the facts):
- **`done`:** nothing below applies except clearing every open note of the run.
- **Card:** desired column = `In progress` for `working`/`ci`, `In review` for `review`, `Blocked` for `parked` (ended runs too); emit `move-card` only while `loop.cardFor !== "<phase>:<epoch>"` — the server sets `cardFor` once the move is done **or has failed** (a failed move is an Activity row and is not retried), so the engine moves the card once per phase change and never fights a move the operator makes afterwards.
- **Notes:** desired note keys = `blocked:<runId>:<epoch>` with `"{ref} parked: {reason}"` when `phase === "parked"`; `review:<runId>:<pushed.sha>` with `"{ref}: PR #{n} is ready for review (CI passed on {sha7})"` when `phase === "review"`; `flag:<runId>:hard-rules:<touches.sha>` with `"{ref} touches hard-rule files: {paths}"` while `loop.touches` is non-empty; `ratelimit:<runId>` with `"{CALL} is rate-limited{ until HH:MM}"` while `seat.state === "parked"` (a rate-limited crew seat is otherwise invisible in Needs-you). Emit `note` for each desired key not in `openNotes`, `clear-note` for each key in `openNotes` not desired.
- **Push / PR** (only in `ci`): `headCommit !== null` and `pushed?.sha !== headCommit` → `push`; else `pushed !== null` and `pr === null` → `open-pr`.
- **Lines** (only when not `inTurn`; each only if its key is not in `claimed`; **at most one line per pass, in this order** — the first due one wins and the rest wait for the next pass):
  - `phase === "working"`, `ciFailedSha !== null`, `relayedSha !== ciFailedSha` → `ci-excerpt` with key `ci:<runId>:<ciFailedSha>` (the server sets `relayedSha` once claimed).
  - the `nonew:<runId>:<evidenceId>` line from row 5.
  - `phase` is `working` or `review`, `seat.resumedAt >= hubStartedAt`, `(lastTurnEndedAt ?? 0) < resumedAt`, not `openQuestion` → `send("resume:<runId>:<hubStartedAt>", RESUME_TEXT)`.
  - `seat.state === "parked"` (rate-limited) and either `rateLimitedUntil !== null && now > rateLimitedUntil`, or `rateLimitedUntil === null` → `send("ratelimit:<runId>:<rateLimitedUntil ?? floor(now / 3_600_000)>", RESUME_TEXT)` (with no reset time, one try per hour).
  - `phase === "working"` — or `phase === "review"` with `headCommit !== pushed?.sha` (a fix committed but not reported) — `seat.state === "idle"`, not `openQuestion`, `lastTurnEndedAt > max(runStartedAt, evidence?.at ?? 0, lastEngineLineAt ?? 0)` → `send("nudge:<runId>:<epoch>:<evidenceCount>", NUDGE_TEXT)`; row 16 applies in `review` the same way.
- `loop.touches` is computed by the server for each new `pushed.sha` (`touches?.sha !== pushed.sha`) before the pass and stored in the loop, so the flag survives restarts and follows later review rounds.

- `RunLoop` (Task 1) becomes `{ phase: LoopPhase; reportedEvidenceId: number; prNumber: number | null; pushStartedAt: number | null; ciFails: number; ciFailedSha: string | null; relayedSha: string | null /* the failed sha whose excerpt was claimed */; transient: number; lastRefusal: string | null; epoch: number; budgetExtra: number; parked: { kind: string; reason: string; ended: boolean } | null; touches: { sha: string; paths: string[] } | null /* hard-rule files in the pushed sha's diff */; cardFor: string | null /* "<phase>:<epoch>" whose card move is done */ }` and `NEW_LOOP` follows it (zeros, nulls, `epoch: 0`).
- Texts: `CI_FAILED_TEXT = "CI failed on {sha7}. Fix it, commit, and call mc report_evidence again. If it is a flaky test that is not yours, report with a note starting \"Ruling:\" and say why; the operator will decide. The failing output:\n"`; `NO_NEW_COMMIT_TEXT = "No new commit since CI failed on {sha7}. Fix it and commit first, then report; or report with a note starting \"Ruling:\" if the failure is not yours."`; `RESUME_TEXT = "Carry on with {ref}: Mission Control restarted, or your rate limit has reset. When the work is committed, call mc report_evidence."`; `NUDGE_TEXT = "No report yet for {ref}. When the work is committed, call mc report_evidence with a note; if you are blocked, say why."`.

- [ ] **Step 1: Write the failing table tests**: one per state row and per desired-state rule, plus these, each run as a sequence of passes with facts changing between them: the happy path report → push → open-pr → CI pending → passing → In review (card and review note) → merged; **each pass repeated after dropping all its actions** (a crash) still emits the same outstanding actions next time — push, open-pr, the card move, the park's card and note, the CI excerpt; a `busy` send is re-emitted until its key is claimed; CI failing three times parks; a review-round report pushes only; a `Ruling:` report on a failed sha parks; a resumed seat gets the resume line once, and after its next turn ends the nudge rules apply; nudge then park, never with an open question; a rate-limit reset sends one line; `ended` parks with no card move; a park's note key changes with `epoch`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** checks; commit `feat(core): the first loop's reconcile: state rows plus a desired-state pass`.

### Task 6: The engine server

**Files:**
- Create: `apps/server/src/engine/engine.ts`, `apps/server/src/engine/publish.ts`.
- Modify: `apps/server/src/mcp/gh.ts` (`GhOptions.maxBuffer`, default unchanged), `apps/server/src/main.ts` (the engine is created after the store and the supervisor and subscribes before `supervisor.start()`; the scheduler, created earlier, gets it late-bound through a setter, so its `engine` job and post-poll hook are no-ops until `engine.start()` has run), `apps/server/src/api.ts` (after a forwarded `/seats/:id/message` to a seat whose run is looped, `engine.onOperatorMessage(runId)`; `/api/crew/status` carries the engine's note; `GET /api/runs/:id/loop`), `apps/server/src/scheduler.ts` (after each GitHub poll, `engine.reconcileRepo(repoId)`; job `engine` every `ENGINE_TICK_MS`, first delay 30 s, `engine.tick()`), `apps/server/src/hud.ts` (Needs-you items from `attention_notes`), `apps/server/src/views.ts` (Activity `loop` rows from `loop_events`).
- Test: `apps/server/test/engine.test.ts`, `apps/server/test/publish.test.ts`, `apps/server/test/api.test.ts`, `apps/server/test/hud.test.ts`.

**Interfaces:**
- `createPublisher(deps: McToolsDeps)`: `push(run) → { ok: true } | { ok: false; text: string; transient: boolean }` (Plan 6's `pushRun`; "Already on origin" and "Nothing to push" are success; `transient` only for `MC_PUSH_FAILED`); `openPr(run, ticket, note) → { ok: true; prNumber } | { ok: false; text; transient }` (`openDraftPr` with title `#{issue} {title}` and the body below; a title or body that `prTextProblem` flags falls back to title `#{issue}` and a body without the ticket title; "A PR is already open" is success only when that PR's `created_at >= run.startedAt` — an older open PR on the branch parks the run ("an earlier PR is open on this branch"); `transient` only for `MC_PR_FAILED`). Body = `#{issue}` + ` — {title}` (when it passes) + `\n\n## What changed\n\n` + the **latest** evidence note + `\n\nCloses #{issue}.` (Plan 6 adds the Opened-by line).
- **Which PR is the run's:** `loop.prNumber` when set; otherwise the open PR on the run's branch whose `created_at >= run.startedAt` (so a crash between opening the PR and storing its number still finds it, and an earlier run's PR on a reused branch name is never taken). The engine stores the number in the loop the first time it sees it.
- `ciExcerpt(repo, sha): Promise<string>`: `gh run list --repo=<owner/name> --commit=<sha> --json=databaseId,name,conclusion`, then for each `failure` run `gh run view --repo=<owner/name> <id> --log-failed` with `maxBuffer: 16 MiB`, its last `CI_EXCERPT_LINES` lines, ANSI and control characters stripped, capped at `CI_EXCERPT_MAX` bytes, prefixed with the run name; no failed Actions run → `"(no failed Actions run to read)"`; any gh failure → `"(the CI log could not be read)"`.
- `hardRuleTouches(run, sha)`: `git diff --name-only $(git merge-base origin/HEAD <sha>) <sha>` in the session clone via `inClone`, matched against the repo's `hardRules`; computed for each new `pushed.sha` and stored as `loop.touches` before the pass.
- `createEngine(deps: { config; store; supervisor; publisher; board: { move: (m) => Promise<…> } /* moveCard bound to gql, store, config and the poll */; rules; gh; takeNext: (seatId) => Promise<void> /* Task 7 */; enabled; hubStartedAt; now? })`:
  - `start()`: off unless `enabled`; untakes `staleTakes(now - TAKE_STALE_MS)` whose seat has no active run for that issue; reconciles every active looped run; sweeps notes (below).
  - Triggers, each calling `reconcileRun(runId)`: supervisor `idle`, `evidence`, `run-ended` (not `engine`); `reconcileRepo(repoId)` for each active looped run of that repo; `tick()` for each active looped run, then the note sweep, then refill and take.
  - `reconcileRun(runId)`: on the run's in-memory chain (one at a time per run; losing the chain on a restart is harmless because reconcile re-derives everything). Build the snapshot (store: loop, evidence, `run_commits`, `run_pushes`, the run's PR by the rule above, the card's column, `claimedKeys`, `openNoteKeys`, `lastEngineLineAt`, tokens; supervisor: `seat(seatId)` state, `last_turn_ended_at` — ignored when older than the run's start — and `seatFacts`; open questions from `store.openQuestions()`), call `reconcile`, `setRunLoop(new loop)`, then run every action; an action that throws is logged and left for the next pass. Action handling: `push` → on a refusal, a non-transient one sets `loop.phase = parked` with `{ kind: "refused", reason: text }`; a transient one increments `loop.transient` and stores `lastRefusal` (row 7 parks after `REFUSAL_TRIES`); on success `loop.transient = 0` and a `loop_events` row `pushed {sha7}`. `open-pr` → the same refusal handling; on success stores `prNumber`. `send` → `supervisor.send` (any answer but `sent` simply leaves the key unclaimed for the next pass). `ci-excerpt` → `ciExcerpt`, then `send(key, CI_FAILED_TEXT + excerpt)`. `move-card` → `board.move`, then `loop.cardFor = "<phase>:<epoch>"` whether it succeeded or failed (a failure is its Activity row). `ci-excerpt` claimed → `loop.relayedSha = sha`. `note` → `raiseNote`; `clear-note` → `clearNote`. `end-run` → `endRunByEngine`. `take-next` → `deps.takeNext`. `event` → `addLoopEvent`.
  - `onOperatorMessage(runId)`: queued on the run's chain. If the loop is parked, not `ended`, and its kind is not `pr-closed`: `epoch += 1`, `parked = null`, `ciFails = 0`, `transient = 0`, `lastRefusal = null`, for kind `budget` `budgetExtra += budget`, and the phase is derived from the facts: kind `ruling` → `review` (the operator accepted the ruling and will merge or comment); a pushed sha equal to `headCommit` with an open PR → `ci` (re-judged next pass; `pushStartedAt = now`); otherwise `working`; `event("resumed by CAPCOM")`; then `reconcileRun`. Otherwise nothing (the message itself was already delivered).
  - **Ended runs:** every tick also reconciles each ended run whose loop is neither `done` nor parked with `ended: true` (so a lost `run-ended` pass still parks it, moves its card to Blocked and raises its note).
  - **Note sweep:** for every ended run with open notes, clear its `review`, `flag` and `ratelimit` notes, and its `blocked` note once its PR is merged or closed or its card has left `Blocked`.
  - `status()`: `{ on, note }` (rules errors per repo).
- Needs-you items: `blocked` → "Blocked", `review` → "Ready for review" (the controller marks the PR ready and merges by hand in 7a), `flag` → "Check before merging", `question` → the existing question kind; each disappears when its note is cleared.

- [ ] **Step 1: Write the failing tests** (fake CLI, real store, fake publisher/board/gh): a looped run reports → one push and one PR; the poll's PR row with the pushed `headSha` and `passing` → In review and a review note (a second poll changes nothing); `failing` → one CI line with the excerpt, re-sent on the next pass while the seat was busy and not after it is claimed; a non-transient refusal parks with its text; a transient one retries and parks on the third; a restart after the push but before the PR opens the PR, and a restart after the PR opened but before its number was stored finds it by branch and start time; an earlier run's merged PR on the same branch name is ignored; a resumed seat gets one resume line per hub start; a message to a parked seat is delivered and un-parks it (a new `blocked` key next time it parks); to an ended or PR-closed park it does not; Stop mid-loop parks "run ended (…)" with no line sent and no card move; merged → `endRunByEngine` once and `takeNext` once; the note sweep clears an ended run's notes; `enabled: false` → no action; Activity rows; Needs-you items appear and clear.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** checks; commit `feat(server): the first loop: report → push and draft PR → CI → In review → merged, reconciled from stored facts`.

### Task 7: Queues and picking

**Files:**
- Create: `apps/server/src/engine/queue.ts`.
- Modify: `apps/server/src/engine/engine.ts` (`tick()` calls `refillQueues` then `takeNext` for each writer seat that is `idle` with no active run — never `stopped` or `error`), `apps/server/src/api.ts` (`/seats/:id/start` for a writer seat with the engine on passes `{ loop: NEW_LOOP }`; the card moves to In progress through the loop's desired-state pass, a no-op in a `draft` repo).
- Test: `apps/server/test/queue.test.ts`, `apps/server/test/api.test.ts`.

**Interfaces:**
- `NEW_LOOP: RunLoop = { phase: "working", reportedEvidenceId: 0, prNumber: null, pushStartedAt: null, ciFails: 0, ciFailedSha: null, transient: 0, lastRefusal: null, epoch: 0, budgetExtra: 0, parked: null, touches: null, cardFor: null, relayedSha: null }` (core).
- `refillQueues(deps: { config; store; rules; now })`: for each `merge` repo with readable rules and each writer seat in it: cards in `Ready`, open, not queued for another seat, not an active run's ticket, with exactly one area label, that label in `areaLabelsFor(rules, seat.area)`, and no `research` label; order Priority `P0` < `P1` < `P2` < unset, then `createdAt`; `replaceQueue(seat, first QUEUE_DEPTH)`. Two or more area labels → `raiseNote("question:two-areas:<repo>#<n>", "{ref} spans two areas ({labels}); split it")`, cleared when the card no longer has two area labels or leaves Ready.
- `takeNext(deps, seatId)`: no-op for a `draft` repo, a preview, a seat with an active run or not `idle`, or the account at its quota stop (`accounts[].stopAt`); `takeQueued`; re-read the card from the store (the last poll; stale by at most the poll interval, accepted) and `untake` + `dropQueued` if it left `Ready`; `supervisor.startRun(seatId, issue, { loop: NEW_LOOP })`; success → `dropQueued` (the card moves through the loop's desired-state pass); failure → `untake`.
- A hand-start of a writer seat gets `NEW_LOOP` in a `draft` repo too (the loop runs; `moveCard` is a no-op there, so the board is untouched) — that is how the loop is first trialled. A read-only seat gets no loop. Seats only **take** on their own in a `merge` repo. A writer seat with no `seat_sessions` row yet counts as `idle`.

- [ ] **Step 1: Write the failing tests**: a Ready `area:server` card → only guido-1's queue; two area labels → no queue, one question, cleared when relabelled; `research` skipped; Priority then age; an active run's ticket excluded; a card now Blocked → skipped; `startRun` 409 → untaken; success → dropped, looped, In progress; a `draft` repo → nothing; two seats, one card → one take; a `stopped` seat never takes; a stale take at `start()` untaken; hand-start cases.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** checks; commit `feat(server): seats take their next Ready ticket by rule`.

### Task 8: The HUD, and the end-to-end test

**Files:**
- Modify: `packages/core/src/types.ts` (`CrewRow.loop: { phase: LoopPhase; text: string; prNumber: number | null; parked: string | null } | null`), `apps/server/src/hud.ts`, `apps/web/src/overview/AgentsPanel.tsx` (the Loop step column shows `text`), `apps/web/src/flight/WorkInFlight.tsx` (one row per looped run: ticket, phase, PR), `apps/web/src/crew.ts` (`doingLine` uses `loop.text` when set), `docs/runbook.md`.
- Create: `apps/server/test/engine-e2e.test.ts`.
- Test: `apps/server/test/hud.test.ts`, `apps/web/test/Overview.test.tsx`, `apps/web/test/Flight.test.tsx`.

**Interfaces:**
- `loop.text`: `working` → `Working on {ref}`; `ci` → `CI on {sha7}`; `review` → `In review · PR #{n}`; `parked` → `Blocked: {reason}`.
- Activity: `loop` rows use `loop_events.text` prefixed with the ref; `push` → `pushed {sha7} to {branch}`.
- The e2e test drives the engine with the fake CLI for turns and calls the `report_evidence` handler directly with the run's context (the fake CLI has no MCP client), with a fake `gh`, a fake `gql`, and PR rows the test writes as the poll would: two Ready `area:server` cards → the seat takes the first (In progress) → reports → PR opened → CI failing (excerpt line) → reports → CI passing → In review → a message, and the seat reports again → push only → CI passing → In review → merged → the run ends, the seat is idle, the second card is taken; plus a restart between the push and the PR, a Stop mid-loop (parked, seat free), and every Activity kind present.

- [ ] **Step 1: Write the failing tests** (server: `crew()` carries `loop`; Activity texts; web: the column, the Work in flight rows, `doingLine`; the e2e script).
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5:** runbook: switching a repo to `merge`; the setup click; the `CLAUDE.md` block; what the engine does on its own; Blocked items and resuming by message; labelling existing tickets once. **Step 6:** checks; commit `feat(web): loop phase in the HUD; the first loop end to end on the fake CLI`.

---

After Task 8: the final whole-branch review (most capable model), then `superpowers:finishing-a-development-branch`. The PR's Security section lists the two GitHub writes and the new reads; that push and the draft PR are engine actions behind Plan 6's checks and filters; that the hub runs no worktree code; that CI is a gate and review the proof; and the removal of the seat's push and draft-PR tools.
