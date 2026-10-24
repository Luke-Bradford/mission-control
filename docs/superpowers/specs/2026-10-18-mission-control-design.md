# Mission Control — design

Status: draft for approval · 2026-10-18 · supersedes `2026-10-18-control-centre-v2-design.md` and `2026-10-17-control-centre-design.md` wherever they differ (their runtime, gate, budget and model decisions carry forward as noted in §8).

## 1. What this is

Mission Control is the operator's ops room for a crew of coding agents. A head agent, **FLIGHT**, runs the crew: assigns work, unblocks, decides what its rules allow, and brings the operator — **CAPCOM** — only what needs them, each item with a catch-up and a brief. The operator can talk to FLIGHT from any page (the docked fly-out) and can still message or interrupt any agent directly. It replaces running one editor window per agent, works on the operator's own subscriptions, and is built at home first (this Mac, the operator's own repos), then carried to the work Mac (company repos, Teams).

**The MVP is the Mission Control HUD mockup.** `docs/prototype/mission-control-hud.html` is the visual and interaction reference; `docs/prototype/mission-control-hud-catalogue.md` lists every page, panel, control, rule, data shape and build-status note in it, verbatim. Both are part of this spec: a builder implements what they show, with the decisions and amendments below. Sample data in the mockup (work repos, people, Windows paths) is illustration, not product (catalogue §6).

Success, in the operator's words: no more "it was blocked all night and nobody said"; one place to see what is in flight, done and planned; ask FLIGHT anything from any page; step in on any agent.

## 2. Cast

| Call sign | Role | Mode | Notes |
|---|---|---|---|
| CAPCOM | The operator | — | decisions, approvals, anything tagged `@CAPCOM` |
| FLIGHT | head agent | read-only | assigns, unblocks, plans, drafts, decides within rules, asks the operator; **replaces the CTO and PM** of earlier designs (decided 2026-10-18) |
| GUIDO-n | backend developer | writer | owns an area |
| INCO-n | frontend developer | writer | owns an area |
| BOOSTER-n | devops | writer | |
| SURGEON-n | QA | writer | |
| RETRO-n | reviewer | read-only | fresh eyes: ticket, plan, diff, check output — not the author's chat |
| NETWORK-n | researcher | read-only | code, docs, web (and Teams at work) |
| FIDO-n | architect | read-only | plans across areas |
| FAO-n | planner | read-only | board, priorities, queues (optional; FLIGHT covers this by default) |

Roles live in `roles/*.md`; call signs default to console + number and can be renamed (catalogue §0, §2.7.4).

## 3. Pages and behaviour

Exactly as the mockup and catalogue §1–§2: global chrome (session selector, six tabs plus Setup, MET clock, machine/lock pill, Needs you, Away, theme, Setup, FLIGHT chat toggle), the FLIGHT dock on every page (docked ≥1200px, drawer below), **Overview** (needs banner, Agents table with loop step / tokens / context / quota, Activity, Machine with the test lock, Account quota), **FLIGHT** (Situation and timeline, Asked of you, Work in flight, Incoming, Watch list, Drafts for you to send, Decided without you), **Board** (saved views, query, priority/agent/needs-me filters, Done range, Standup and Weekly brief, kanban with Mission Control's agent/PR/CI overlay), **Agent** (picker, need banner, header tiles, Activity stream with message / interrupt-and-send, Loop steps and timeline, Plan / Queue / Subagents / Files), **Comms** (Needs you with acknowledge and guard drawer, Threads, conversation), **Telemetry** (KPI tiles; Flow of work; Agents; Capacity; Cost), **Setup** (Sessions with folder areas and stray changes, Loops, Accounts and Auto-approve, Roles / guard / test lock, Sources, Access and notifications), **Away mode**, the **Item panel** (catch-up, brief, choices, chat), keyboard shortcuts and lamps.

UI rules that carry over from the v2 design and agree with the mockup: colour only for state and always with a word or shape; amber = waits on you (breathes), green = being worked (breathes), red = broken; dark and light themes at WCAG AA; no horizontal scroll at phone width; quiet pages (explanations behind help).

## 4. Decisions that settle the mockup's open points

1. **Host:** Mission Control runs on a Mac (this Mac now; the work Mac later). Windows paths in the mockup are sample data. Other devices view it over Tailscale later (§7, phase 4).
2. **Merging is a per-workspace autonomy setting.** `draft` (the work default): Mission Control never merges or marks a PR ready, except that in away mode a *safe* PR may leave draft (catalogue §5.7). `merge` (home, decided 2026-10-18): Mission Control merges a PR itself once every gate in its loop has passed (tests, review, CI, area rules). The guard rule and the Open PR text follow the setting. This resolves catalogue §7.3.
3. **Outward writes need CAPCOM's approval** (GitHub comments, labels, board moves, Priority changes, starting/stopping agents, switching accounts) until the matching Auto-approve toggle is on. Exception: in `merge` workspaces, the merge itself and the board moves that follow a merge are part of the loop and need no approval. Mission Control never messages people itself; Teams is copy-only (catalogue §5.1).
4. **Numbers are computed, never constants:** lock typical time from lock history, Lock wait and Your response KPIs from the store (catalogue §7.2, §7.5).
5. **Sign-in:** none on loopback (as today). When Tailscale access arrives, the dashboard asks for its access token (catalogue §2.7.6).
6. **Teams** is work-only and comes last (catalogue "P5"); at home, Sources is GitHub only.
7. **The live loops** (shop-app TA loop, site-builder studio loop) stay observed-only until the operator chooses to move them; the first crew works on the mission-control repo itself (decided 2026-10-18).
8. **Agents act on GitHub under the operator's own account** (decided 2026-10-18).

## 5. Engine (how it is built)

What the mockup's build notes call "P1a" exists only at work and cannot be brought across; this engine is built here to the same design, and is polished on the work Mac later.

- **mc-server** — the existing server: SQLite store, scheduler, collectors, change events over SSE, loopback-only HTTP with the Host / JSON-POST / same-origin checks. It gains the agent runtime, loop engine, test lock, guard, mailbox, FLIGHT and machine sampler below.
- **Agent runtime** — each agent is a long-lived CLI session driven over stream-json both ways (`claude -p --input-format stream-json --output-format stream-json`), which gives mid-turn messages, interrupts, usage and rate-limit events, tool calls, task lists and subagent frames on the operator's subscription, the same capabilities the mockup notes attribute to the Agent SDK. **Check first** (spike, phase 2 task 1): mid-turn message, interrupt, context-usage report, rate-limit events, and that it bills to the subscription. If a capability is missing, the Agent SDK is the fallback for that capability only. Codex agents via `codex app-server` come later (work accounts).
- **Accounts** — one profile per login, each with its own config folder so logins never mix; Mission Control never reads credentials (catalogue §5.8).
- **Sessions and areas** — one session is one ticket: one branch, one checkout (git worktree) and one PR; writers own non-overlapping folder globs; a change outside every writer's area is a stray change in Needs you (catalogue §5.3).
- **mc tools** (an MCP server Mission Control gives every agent): commit, push, draft PR, run the full suite (through the test lock), propose a write (approval through FLIGHT), ask FLIGHT, ask the operator (FLIGHT only; carries the structured brief), send a message to another agent, report loop evidence. Scratch review seats also have `restore_file { path }`: restore a regular file from verified objects at the review head, preserving its mode, or remove an untracked regular file absent from that head. Other seat modes cannot call it.
- **Guard** — hard stops in code via the CLI's PreToolUse hook: git writes only through the mc tools; no merge / force-push / protected-branch push (except the loop's own merge in `merge` workspaces); GitHub writes need approval; full test suites only through the test lock; read-only roles cannot write. "Catches agent mistakes and ordinary spellings, not deliberate evasion." Hits are recorded and shown (catalogue §5.9).
- **Test lock** — one full suite at a time across the machine, oldest waiter first; per-repo profile says which commands count as a full suite (catalogue §5.5).
- **Loop engine** — YAML templates (`loops/*.yaml`: feature, bugfix, small-change, research, review, tiger-team, watch) with steps, gates and checks of kind cmd / rule / review / gate / agent; Mission Control decides every move from its own checks — an agent saying it is done can only hold work back. Retry rule: tries 1 and 2 resume the same agent; try 3 starts a fresh agent on a stronger model; then the ticket parks for CAPCOM; a retry with no progress stops early. Budgets per loop (tokens, rounds) and per repo (7-day quota stop) (catalogue §3.6, §5.6).
- **Models** — plan and review steps on Opus, implementation on Sonnet, escalation to a stronger model on try 3; per-repo and per-ticket overrides (carried from v2 §6.6).
- **FLIGHT** — a long-running Opus session (fresh session with a handoff after N turns, default 40) with read access to the store and board, the mc tools, `ask_operator` for briefs, and the mailbox; it writes the Situation, Watch list, Drafts, Incoming triage and Decided-without-you (each with its basis; Overturn messages the agent). Woken by events from the scheduler rather than polling with tokens.
- **Mailbox** — threads between FLIGHT, agents and CAPCOM; `@CAPCOM` is a convention Mission Control parses.
- **Machine sampler** — CPU, memory, disk (Node `os`, `fs.statfs`) and per-process memory (`ps`).

## 6. What already exists, and what happens to it

| Built (merged) | Becomes | |
|---|---|---|
| Server foundation: store, scheduler, SSE, security hooks, config, launchd, `MC_PORT` preview | mc-server foundation | keep |
| Live-loop collectors (TA, studio), transcript fold, sessions registry | Overview Agents/Activity for observed loops; Telemetry history | keep |
| Usage readers (5h/7d, projection, staleness) | Account quota panel, Quota used chart | keep; add time-to-full and per-window warnings |
| GitHub: board, escalations + SD-32, sub-issues, blockers, milestones, ticket detail, field setup | Board page data, Item panel inputs, Incoming (escalations) | keep; Board columns follow the repo's Status (the Stage/Owner fields become optional — FLIGHT and the board's Status replace them) |
| Views: overview, activity, metrics, config | Telemetry KPIs and Flow of work, Setup read-only views | keep and extend |
| Web: data layer, router, themes + contrast test, Light/Help, tests | HUD shell plumbing | keep |
| Web pages: agents-first list, needs detail, agent detail, board columns, settings | Rebuilt as the HUD pages; pieces reused inside panels | rework |
| Plan 2c runtime design (not built) | Folded into §5 (sessions, gates, steps, models, budgets) | rework |
| CTO/PM design | Replaced by FLIGHT | drop |

## 7. Order of work

Each phase is usable on its own and proven at home before the work Mac.

1. **HUD shell on today's data.** Global chrome, FLIGHT dock (present, says FLIGHT is not running yet), Overview (Agents table for observed loops, Activity, Machine sampler, Account quota), Board (HUD layout, briefs), Agent page (observed agents: stream from transcripts, tiles), Comms (Needs you from escalations and stalls, acknowledge), Telemetry (everything computable from today's store and GitHub), Setup (read-only views), Away modal (UI with persisted settings, not yet acted on), keyboard shortcuts. Build-status chips kept as a dev toggle.
2. **Engine.** Runtime spike (check-first list), accounts, sessions and areas, mc tools, guard, test lock, loop engine with templates, mailbox and direct messaging / interrupt, crew on the mission-control repo, Work in flight, loop panels, Setup editing.
3. **FLIGHT.** Head agent, ask_operator briefs and the Item panel's real choices, Situation, Watch list, Drafts, Incoming triage, Decided without you and Overturn, queues and Priority approvals, Auto-approve.
4. **Away mode and access.** Away rules acted on, digest, notifications (PWA + chime, quiet hours), Tailscale with access token.
5. **Work.** Codex accounts, Teams (read-only polling), work repo profiles, move to the work Mac.

## 8. Carried-forward decisions (still binding)

Per-repo budget with a 7-day stop threshold and wait-for-reset; FLIGHT keeps a small reserve; Codex fallback off by default; gates before merge (tests, review, CI, never unusable); always-ask list (unmerged-branch deletion, CI / workflows / branch protection / hard-rule files, operator-gated escalations, milestone changes, going over budget); quiet UI with status lights and AA contrast; loopback with no sign-in until Tailscale; GitHub as the source of truth for work.

## 8a. Calls made while writing this spec (Claude's; the operator to check)

1. **Seats, sessions and runs.** The mockup's text says "one session is one ticket", but its data gives agents a fixed session and a queue. Settled as: a **session** is a working context on one repo (its agents and their non-overlapping areas), created in Setup or by FLIGHT; a **run** is one ticket on its own branch, git worktree and PR, created by Mission Control when a seat takes its next ticket and removed when the PR closes. Areas belong to the seat; slot limits count seats; stray detection runs over each run's worktree. Read-only seats (RETRO, NETWORK) may work tickets in any session of the same workspace.
2. **The home board.** mission-control gets a GitHub Project shaped like the mockup's board: Status `Backlog, Refinement, Blocked, Ready, In progress, In review, Ready for QA, Done`, Priority `P0, P1, P2`, Size `XS, S, M, L, XL` (created by Mission Control's setup action with the operator's click). Other repos keep their own Status sets, mapped to these columns by the existing per-repo status map; a column a repo lacks is simply empty for it.
3. **What a `merge` workspace does without asking:** a seat taking its next queued ticket, the board moves that follow the loop (Ready → In progress → In review → Done), marking its own PR ready, merging after every gate passes, and closing the issue. The operator's rule (2026-10-18): "if it passes the tests, nothing" needs asking, within the always-ask list. Adding a new seat or changing a seat's account still asks until Auto-approve is on.
4. **Credentials.** "Mission Control never reads credentials" means it never stores, shows or sends them. The existing Claude usage reader (Keychain OAuth token → the usage endpoint, as the operator's own `claude_usage.py` does) stays, so quota shows even when no agent runs. Home has one Claude login and one Codex login; the existing `~/.claude` login is the default profile, and further profiles get their own config folder.
5. **Away mode at home.** In a `merge` workspace away mode changes nothing about merging; it adds the digest and notification behaviour. Its "never merges" rule applies to `draft` workspaces.

## 8b. Decided by the operator (2026-10-18, from the builder check)

1. **Crew agents do not load the operator's personal Claude setup.** Each crew account runs from its own config folder; agents get the target repo's own `CLAUDE.md` / `.claude/` plus a role brief (`roles/*.md`) that carries the operator's engineering standards (tests, lint, typecheck, no magic strings, parameterised SQL) but not the push / PR / merge workflow, which the loop engine owns and the guard enforces. The operator's own editor sessions are unaffected.
2. **Mission Control never restarts itself.** The crew works in a separate clone; merges to `main` go live when the operator presses **Update** (pull, build, restart). Runs in progress survive a restart by reattaching to their sessions (`--resume`), so a restart never loses a ticket's progress.

## 8c. Decided by the operator (2026-10-20): repo permissions are the ceiling

How crew permissions are gated once Mission Control serves more than one person's repos. Not needed
for the first crew; the 2b guard is to be built so this can land without reshaping it.

1. **Each repo has a permission set, and it is the main gate.** It is the most any agent may do in
   that repo, whatever its role. The operator sets it per repo; agents never change it.
2. **Each role has the permissions it can typically use** (a dev more than a planner, QA or
   retro).
3. **An agent may do only what both allow**: the overlap, with the repo as the core set. A dev in
   a repo marked read-only can only read.
4. **Example:** a repo the operator is working on by hand, added so the crew can review it and suggest
   changes for them to read, or an authentication repo other agents must understand to work with.
   Agents may read it and raise tickets about it; none changes its code or opens a PR on it.
5. **Reading another repo is granted, never assumed.** Reading a reference repo means the repo's
   set allows it and the seat gets its own read-only checkout, never the operator's working folder. Today
   only the file tools are confined to the worktree (`--restricted`); code a seat runs through Bash
   is sandboxed by a deny list and can still read other folders, so 2b must also confine those reads
   (e.g. deny-read the other repos and the operator's working folders) before a repo's set can withhold read.

Claude's guess at the levels, for the 2b design to settle: *reference* (read, raise tickets),
*checks* (also run tests and lint), *dev* (also edit, commit, push, open PRs). Raising tickets and
opening PRs are separate permissions; the area globs stay a finer limit inside *dev*.

## 9. Check first (unknowns to test before relying on them)

From the mockup's notes plus this build: CLI stream-json mid-turn messages, interrupt, context-usage breakdown and task-list events; subscription billing for driven sessions; Claude subagent frames; Codex app-server (work); Teams refresh token under the work tenant's sign-in rules; Tailscale on the work laptop; board link `filterQuery`.

## 10. Not in the MVP

Multi-user, cloud hosting, Managed Agents, posting to Teams, editing the mockup's sample work context into product.
