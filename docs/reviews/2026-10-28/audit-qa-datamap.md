# Audit and QA boards: what data Mission Control has, and what's missing

Source: branch feature/677-flight-hud-polish at `10d5d19e`. Paths below are relative to the repo root.
Live row counts come from a read-only query of the operator hub's database on 2026-10-28.
The tickets behind these boards are #718 (SURGEON), #717 (Telemetry Audit view), #716 (Run Trace), #656 (tech-debt list) and #91 (RETRO on every PR), plus principle 7 in docs/direction.md:26.

## 1. Inventory

Retention values:
- **Kept**: the hub never deletes the rows.
- **Nd**: `Store.pruneHistory` (store.ts:1751) or a table-specific delete drops them after N days.
- **Live**: the table holds a current snapshot, and each read replaces it.

### 1a. Runs, tokens, cost, model

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| `runs` row | store.ts:95 + migrated cols store.ts:1005-1028 | id, agent_id, repo_id, started_at, ended_at, status (`running/ok/failed/blocked/unknown`), model, vendor, branch, ticket, ticket_title, cost_usd, tokens (JSON `{input,output,cacheRead,cacheCreate}`), prs (JSON), summary, loop (JSON RunLoop), ended_by (`operator/engine/exit`), no_report, review_id, cli_version, profile (JSON), profile_hash, plan, latest_plan | Kept (3,540 rows, back to 2026-07-13) | Tokens and cost per run and ticket, model per run, vendor, CLI version, who ended the run, success (status) |
| `Run` type | packages/core/src/types.ts:64 | as above | — | — |
| `run_digests` (RunDigest) | store.ts:102; type types.ts:496 | JSON: turns, toolCalls, `tools{name:{calls,failed,durationsMs[50],slowest}}`, model, contextTokens, compactions, subagents, `attemptUsage[{at,tokens,usage,model}]` (per message), additions/deletions, minuteTokens, turnUsage | 30d (`DIGEST_RETENTION_MS`, collectors/common.ts:19; pruned scheduler.ts:880) | Per-message model/tokens, tool failure counts, compactions |
| `run_attempts` | store.ts:250; writer `appendAttempt` store.ts:1203 | append-only (run_id, kind, at, data JSON). Kinds: `run` (model, profile, tokens, cost, status: store.ts:1223), `loop` (every RunLoop change: store.ts:2514), `review` (every review state change, with findings copied on report: store.ts:2629/2715/2771), `ci` (PR head sha, ci state, checks[] on every PR poll: store.ts:2052), `merge` (store.ts:2058), `push`, `wait`/`wait-end` (store.ts:2525-2536) | **Kept**: not in the prune list (3,839 rows: run 2522, loop 538, ci 336, merge 129, review 118, wait 77, push 44) | **The only permanent time series** for CI states, loop transitions, review rounds and findings. Served by `GET /api/runs/:id/attempts` (api.ts:3076) |
| `usage_samples` | store.ts:108 | account_id, window (`5h`/`7d`), at, pct, reset_at, source | Kept (2,641) | Quota burn per account over time |
| Telemetry totals | telemetry.ts:528-640 | per agent×model: input/output/cache tokens, cacheHitPct, turns, toolCalls, costUsd, additions/deletions; `tokensByTicket`; `tokensByStep` (plan/build/review) | Computed per request over the range (`TELEMETRY_RANGES`) | Tokens/cost per ticket, per model, per step |
| Account per run | **not stored.** telemetry.ts:576 takes `accountId` from the *current* config's agent→account map | — | — | Account history is lost when a seat moves accounts |
| Live DB model mix | `runs.model` | claude-opus-5-5 1658, empty 1460 (mostly loop runs), claude-sonnet-5-5 212, claude-opus-5 124, gpt-5.6-sol 21, gpt-5.6-terra 17 | — | Model changes over time per seat (a `GROUP BY agent_id, model, day` query) |

### 1b. Prompts, roles, profiles, config

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| Template profile per run | `runs.profile`, `runs.profile_hash` (store.ts:1021-1025); `RunProfile` profiles.ts:74; hash apps/server/src/profiles.ts:189 | the profile as chosen (steps, checklist, reviewer depth, checks, tries, rounds) + route (label/size/override) + sha256 | Kept (62 runs have it) | Which ticket template a run used, and when a template changed |
| `profile_overrides` | store.ts:308 | repo, issue, profile, reason, by (FLIGHT/planner), at | Latest per issue only | Template overrides |
| CLI version per run | `runs.cli_version` (store.ts:1020; set supervisor.ts:790/1282) | string | Kept | Whether a CLI upgrade lines up with a behaviour change |
| Role prompt file | `RoleDef.prompt` = `roles/<NAME>.md` (packages/core/src/runtime.ts:117-170); read from `rolesDir` (supervisor.ts:1171) | path only | **No per-run hash or version is stored** | Prompt version per run is not answerable. Only git history of `roles/**` exists |
| Hub version per run | not stored | — | — | — |
| Config/seat changes | `GET /api/crew/changes` (api.ts:2451) | current diff vs disk | Live | No history of seat model/effort/account changes |

### 1c. Pull requests, size, time to merge

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| `pull_requests` | store.ts:124 + cols store.ts:1058-1080; mapper collectors/github.ts:1032; GraphQL `PR_FIELDS` github.ts:207 | number, title, branch, ticket, state, is_draft, review (reviewDecision), ci, checks (JSON PrCheck[] of the **head** commit, ≤50), created_at, updated_at, merged_at, head_sha, merge_commit_sha, mergeable, author, assignees, closing_issues | Rows older than `PR_KEEP_DAYS`=30 by updatedAt are dropped on the hourly sweep (core/board.ts:15; github.ts:1156) (1,063 rows) | Time to merge (created→merged), open/draft counts, current CI |
| PR size (lines/files) | **not in PR_FIELDS.** Only on demand: FLIGHT's `read_pr` asks `gh pr view --json additions,deletions,changedFiles,files` (flight/tools.ts:1995-2030) and doesn't store the result | — | — | PR length is not stored |
| `commit_lines` | store.ts:243; filled lazily by `GET /api/telemetry` from the seat's worktree (api.ts:2531-2560, setCommitLines store.ts:3876) | sha → additions, deletions | Kept, but only 90 of 588 crew commits are measured (only when Telemetry was opened over their range) | Lines per crew commit, partially |
| `run_commits` | store.ts:239 | run_id, repo, branch, sha, at | Kept (588) | Commits per run (telemetry.ts:313) |
| Hard-rule/stray paths in a PR | `runs.loop.touches.paths`, `loop.gate.strays` (types.ts:157-186) | path lists for the pushed sha | Latest on run; history in run_attempts `loop` | Hard-rule PR tracking |

### 1d. RETRO reviews and findings

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| `reviews` | store.ts:160; `ReviewRow` core/review.ts:61 | author_run_id, repo, seat_id, pr_number, sha, epoch, attempt, **round** (1..`REVIEW_ROUNDS`=3, review.ts:187), state (`queued/starting/running/reported/failed/superseded`), run_id (the review run), verdict JSON `{spec,quality}` pass/fail, summary (≤2000), blocking count, minor count, failure text, created/started/ended | Kept (349: reported 327, superseded 15, failed 7; rounds 1:180, 2:136, 3:33; from 2026-10-21) | Review rounds per PR, first-pass rate, verdicts, review duration (started→ended), review failures |
| `review_findings` | store.ts:169; `StoredFinding` review.ts:56; written `recordFindings` store.ts:2724 | review_id, author_run_id, pos, **severity** (`Critical/Important/Minor`, review.ts:15), file, line, summary, scenario, fix, state (`open` for blocking / `logged` for Minor) | **30d** after both the review and the author run ended (store.ts:1764,1775-1785). The `run_attempts` `review` row keeps a permanent copy of the findings (store.ts:2771) | Findings by severity and file. **No category field. No resolved state:** `open/logged` never changes (no `UPDATE review_findings` anywhere) |
| Live finding mix | — | Critical 13, Important 206, Minor 495 (714 rows) | — | — |
| Review depth | `reviewDepth()` review.ts:31; profile `reviewer.depth` | light/full from labels+size | Computed | Which depth was applied |
| What RETRO checks | roles/RETRO.md (32 lines): the standards list (tests that failed before, magic strings, parameterised SQL, boundary validation, authn≠authz, scope); profile `checklist` (profiles.ts:95-120) | static prose | — | Checks aren't recorded per review |
| Review in flight | the review run's digest: `liveTool`, `lastText`, `tasks` (types.ts:496-530); `reviews.state=running` | live | 30d (digest) | What RETRO is doing right now |
| Fix rounds sent | `seat_lines` keys counted by `fixesSent` (review.ts:333); `RunLoopView.round` (api.ts:3083) | claim keys | Engine-origin lines kept; others 7d (store.ts:1761) | Rework rounds per run |
| Minor findings filed | `loop.prBody {reviewId, minor}`, `loop.minorIssueNumber` (types.ts:170,188) | per run | Kept on run | Minor findings that went to the PR body or a tech-debt issue |
| Telemetry quality | telemetry.ts:265-318; type views.ts:350 | retroFindingsPerPr, sentBackPrs, reviewRoundsPerPr, firstPassReviewPct, reviewedPrs, ciGreenFirstPushPct, humanReviewWaitMs, commitsPerRun | Computed over `FLOW_DAYS`=14 (core/hud.ts:61) | Review success rates, already served by `GET /api/telemetry` |
| FLIGHT retrospective | flight/retrospective.ts:207; type core/flight.ts:296 | daily at 03:00: FlightMetrics (24h: opened, ciFailures, reruns, parks, per-seat tokens/cost), reviews reported/failed/failRate, top park reasons, red-main episodes, costliest runs | **Latest only**: one JSON per repo in `settings` (`flight-retrospective:<repo>`), delivered to FLIGHT via `flight_state` (flight/state.ts:760) | A day's audit summary; no history |

### 1e. CI, flakes, tests

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| PR head checks | `pull_requests.checks` (PrCheck types.ts:365: workflow, name, kind, state, conclusion, attempt, url) | ≤50 per head | Live (head only) | Which check is failing now |
| CI history per run | `run_attempts` kind `ci` (store.ts:2052) | `{sha, state, checks[]}` on every poll that read a PR linked to a run | Kept | Failure/pass sequence per PR and sha, for crew-run PRs only |
| First-push CI | `flow_prs.first_push_ci` (store.ts:134; collectors/flow.ts:181) | passing/failing/pending per merged PR | Live window: replaced hourly with the last 14d (store.ts:2162) | CI green on first push |
| CI fails per run | `runs.loop.ciFails`, `ciFailedSha`, `transient` (types.ts:147-151) | counters | Latest; history in run_attempts `loop` | CI loop-backs |
| Flakes | `loop.rerun {sha, runs[{id,name}], flaked}` (types.ts:199-204); loop_events text `CI flaked on <sha>: passed on re-run` (core/loop.ts:857); FLIGHT `flakes` map (flight/signals.ts:43); FLIGHT `rulingRerun` | per run / per sha | loop_events 30d; signals 7d (`FLIGHT_SIGNAL_KEEP_MS`, core/flight.ts:752); loop history Kept in run_attempts | Flake count and which workflow. **No test name**: #656 lists flaky tests by hand |
| Main CI | settings `FLIGHT_MAIN_SETTING:<repo>` (flight/signals.ts:141); `main_red` signals | latest sha/ci/failing checks | Latest + 7d | Red main episodes |
| CI log | `read_ci_log` tool (core/mcp.ts:41) | on demand | Not stored | — |
| `test_lock_runs` | store.ts:286; type core/views.ts:413; `GET /api/test-lock/history` (api.ts:1514) | run_id, seat_id, command (e.g. `pnpm -s vitest run` 34, `pnpm -s vitest` 10, `pnpm -s test` 4), queued_at, started_at, ended_at, outcome (`done` = Post hook fired / `freed` = run ended) | **8d** (store.ts:3708) (48 rows) | Full-suite durations and queue wait; usual length per command (telemetry.ts:84). **Not pass/fail** |
| Test pass/fail | The guard hook already receives `PostToolUse` vs `PostToolUseFailure` for every lock-held Bash call (core/guard.ts:126; schema api.ts:437), but api.ts:1436 only releases the lock and discards which event it was | — | Not stored | — |
| Test results per test / coverage | nothing | — | — | Not collected anywhere |
| "New test fails on base" | profile checklist text only (profiles.ts:98,120); no code re-runs a test on base (away-mode `awayBugDecision.testPaths` is the only test-path datum, types.ts:133) | — | — | Not verified or recorded |

### 1f. Guard refusals, parks, questions, comms

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| `guard_hits` | store.ts:233; `GuardHit` core/guard.ts:39; rules core/guard.ts:9 | agent_id, run_id, rule (`codex-allowlist, git-env, git-write, github-write, merge-push, flight-powers, full-suite, read-only, network, secret`), text, at | Kept (257: codex-allowlist 173, git-write 62, full-suite 22) | Refusals by gate, seat and day. `GET /api/guard/hits?days=1..30` (api.ts:1531) returns ≤limit rows + counts per rule |
| `strays` | store.ts:259 | session, path, agent, kind, at | Until cleared | Commits refused for paths outside the seat's area |
| `crew_errors` | store.ts:269 | agent, run, text, at, acked | Kept | mc tool failures |
| Parks | `runs.loop.parked {kind, reason}`; loop_events `parkedEventText`; kinds include conflict, ended, gate, no-ci, pr-closed, refused (core/loop.ts:726-914) and review/silent (loop.ts:83) | per run | loop_events 30d; run_attempts Kept | Death loops, stuck PRs |
| `seat_questions` | store.ts:264 (+passed_at store.ts:1052) | agent, run, text, at, answered_at, passed_at (FLIGHT → operator) | Kept (45) | Questions raised and time to answer. answered_at is also set by the run ending (store.ts:4073), so "answered" includes "abandoned" |
| Operator answers | `operatorAnswers` store.ts:3669 (CAPCOM message within 5s); Telemetry `capcom` telemetry.ts:454 | median/p90 answer ms today | Computed | CAPCOM answer times |
| FLIGHT answers | `flight_decisions` kind `answer` with question_id (store.ts:274; kinds core/flight.ts:30) | at, kind, seat, target_run, ref, about, decision, basis | 90d (639 rows) | FLIGHT answer times, reruns, rulings, merges |
| `attention_notes` / `attention_episodes` | store.ts:207-227 (trigger-maintained episodes) | key, kind (`ATTENTION_KINDS` core/hud.ts:434), seat, at, cleared_at | Kept (832 episodes) | Waits on review/ready/blocked/question (`noteWaits` store.ts:3655) |
| `comms` | store.ts:186 + label/ref/reply_to (store.ts:1108-1132), reactions (incl. `cant` + reason), pins | from, to, ticket, text, label (`question/handoff/blocker`), at | 90d (228) | Comms health; chatter pairs >6 rounds (`commsChatter` store.ts:3244; `GET /api/comms/chatter` api.ts:1270, fixed 24h) |
| `agent_events` | store.ts:104 | HUD state transitions | 30d | Time blocked/waiting (telemetry utilisation) |

### 1g. Tickets, sizes, cycle time, milestones

| Datum | Where | Shape | Retention | Answers |
|---|---|---|---|---|
| `board_items` | store.ts:118 + cols store.ts:987-1001; GraphQL `ISSUE_FIELDS` github.ts:73 | issue, title, status, state, labels, priority, **size** (XS/S/M/L), stage, owner, parent, sub_done/sub_total, blocked_by, **milestone (title only)**, created_at, closed, assignees | Live snapshot (755; size set on 301; milestone on 2) | Ticket size, epic progress (sub-issues) |
| Milestone due dates | `RepoGoal {title, dueOn, open, closed}` is declared at core/types.ts:424 but **nothing fills it**. ISSUE_FIELDS asks for `milestone { title }` only | — | — | Deadlines not collected |
| `flow_issues` | store.ts:130; collectors/flow.ts:196 | issue, size, start_at (first move into Ready/In progress/In review/QA, from the Project timeline), done_at | **Live 14d window**, replaced hourly (`FLOW_DAYS`) (384) | Cycle time by size (telemetry.ts:238-262) |
| `board_moves` | store.ts:149 | run, repo, issue, board_column, state, detail, at | Kept (1,234) | Only the moves Mission Control made, not moves people make on GitHub |
| Throughput | telemetry.ts:229-236 | merged per day, 14d | Computed | Delivery rate |
| `metrics()` closed per day | views.ts:371 | per agent per day: runs/ok/failed/tokens/cost/busy; closedPerDay | Computed; **no route serves it** | — |

## 2. The operator's questions

Status values:
- **Today**: answerable from stored data with a query or an aggregation route.
- **Small**: a small server change, typically a column, a GraphQL field or a route.
- **New**: needs a new collector or store.

### Audit board

| Question | Status | With what / what to add |
|---|---|---|
| Improvements to consider (long runners, death loops) | Today | runs (start/end, ticket, profile size) + run_attempts `loop` history (phase changes, ciFails, parked) + reviews.round. Long-runner medians need `board_items.size` or `flow_issues.size`. A `/api/audit` aggregation route is a server addition, about 1 file plus tests |
| Issues with PR lengths (size) | Small | Add `additions deletions changedFiles` to `PR_FIELDS` (github.ts:207) and 3 columns on `pull_requests`. History past 30d also needs merged PRs kept: either exempt merged rows from the sweep or copy them to a `pr_history` table at merge (run_attempts `merge` already marks the moment) |
| Issues with PR lengths (time open→merged, rounds) | Today (30d) / Small (longer) | pull_requests created_at/merged_at + reviews. Longer history needs the PR history table above |
| Prompt updates needed | New | No prompt version per run. Needs (a) sha256 of the role file + preamble/step prompt recorded at spawn on `runs` (supervisor reads `rolesDir` at supervisor.ts:1171): small; (b) a `prompt_versions` table keyed by hash with path + git sha + first_seen: small; (c) SURGEON's vendor-guidance check (#718): a new seat + network allowlist, large |
| Model changes | Today (model) / Small (account, effort) | `runs.model` + `runs.vendor` + `cli_version` give per-seat model history. Account and effort per run are not stored. Add `account_id` and `effort` columns on runs, written at start: small |
| Things we need to check (refusals, comms, open questions) | Today | guard_hits (kept), seat_questions, comms/chatter, attention_episodes, crew_errors, strays. `/api/guard/hits` caps at 30d; chatter is fixed at 24h, so a `since` param is a small addition |
| Token burn per seat/account/step/merged PR | Today (seat/step/ticket) / Small (per account history, per merged PR) | Telemetry totals/tokensByStep/tokensByTicket + usage_samples. Per-account history needs runs.account_id. Per merged PR = tokensByTicket joined to merged PRs: an aggregation only |
| CI flakes, rework rounds, questions, cost per merged ticket (principle 7) | Today, partially | Flakes: run_attempts `loop.rerun.flaked` (kept) or loop_events (30d), no test name. Rework: reviews.round + fixesSent. Questions: seat_questions. Cost: runs.cost_usd by ticket |
| Retrospective history | Small | `FlightRetrospective` is computed daily but kept latest-only in settings. Store each one in a `retrospectives` (repo, day, json) table |
| SURGEON findings and whether they paid off | New | Nothing exists. See the data model in section 4 |

### QA board

| Question | Status | With what / what to add |
|---|---|---|
| What the reviewer is checking | Today (live), New (structured) | Live: `reviews` state=running + the review run's digest (liveTool, lastText) + profile checklist + review depth. Per-check results are not recorded: RETRO's standards list is prose in roles/RETRO.md and `report_findings` carries no checks. Needs the emitter fields in section 3 |
| How good or bad tests are running (pass/fail, duration) | Small (suite pass/fail, durations) / New (per-test) | Durations: test_lock_runs (8d). Pass/fail: record `hook_event_name` (PostToolUse vs PostToolUseFailure) as the outcome in `test_lock_runs` at api.ts:1436 and extend retention: small. Only lock-held full-suite commands go through the lock, so single-file runs aren't covered. Per-test results and timings: new. Either parse vitest JSON/JUnit from CI artifacts (a GitHub Actions artifact collector, medium) or have seats and RETRO emit them (section 3) |
| Flaky tests | Small / New | Flake events per sha and workflow exist (run_attempts loop.rerun.flaked, kept). A `ci_runs` append-only table (one row per check run, with name, attempt and conclusion) is small, built from the `checks` already read every poll. Test-level flake attribution is new (needs per-test results) |
| Tests still on point or need updating | New | Nothing measures it. Proxies today: RETRO Important findings whose free text says "missing test" (no category field). Needs a finding `category` plus a QA-seat sweep emitting stale/obsolete test reports |
| Coverage | New | Not collected. Needs coverage output (CI artifact or seat-reported) and a store |
| Success rates | Today | Telemetry `quality`: firstPassReviewPct, reviewRoundsPerPr, sentBackPrs, ciGreenFirstPushPct, retroFindingsPerPr. Plus runs.status ok/failed, reviews failed/superseded, parks by kind. Longer than 14d needs a `since`/range param: small |
| Findings resolved? | Small (inferred) / New (per finding) | Inferred: a later reported round in the same author run+epoch with blocking=0 accepted the earlier ones. Per-finding resolution is not stored (`state` stays `open`). Needs a resolution column set by the engine when the next round reports, or by RETRO (section 3). Findings older than 30d survive only in run_attempts JSON |
| Milestones / deadlines | Small | Add `milestone { number title dueOn state }` to `ISSUE_FIELDS` (github.ts:73) and a repo `milestones(first:50){ title dueOn state openIssues: issues(states:OPEN){totalCount} closedIssues: … }` query to fill the existing `RepoGoal` type (types.ts:424). Today only 2 of 755 board items carry a milestone, so this needs the operator to use milestones |
| Success of the projects | Today (14d) / Small (longer) | throughput, cycle time by size, merged7d, epic sub-issue progress (board_items sub_done/sub_total). Longer series needs flow_issues to be appended rather than replaced |
| RETRO on every PR (#91) | Not built | Reviews exist only for crew-run PRs. PRs with no run have no `reviews` row, so QA coverage of all PRs is not measurable until #91 lands |

## 3. What the QA and audit agents would need to emit

Today the seats emit:
- `report_findings` (mcp/tools.ts:2171): verdict `{spec, quality}` pass/fail, summary ≤2000, and findings[≤50] of `{severity, file, line, summary, scenario, fix}`. Stored in reviews/review_findings. Scratch mode only.
- `report_evidence` (mcp/tools.ts:2137): one free-text note (what changed, how to deploy), stored in `run_evidence` (store.ts:155, 30d).
- `report_plan` (mcp/tools.ts:2255): plan text plus an optional profile override.

None of these carry tests run, test results, checks performed, finding categories or resolution. For the board to be fed by the agents rather than computed by the UI, these would need adding.

**RETRO (`report_findings`, additive optional fields):**
- `findings[].category`: an enum such as `correctness | security | spec | test-missing | test-wrong | test-stale | scope | style | docs`.
- `checked[]`: `{check, result: pass|fail|n/a, note?}`. The check ids are an enum mirroring the roles/RETRO.md standards and the profile checklist, so "what the reviewer is checking" is recorded per review.
- `tests[]`: `{command, file?, passed, failed, skipped, durationMs}` for each test RETRO ran in scratch.
- `mutations[]`: `{file, line, caught: bool}` for mutation checks.
- `resolutions[]` (round ≥2): `{findingRef: {reviewId, pos}, outcome: fixed|reply-accepted|held}`. This closes the open-finding gap.
- Stored as new columns or tables keyed on review_id. The `recordFindings` transaction (store.ts:2724) is the single write point.

**Build seats (`report_evidence`):**
- `tests[]` as above.
- `testsAdded[]` / `testsChanged[]` paths.
- `failedOnBase: bool` per added test, to back the profile checklist claim that nothing records today.

**A QA seat (new tool, e.g. `report_qa`, scratch/read-only):**
- A periodic test-health sweep: suite durations, slowest files, flaky tests (name, failures/runs), stale tests (file, reason), coverage summary.
- One report row plus item rows, the same shape as SURGEON's.

**SURGEON (#718, new tool, e.g. `report_audit`):**
- A report `{period, summary}`.
- items[] `{kind, evidence[] (run ids, PR numbers, comms ids, guard_hit ids), proposal, expectedEffect, metric, risk, ticket?}`.
- #718 already requires read access through mc tools: the tables in section 1 behind read tools (runs, run_attempts, reviews, guard_hits, comms, seat_questions, usage_samples).

**Server-side capture, no agent involved:**
- Test-lock pass/fail from the Post hook event.
- `ci_runs` from the checks already polled.
- PR size from GraphQL.
- Prompt hash, account and effort at spawn.

These are more reliable than self-report and should come first.

## 4. Proposed minimal data model

### Audit board

```
-- reuse as is: runs, run_attempts, reviews, guard_hits, seat_questions, comms,
--   flight_decisions, attention_episodes, usage_samples, board_items
ALTER TABLE runs ADD account_id TEXT;            -- written at spawn
ALTER TABLE runs ADD effort TEXT;
ALTER TABLE runs ADD prompt_hash TEXT;            -- sha256(role file + preamble + step prompt)
CREATE TABLE prompt_versions (hash TEXT PRIMARY KEY, path TEXT NOT NULL,
  git_sha TEXT, first_seen_at INTEGER NOT NULL);
ALTER TABLE pull_requests ADD additions INTEGER;  -- + deletions, changed_files
CREATE TABLE pr_history (repo_id TEXT, number INTEGER, ticket TEXT, author TEXT,
  created_at INTEGER, merged_at INTEGER, additions INTEGER, deletions INTEGER,
  changed_files INTEGER, review_rounds INTEGER, ci_fails INTEGER,
  PRIMARY KEY (repo_id, number));               -- written at merge, never swept
CREATE TABLE retrospectives (repo_id TEXT, day TEXT, report TEXT NOT NULL,
  PRIMARY KEY (repo_id, day));                  -- FlightRetrospective JSON, kept
CREATE TABLE audit_reports (id INTEGER PRIMARY KEY, at INTEGER, run_id TEXT,
  period_start INTEGER, period_end INTEGER, summary TEXT);
CREATE TABLE audit_items (id INTEGER PRIMARY KEY, report_id INTEGER, kind TEXT,
  -- long_runner|death_loop|comms|refusal|spend|prompt|model|pr_size
  evidence TEXT /*JSON refs*/, proposal TEXT, expected_effect TEXT, metric TEXT,
  risk TEXT, ticket INTEGER, status TEXT /*open|ticketed|dismissed|verified*/);
```

### QA board

```
-- reuse: reviews, telemetry quality, flow_issues, board_items, run_attempts
ALTER TABLE review_findings ADD category TEXT;
ALTER TABLE review_findings ADD resolution TEXT;      -- fixed|reply-accepted|held|waived
ALTER TABLE review_findings ADD resolved_review_id INTEGER;
-- and stop the 30d prune of review_findings, or move it to ≥90d
CREATE TABLE review_checks (review_id INTEGER, check_id TEXT, result TEXT,
  note TEXT, PRIMARY KEY (review_id, check_id));
CREATE TABLE test_runs (id INTEGER PRIMARY KEY, run_id TEXT, review_id INTEGER,
  sha TEXT, source TEXT /*lock|ci|retro|seat*/, command TEXT, started_at INTEGER,
  ended_at INTEGER, outcome TEXT /*pass|fail|freed*/, passed INTEGER,
  failed INTEGER, skipped INTEGER);
CREATE TABLE test_cases (test_run_id INTEGER, file TEXT, name TEXT,
  status TEXT, duration_ms INTEGER);              -- only when a reporter supplies it
CREATE TABLE ci_runs (repo_id TEXT, pr_number INTEGER, sha TEXT, workflow TEXT,
  name TEXT, attempt INTEGER, conclusion TEXT, at INTEGER, url TEXT,
  PRIMARY KEY (repo_id, sha, name, attempt));    -- from checks already polled
CREATE TABLE milestones (repo_id TEXT, number INTEGER, title TEXT, due_on INTEGER,
  state TEXT, open INTEGER, closed INTEGER, PRIMARY KEY (repo_id, number));
-- flow_issues: append (keep done rows) instead of replace-14d, for long-run cycle time
```

## 5. Gaps, shortest first

1. Test-lock outcome: the hook event already arrives and is discarded (api.ts:1436). Holds are kept only 8 days.
2. PR size is not fetched. Three GraphQL fields would cover it (github.ts:207).
3. Milestone due dates are not fetched. `RepoGoal.dueOn` is declared but unused, and milestones are barely used (2 of 755 items).
4. The account, effort and prompt version of a run are not recorded.
5. Findings have no category and no resolution, and the table is pruned at 30d. A JSON copy in run_attempts survives.
6. History windows are short: pull_requests 30d, flow_issues/flow_prs 14d (replaced), loop_events/run_evidence/review_findings 30d, test_lock_runs 8d, FLIGHT signals 7d, retrospective latest-only. The permanent stores are runs, reviews, run_attempts, guard_hits, seat_questions, attention_episodes, usage_samples, board_moves, run_commits.
7. There are no per-test results, coverage or test staleness data, from any source.
8. RETRO reviews only crew-run PRs (#91 is open).
9. `views.ts metrics()` (per agent/day runs ok/failed, closed per day) is computed by code that no route serves.
