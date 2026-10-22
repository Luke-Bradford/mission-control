# Control Centre — design

Status: draft for approval · 2026-10-17 · prototype: [`docs/prototype/control-centre-v19.html`](../../prototype/control-centre-v19.html) (UI reference; open it in a browser)

## 1. Intent

The operator runs AI coding agents (Claude Code, Codex) against several GitHub repos — today `shop-app` and `site-builder`, more to come, possibly on more accounts and machines. Today that means one VS Code window per repo, each with its own loop, and no single view of what is in flight, what is stuck, or how much of each subscription is left.

Control Centre replaces that with one place to:

- **talk to one agent about every project** — the **CTO**, a long-running supervisor that acts for the operator while they are away, decides what its rules allow and escalates the rest;
- **see every worker agent like an employee** — role, repo, account/model, session, the ticket it is on, where it is in its loop, and whether it has looped back;
- **see each repo's GitHub Project board natively** and set priorities that write back to GitHub;
- **answer escalations quickly** — a slow-pulsing indicator, a short brief, multiple-choice options with the CTO's pick, and a "discuss" thread;
- **track progress and spend** — burn-up to milestone, throughput, loop-backs, cost per agent and ticket, tool use, and projected usage of each account's weekly limit.

Success: the operator stops running per-repo VS Code sessions; they drop in from the Mac, PC, phone or watch, see what changed, answer what needs them, and work keeps moving overnight within the rules they set.

## 1a. Where things live, and what exists today (recon 2026-10-17)
**Control Centre is the hub where all agents run, configured and monitored, against any number of target repos.** Everything common to any repo lives and is mastered in the Control Centre repo. Each target repo keeps what is specific to it.

| Lives in **Control Centre** (common, configurable) | Lives in **each target repo** (its own rules) |
|---|---|
| agent runtime: scheduling, worktrees, launching `claude -p` / `codex exec` (or an interactive tmux session on demand), restarts, budgets | `CLAUDE.md`, `.claude/` skills, agents, hooks and settings — picked up automatically because agents run inside that repo's worktree |
| the CTO, rules, watches, escalations, notifications | `.autonomy/hard_rules.md` and the repo's loop prompt (what to work on and how, in that repo) |
| practices absorbed from today's loops: merge gate (`safe_merge`), board sync (`board.sh`), quota guard and usage sampling, escalation format (SD-32 `autonomy-question`), pause/hold sentinels, review-bot and CI polling, Codex checkpoints, tool-call budgets, blocked-pass sleep/wake, stop-after-N-failures, prompt sync from `origin/main` | the work queue source (e.g. shop-app's #2437 queue comment, a Projects v2 board) and any repo-specific values that override a common practice (budgets, review bot, whether QA is required) |
| templates for a new repo's rules (CLAUDE.md skeleton, hard rules, loop prompt, board) that you define in Control Centre and it writes into the new repo by PR | — |

An agent's instructions are layered: **Control Centre's common practice → the repo's `CLAUDE.md` / skills / hard rules → the repo's loop prompt**. The repo wins where they conflict. Common practices are config with per-repo overrides, so a repo can keep a different merge gate, budget or queue.

From the hub you can: add agents to a repo for a while and remove them; pause a whole repo, or one agent; move an agent between repos (it picks up the new repo's rules when it starts its next run there); create a new repo with its own rules from a template; edit a common practice once for every repo.

**Today's loops are the reference for good practice** (to be absorbed, not changed in behaviour):
| Piece | Today | Where its truth lives |
|---|---|---|
| **shop-app TA loop** (`com.example.ta-loop`) | `ta_loop.sh` runs `claude -p` per iteration (acceptEdits, stream-json) in the worktree `~/code/.shop-app-autonomy`; ~1.5–3 h iterations, 120 s cooldown; picks from the #2437 queue comment; branch → PR → review bot/CI → `safe_merge.sh` → `board.sh` status moves; Codex checkpoints via `codex exec` | prompt synced each iteration from `origin/main:.autonomy/loop_prompt.md`; `.autonomy/hard_rules.md`; repo `.claude/CLAUDE.md` |
| **Studio build loop** (`com.example.build-driver`) on site-builder | `drive.sh` → `run.sh` → `claude -p` (opus, fallback sonnet, `--dangerously-skip-permissions`) in `~/code/studio-loop-repo`; back-to-back fires; **quota guard** stops at 7d ≥ 80% | `~/code/studio-loop/prompt.md` (not synced from git) |
| Telemetry they already write | TA: `var/autonomy/loop.log`, `status.md`, `iteration-*.log` (stream-json: `system/init`, `rate_limit_event`, `vcs_state_changed`, `result` with cost/tokens), `board-transitions.log`. Studio: `logs/driver.log`, `logs/fire.*.log`, `.last_quota`, studio-server SQLite `external_agent_activity`. Both: `~/.claude/projects/**/<session>.jsonl` (with `gitBranch`), `~/.claude/sessions/<pid>.json` (live status + messaging socket) | — |
| Escalations | GitHub: `[operator-decision]` / `[loop-blocked]` issues, `autonomy-question` fenced JSON (SD-32: question, recommendation, reasoning, effort sunk, default-if-ignored, answers), queue comments | GitHub |
| Controls | `var/autonomy/PAUSE` sentinel (TA, graceful after iteration); launchd stop/start; blocking issue titles (studio); steering = prompt PR (TA) / prompt edit (studio), queue comments | the repos |
| Usage | `claude_usage.py` → OAuth usage endpoint (7d %); studio-server `:8788/api/quota` sampler; `rate_limit_event` in transcripts; Codex `~/.codex/sessions/**/rollout-*.jsonl` | — |
| Old engine | `engine/bin/supervisor.sh` (roles coder/pm/qa/researcher, `.autonomy/config.yaml`), `dashboard.py` on `127.0.0.1:8787` (~16k lines Python/vanilla JS) | **supervisors are dead** (plist points at a moved script); the dashboard therefore shows both loops "stopped" |

Gaps (not recorded anywhere structured): which ticket/PR and which step a run is on (only inferable from branch, board transitions, transcript tool events); per-iteration cost summary (TA); a TA quota guard; a local record of escalations and your answers; linking Codex checkpoints to iterations.

**How the absorption works**
1. **Inventory:** list every practice the two live loops and the old engine apply (the table above plus `ta_loop.sh`, `drive.sh`, `run.sh`, `safe_merge.sh`, `board.sh`, `claude_usage.py`, the loop prompts and their tests such as `test_quota_guard.sh` and `test_ta_loop_*.py`). Mark each as **common** (moves into Control Centre, configurable) or **repo-specific** (stays in the repo's rules or prompt).
2. **Master in Control Centre:** re-implement each common practice in the Control Centre repo with parity tests ported from the existing ones, so behaviour matches before anything is switched.
3. **Observe first:** while that happens, Control Centre reads the live loops in place (logs, transcripts, `status.md`, board moves, usage, GitHub) and shows them as agents and runs, so you get the hub view immediately with no change to the loops.
4. **Cut over one loop at a time:** Control Centre starts that repo's agent with the same prompt, rules and practices; the old launchd job is unloaded; you compare a few runs. Then the next loop.
5. **Retire the old engine:** once both loops run from Control Centre, the agent machinery in site-builder (`engine/`, `loop/`, the :8787 dashboard, the dead supervisor jobs) is removed by a PR to that repo, leaving site-builder as the ETL product only.

Gaps the absorbed runtime closes, because Control Centre now launches the runs: which ticket/PR and which step a run is on (it records them instead of inferring), per-run cost, a quota guard for every agent (the TA loop has none today), a local record of escalations and your answers, Codex checkpoints linked to the run that called them.

## 2. Goals, non-goals, anti-goals

**Goals**
1. Everything is configuration plus observed data: repos, projects, status mapping, accounts, agents, roles, loops, rules, watches. Adding a repo or an agent is a config change, not a code change.
2. Every number on screen is derived from one event log, the run model and GitHub — so screens never disagree.
3. The CTO's autonomy is explicit, per repo, and auditable (every self-made decision is logged with the rule it used and can be undone).
4. Works on a LAN: Mac host, PC browser, phone (PWA), watch (push notifications).

**Non-goals (v1)**
- Not a general project-management tool: GitHub Projects stays the source of truth for tickets.
- Not the site-builder product (an ETL service). Control Centre does absorb the agent-loop machinery that currently lives in that repo (`engine/`, `loop/`), which is then removed from it.
- No cloud hosting. Remote access is via Tailscale only (in v1); nothing is exposed to the public internet.
- No native iOS/watchOS app in v1.
- No multi-user/team features beyond the operator's login.

**Anti-goals** (it fails even if it "works" if…)
- It looks friendly/marketing-styled rather than dense and technical.
- Anything looks hard-coded to shop-app/site-builder.
- The adopted loops behave differently, slow down, or lose a rule because Control Centre took them over.
- The CTO acts outside its rules, or acts without leaving an undoable log entry.
- Agents ever see or handle credentials.
- Numbers disagree between tabs.

## 3. Constraints

- Runs on the operator's Mac (`my-mac`); viewable from LAN devices; login required even on the LAN.
- Subscriptions, not API billing: Claude Max and Codex Pro Lite (others may be added). `$` shown is API-equivalent (tokens × configured rates), labelled as such, never presented as a bill.
- Existing repos use: GitHub Projects v2 boards, a Claude Code Review bot workflow, `safe_merge`, per-branch dev servers. Control Centre must respect each repo's existing CI/branch protection and must not change workflows without asking.
- Global engineering standards (branch + PR workflow, parameterised SQL, authN ≠ authZ, lint/typecheck before done) apply to this repo.

## 4. Decided

### 4.1 Stack
TypeScript end to end.
- **Server:** Node + Fastify, SQLite (single file, WAL), SSE for live updates to browsers.
- **Web:** React + Vite + Tailwind + shadcn/ui, installable PWA with Web Push (phone, watch via phone).
- **CTO:** runs as headless `claude -p` iterations like the existing loops (the Agent SDK was not confirmed to bill to the Max subscription; see `docs/spikes/2026-10-agent-sdk-subscription.md`), with Control Centre exposed to it as an MCP server (tools: read state, move cards, message agents, escalate, etc.).
- **Workers:** agents launched by Control Centre inside the target repo's worktree, so the repo's `CLAUDE.md`, skills, hooks and settings apply. Default run mode matches today's practice — headless `claude -p` / `codex exec` iterations with stream-json captured; an agent can instead run as an interactive CLI session in tmux when you want to type into it. "Attach" on a headless run is a live view of its stream plus messaging the running session through its `~/.claude/sessions/<pid>.json` socket.

### 4.2 Data sources (researched; builder to verify exact shapes against current versions)
| Need | Source |
|---|---|
| Claude 5h/7d usage, reset time | statusline JSON `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`) |
| Claude session list/state | `claude agents --json` (`state`, `status`, `waitingFor`, `sessionId`); Agent SDK `listSessions` |
| Claude tokens, cost, commits, PRs, active time | Claude Code OTel metrics (`claude_code.token.usage`, `cost.usage`, `lines_of_code`, `commit`, `pull_request`, `active_time`), repo/branch attributes via env |
| Context %, tool use breakdown | Agent SDK `getContextUsage()` incl. `messageBreakdown.toolCallsByType` |
| Step/loop progress | hooks + MCP `report_step` calls from workers |
| Codex usage/limits | Codex app-server `account/rateLimits/read`, `account/usage/read`, `thread/tokenUsage/updated`; `state_5.sqlite` `threads` / `thread_spawn_edges`; rollout `token_count.rate_limits` |
| Boards | GitHub Projects v2 GraphQL (Status single-select, field values, sub-issues, iterations); webhooks or polling |
| Host CPU/RAM | local OS stats |

Managed Agents (beta `managed-agents-2026-04-01`) are API-billed (tokens + $0.08/session-hour), not subscription — out of scope for v1, noted as a future account type.

### 4.3 Domain model
`account` · `host` · `repo` (+ linked GitHub project, `status_map`, `goal` = milestone | epic | iteration, `loop_overrides` per role + label) · `role` (→ default loop) · `loop` (main steps, **side steps** reached only through an edge, optional steps, `skip_if_no_agent`; **edges** `{from, to, on: signal, rework: bool}`) · `agent` (one role, one repo or `*` for the CTO, one account+model, optional fallback account, one host) · `session` (one CLI process; earlier sessions kept) · `ticket` (GitHub issue; its PR and branch app are attached, never a separate card) · **`run`** (one agent working one ticket through a loop; state `active` · `queued` = waiting for this agent's own active run · `parked` = waiting on another agent or a check; path of `[step, minutes, outcome]`) · `pr record` (merged PR: loop-back counts, phase hours, human-commit and follow-up-fix flags, cost) · `event` (append-only; includes derived threshold crossings) · `escalation` (brief, options, CTO pick + confidence, fallback, urgency tier, answer + time) · `rule` · `watch` (standing = config; armed = set by the CTO with an expiry) · `incident` · `tool-call aggregate` · CTO published state (important-now, plan, scratchpad).

Agent state is derived: `working` · `waiting on agent` (only queued/parked runs) · `waiting on you` (active run blocked on an escalation) · `idle` · `error`. Attempt = 1 + rework edges taken. Edge signals are machine-detectable (`ci:fail`, `review:changes_requested`, `qa:fail`, `pr:pushed`, `agent:restart`, `step:done`, timers); free-text labels are display only.

Every number on screen is computed from these entities plus GitHub; the prototype's Metrics shows each formula and the glossary is normative.

Definitions (durations, windows, WIP, lead time, first-pass, rework, change failure, autonomy rate, intervention rate, wasted run, time-to-answer, ETA, projected-at-reset, alert_at vs stop_at) are as written in the prototype's Config → Glossary and are part of this spec.

### 4.3a Usage and limits
Each account's window usage is stored as **samples** every 30 min (claude: statusline `rate_limits`; codex: app-server `account/rateLimits/read`). **Samples are the source of truth for limits**; token counts are not linear with vendor % (cache, model mix, vendor weighting) and are used only for labelled "≈" estimates. Projection at reset = latest sample + last-24h pace × hours to reset. `alert_at`, `stop_at` and the over-100% watch fire on the sample that crosses them. Two estimates accompany a fallback switch: the source account "once X switch away" (its pace split by agents' token share, each stopped at its switch time) and the receiving account "≈ with X moved" (movers' 24h tokens from their switch time, converted with the receiver's own tokens-per-%). One definition must hold across header, CTO page, watches and charts; the builder may refine the pace model.

### 4.4 Config
`~/.config/control-centre/config.yaml` is the source of truth; UI forms write to it; the YAML is viewable read-only in Config. Shape as shown in the prototype (operator, accounts with windows/alert_at/stop_at, rates, hosts, integrations, held_label, repos with status_map and column limits, roles, loops, agents, cto_rules, watches). Default loops: `supervise`, `deliver`, `verify`, `research`, `plan` (steps and loop-backs as in the prototype).

### 4.5 Screens (prototype v19 is the reference)
1. **Agents** — KPI strip; CTO strip (state, next watch, decisions 24h, waiting-on-you); worker cards or table (auto by count): state + time in state, repo·account·model, session·ctx, active ticket + step n/N + attempt + loop segments, loop-back summary, blocking line, parked runs, 24h/14d numbers; activity feed.
2. **Loops** — all runs table (active + parked sub-rows); per-loop diagram with runs placed at their step and numbered loop-backs; per-run attempt grid (one row per attempt).
3. **Boards** — all-projects summary (milestone, open by state, closed 7d, agents) + cross-repo lists (in progress, review, blocked, held, planned next, closed 24h); per-repo GitHub-native Board / Table / By agent / Roadmap views with column limits, fields, labels, PR status on its issue, run notes, priority edit (writes to GitHub).
4. **CTO** — top to bottom: needs you (brief, options with CTO pick, discuss, fallback) → important now → watching → plan → proposals → aware of (repos, constraints) → sessions → decision log (undo/object) → agents asked it → scratchpad.
5. **Metrics** — delivery (burn-up → ETA, closes/day, time breakdown), quality (every loop-back, 14d), capacity (7d projection per account, 5h windows, agent time), cost (per agent, per ticket), tools, reliability.
6. **Config** — forms for everything in 4.4 plus glossary.

Docked CTO chat on the right (pins for needs-you with inline A/B/C, threads per escalation, slash commands); auto-hidden below 1280px with a header toggle. Agent and ticket drawers. Amber is reserved for "needs you"; held is pale blue.

### 4.6 Escalation process
raise → triage (rule check) → brief (catch-up bullets, options, CTO pick + confidence, cost, fallback) → signal by urgency tier → answer (choose / discuss) → act (CTO executes, logs) → learn (CTO may propose a rule change) → timeout fallback (re-raise in the morning digest).

Urgency tiers (configurable): **now** = blocks work in progress → push to phone + watch, pulsing badge · **soon** = blocks work due to start within 3 days → badge + digest · **later** → digest. A watch notification carries the title, the CTO pick and actionable A/B/C buttons; the watch complication shows the needs-you count, pulsing while any item is **now**. `alert_at` crossings go to the digest; `stop_at` stops new runs on that account. A **proposal** is a CTO suggestion with nothing blocked; approving it is the same as answering an approval. Presence (last browser activity) lets the plan assume an online operator may answer now.

### 4.6a Actions (what each control does)
| Control | Effect |
|---|---|
| pause after step | agent finishes its current step, pushes WIP, its run becomes queued |
| reassign… | move the active run to another agent in the same repo; run history kept |
| new session | end the session with a handoff note; start a fresh one on the same run |
| stop | push WIP; tickets return to the board unassigned (confirm) |
| message / ask cto | post into the agent's session / open a CTO thread about it |
| transcript / attach terminal | read-only transcript / attach to the live CLI on the host |
| plan: hold | that plan step does not start until released |
| plan: discuss | opens a CTO thread on that step |
| decided alone: undo | reverse the decision (where reversible) and log it |
| decided alone: object | keep it, record disagreement; the CTO may propose a rule change |
| proposal: approve / decline | same as answering an approval / dismiss with reason |
| priority select | writes the Priority field to GitHub, with undo |
| branch app: open | open the PR's running branch app |

### 4.7 CTO default rules
- **May decide:** reorder queue (bugs on main first); interrupt/reassign within a repo; move cards and add labels incl. `held`; restart a crashed agent (max 3 in a row); switch an agent to its fallback account when projected over 100%; start/stop branch apps; merge via `safe_merge` when review approved + CI green + QA passed (if the repo has QA) — on by default for every repo, switchable per repo (decided by the operator). "Undo" on a merge opens a revert PR, which goes through the normal flow.
- **Always asks:** product/spec decisions; adding an agent or spend over 5% of a weekly limit; credentials/secrets/account access; CI/workflow/branch-protection changes; deleting unmerged work; anything below 80% confidence.

### 4.8 Branch apps ("try it")
Each open PR with a runnable app gets a dev server on `my-mac.local:<port>`, started by the CTO when the PR opens and stopped on merge/close; QA's `start-app` step restarts it with test data. The card, drawer, Boards › branch apps and chat show "try app ↗". The optional `your-test` loop step waits for your pass/fail on it. This replaces "previews".

## 5. Security model
- Login required for every browser, including LAN. Session cookie over HTTPS via Tailscale (MagicDNS name + Tailscale-issued certificate); the PWA is installed from that address on iPhone, and pushes deep-link back to it.
- Authorisation: single operator in v1; every mutating endpoint still checks the session belongs to the operator (authN ≠ authZ), so adding viewers later is a role check, not a rewrite.
- Agents never receive credentials. At cutover agents keep pushing and merging with your `gh` login through the absorbed `safe_merge`, so behaviour matches today's loops. After cutover **GitHub access moves to a GitHub App installed on your repos** (decided by the operator); only the server holds its private key and mints short-lived installation tokens. Workers push, open PRs and merge only through server MCP tools, scoped to their own repo. Commits carry `Agent: <id>` trailers so authorship and the autonomy rate are computable. Branch protection and the review bot are left as they are; if the App needs adding to a bypass list or a ruleset, that is an always-ask item. Account tokens (Claude, Codex) stay in the macOS keychain / CLI auth files, readable by the server only.
- MCP tools exposed to agents are scoped: a worker can only act on its own repo and runs; only the CTO has cross-repo tools; tools mirroring "always ask" rules return an escalation instead of acting.
- All SQL parameterised. Inputs validated at HTTP and MCP boundaries.
- All text from GitHub, agents and chat is untrusted: render it as text (React default escaping; no `dangerouslySetInnerHTML`). The prototype builds HTML strings and is not a pattern to copy.
- Known risks to flag: the studio loop runs with `--dangerously-skip-permissions`; the TA loop's sessions load all user plugins and claude.ai connectors (including a broker's), and the broker's demo-only PreToolUse guard exists only in `~/code/shop-app/.claude/settings.local.json`, not in the `.shop-app-autonomy` worktree the loop runs in (the app-level `unattended_guard.py` still blocks broker mutation from worktrees). Cutover keeps behaviour identical, so these are fixed deliberately afterwards: per-role permission allow-lists and plugin/connector scoping become a Control Centre setting applied to every agent, and the broker guard moves into shop-app's committed settings by PR. *(My call)* A worker that needs a tool outside its allow-list is auto-denied and the denial is logged; the CTO may propose an allow-list change, which is an always-ask item. Nobody is woken for it.
- Worker sandboxes deny reads of credential paths (`~/.claude`, `~/.codex/auth.json`, keychain exports). Runs that need secrets (e.g. broker sandbox tests) use them only inside CI or a server-run test command, never in the agent's environment.

## 6. Left to the builder
- Exact DB schema, API routes, SSE event shapes, MCP tool names.
- Collector cadence and how to reconcile OTel vs statusline vs app-server data.
- Chart library (or hand-rolled SVG as in the prototype).
- Process supervision details (worktrees, restarts, log capture).
- Build order, provided the first slice is read-only: observe sessions, limits and boards before the CTO is allowed to act.

## 6a. Builder-check decisions (my calls — check these)
- **CTO cadence:** the server evaluates watches deterministically every 60s; the CTO session wakes only on events, threshold crossings or timers, never as a 60s LLM loop.
- **Unattributed usage:** your own sessions on the same accounts show as an "unattributed" share (sample delta minus agent estimate) and are excluded from agent figures.
- **Login:** local password (scrypt via `node:crypto`, no native dependency) + long-lived secure session cookie; passkeys later.
- **Hosts:** v1 runs workers on my-mac only; `host` stays in the model.
- **Digest:** an in-app digest page plus one push at 08:00 linking to it; no email.
- **Detection rules:** progress = a main step completed or a push · wasted run = a run that ended without progress · follow-up fix = a later merged bug PR linked to the original, or a revert · human commit = a commit without an agent trailer (agents add `Agent: <id>` trailers).
- **`your-test` step:** enabled per ticket by a configurable label or a CTO request.
- **What workers pick up:** per-repo `pick_from` statuses (default: the Ready-type column), never `held`, ordered by Priority.
- **First launch:** backfill what GitHub can supply (closes, review rounds, phases, goal scope); run-only fields start empty.
- **Branch apps config:** per repo `branch_app: {cmd, ports, health, seed}`, filled from each repo's existing dev-server setup (shop-app `stack.sh`, site-builder studio server).
- **Self-hosting:** agents may work on `control-centre` through the normal PR flow; the running instance updates only on a manual deploy.
- **New repos:** created from a rules template you define in Control Centre (CLAUDE.md skeleton, hard rules, loop prompt, board), written into the new repo by PR. A new repo starts with one developer; the crew grows through CTO proposals (each one an always-ask item over 5% of a 7d window).
- **GitHub changes:** when a repo is connected, Control Centre asks before creating the `held` label or an optional `Agent` project field; ticket ownership lives in Control Centre's DB (mirrored to that field only if you allow it). It reads each project's built-in automations and does not repeat moves they already make.
- **Cutover:** see 1a — inventory, master with parity tests, observe, cut over one loop at a time, retire the old engine.
- **Feasibility spikes before the plan locks:** (1) can Agent SDK sessions run on the Claude Max subscription rather than API billing; (2) are statusline `rate_limits` available without an interactive session, and can codex usage be read with no codex agent running. Results may change 4.1 and 4.3a.

## 7. Known prototype simplifications
- Data is frozen at Sat 17 Oct 02:42 BST; 14-day history is generated to be internally consistent.
- Metrics time-range and filter controls, and most buttons, are not wired.
- The phone layout is a responsive check, not a designed mobile app.
- The push/watch preview shows A/B/C buttons; in v1 (decided by the operator) iPhone and Apple Watch get a push with a deep link instead — no in-notification buttons and no complication. Those need a native companion app, deferred.

## 8. Decided by the operator at review (2026-10-17)
1. **CTO merge autonomy:** yes, via `safe_merge` when review + CI (+ QA) pass; on by default, switchable per repo.
2. **GitHub identity:** a GitHub App with server-held keys; agents never see a token (see section 5).
3. **Worker sessions:** live CLI sessions in tmux that you can attach to and type into (see 4.1).
4. **Away from desk:** Tailscale in v1, with iPhone/Apple Watch push notifications that deep-link to the decision; no native app in v1.
