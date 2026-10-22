# Control Centre v2 — a company of agents you check in on once a day

Status: draft for approval · 2026-10-18 · builds on [2026-10-17-control-centre-design.md](2026-10-17-control-centre-design.md) (runtime, absorption of the live loops, data model) and replaces its sequencing, its sign-in and its UI structure. Mockups from the design conversation: `.superpowers/brainstorm/2311-1792287227/content/` (`main-screen.html` option B, `needs-you-detail.html`, `agent-detail.html`, `board.html`).

## 1. Intent

The operator checks on their agents about once a day, in the morning. Today the morning too often brings news that a loop was blocked overnight, did nothing, and the "supervisor" never noticed. Plan 1 shipped a read-only window on the two live loops; it does not change that, and its pages read as a dashboard of placeholders.

Control Centre v2 is an **active management layer first and a dashboard second**: a CTO and a PM, as agents, keep the work moving while the operator is away, and the hub shows them in one screen what happened, what is moving, and what needs them — with detail one click away. It is meant to replace running one VS Code window per repo, at home first and later on their work account.

Success, in the operator's terms: no more "it was blocked all night and nobody said". When something stalls, either it was fixed by morning, or they were told and it is waiting on a clear choice from them.

## 2. The company: roles

Agents are job roles. The operator can talk to any of them; any agent can message any other.

- **CTO — runs the company.** Owns the agents and the work. Watches every agent continuously, notices a blocked, stalled or failing agent within minutes, and clears what it can (restart a stuck loop, send an agent missing context, re-order work, split or open tickets, merge passing work). Signs off decisions within the gates (§5). Brings ideas that fit a project's direction. Escalates to the operator only what is genuinely theirs, with what it tried and what it recommends.
- **PM — owns the work coming in.** Every ticket is clear (description, acceptance criteria, priority) before a worker starts it: **a worker never starts a ticket the PM has not marked ready**. For a new feature the PM gathers requirements, plans spikes and research tickets for agents, and plans the real work only once the picture is complete. Tracks whether the plan and deliveries (milestones) are on course and makes sure agents work in the right area.
- **Workers** — developers, plus research and QA agents. Each works one ticket in its lane and asks the PM, the CTO or another worker when it needs something outside its lane.

**A new feature, end to end:** the operator raises it with the CTO, the PM or both in one thread → the CTO says how it fits the direction → the PM asks for requirements and runs spikes/research → the PM plans tickets → the CTO signs off → workers pick them up. The operator sees the whole thread and can step in anywhere.

All agent-to-agent conversation is visible as **threads** (who asked whom, about which ticket), not buried in transcripts.

## 3. Two ways of working, one tool

- **Hands-off (home, the default here).** Loops run unattended; the CTO and PM keep them moving; the operator checks in once a day.
- **Hands-on (work).** A large shared repo where agents stay inside **lanes** — the areas each may change, as defined by the repo's own Claude files (`CLAUDE.md`, `.claude/` agents and rules). Several agents may share a lane and discuss things; the operator can read and step in. Tickets have **pause points** (plan ready, mockup ready, tests ready) where the agent waits for the operator. **Ad-hoc agents** can be spun up for a support request; from the findings the operator chooses fix now, plan in, or drop.
- **Away mode (work default when away).** Set before an evening, weekend or holiday from a **preset**: a from/to window, a polling interval, and tick-boxes for what is allowed (monitor team comms, check services, work safe tickets in the operator's lane, draft PRs, merge). Comms monitoring uses the Teams access Claude already has at work through its existing connectors — no new integration. A **welcome-back briefing** summarises what was said, what moved, what is drafted for review, and what needs a decision. Default: draft PRs only, never push or merge; a preset can allow merging.

One **autonomy setting per workspace** governs what the CTO may do: *draft only* (work default) or *merge* (home).

## 4. Order of delivery

Three projects, each usable on its own, each proven at home before work:

1. **The company runs the work (home)** — this document's detail (§6). Control Centre starts and manages the agents itself, with a CTO and a PM managing them, and the morning check-in screens. (The managers and the runtime were first planned as two projects; they are merged because the live loops can neither take work from the board nor receive messages, so a manager that does not own its agents could not steer them — decided.)
2. **Lanes** — several agents per lane, their conversations, stepping in; ad-hoc agents for support requests.
3. **Away mode and the work install** — presets, comms and services watching, welcome-back briefing; a separate install on the work account sharing nothing with home.

Projects 2–3 get their own design pass when their turn comes; this document fixes their intent only.

## 5. The gates (what "allowed without asking" means)

At home the CTO may do anything that passes these gates, without asking:

- **Tests pass** — the repo's own suite, run the way the repo runs it.
- **UI tested** — changed screens exercised in a real browser as far as possible.
- **Code review passed** — by the repo's own review setup.
- **Never unusable** — the app and the services it depends on (the loops, the hub) still start and work after a change; a breaking merge is reverted or fixed at once as top priority; nothing is stopped or restarted without being brought back.

Each repo also has a **direction** (its goal: a milestone or epic) and **tickets with priority** on GitHub; the CTO and PM plan from those.

**Always ask the operator first** (decided), whatever the gates say:

- deleting a branch that holds unmerged work;
- changing CI, workflows, branch protection, or a repo's hard rules;
- answering anything marked operator-gated (e.g. site-builder#410);
- changing a repo's direction (creating or re-dating a milestone);
- going over its usage budget (§6.5).

Everything else is allowed within the gates, including closing tickets and changing a loop's prompt through a gated PR.

Everything the CTO or PM does is recorded with its reason and appears in the next check-in, with undo or object where that is possible. Nothing happens silently because it needed no approval.

## 6. Project 1 in detail

### 6.1 What it delivers

- **Control Centre runs the agents.** It launches workers (`claude -p` / `codex exec`) in each repo's worktree with that repo's rules, picks their work from the board's **Ready** column, records each run's ticket and step, and keeps each running session reachable by message. The two live loops are absorbed and cut over one at a time, keeping their behaviour, as the 2026-10-17 design describes (inventory → parity → cut over → retire).
- A **CTO agent** and a **PM agent**, on the operator's subscription, with the behaviour in §2 and the gates and always-ask list in §5.
- **Research agents**: short-lived workers the PM starts for spikes and research tickets (decided).
- An **agents-first main screen**, a **needs-you detail**, an **agent detail**, a **GitHub-native board**, and **chat** with the CTO and PM — replacing Plan 1's six-tab layout.
- **No sign-in** on this Mac.

The CTO acts on agents through Control Centre (pause, stop, restart, redirect, message the running session — see §7 on messaging), and on GitHub (issues, comments, project fields, PRs). Until a loop is cut over it keeps running under its own launchd job and the CTO's levers on it are limited to its PAUSE sentinel, launchd, and GitHub.

### 6.2 Screens

**Main screen — agents first** (mockup `main-screen.html`, option B). Every agent, the CTO and PM included, grouped by state with **needs you** first, then **blocked**, **working**, **idle**, and **done · 24h**. One line per agent: name, its ticket and title, its current step with a small step bar, time in state, and a peek/reply control. Above the list, a one-line **overnight strip** (what the CTO and PM handled, escalated, and how the board moved) that expands into the full log. On the right, a **chat** with the CTO (switchable to the PM, or a thread). Header keeps account limits (7d used → projected) and the needs-you count.

**Needs-you detail** (mockup `needs-you-detail.html`), opened beside the list when an item is clicked, top to bottom:
1. **Up to speed** — what this is and why it is waiting on the operator, in plain words.
2. **The problem** — what stays stuck until they decide (e.g. "3 tickets parked").
3. **Assessments** — the CTO's view, the raising agent's view, and open questions the CTO already checked, each with confidence where it applies.
4. **Your choice** — two to four options, each with its consequences, the CTO's pick highlighted; or, if no choice exists, the thing they must do.
5. **What happens next** — the steps that run after they choose, with any step only they can do marked (e.g. "rename the repo in GitHub settings").
6. **Discuss** — a thread scoped to this item, plus links to the issue, PRs, notes and transcript.

**Agent detail** (mockup `agent-detail.html`): header with role, repo, account and model, and controls (message, pause after this step, redirect, open transcript); **Now** — the agent's loop drawn as steps with the current one highlighted, its duration and attempt, loop-backs, and gates; **Live** — the last few things it did; **Conversations** — its threads with other agents, joinable; **Recent tickets** — outcome, tries, time and cost. Runs are identified by **ticket and time**, never by the loop's internal iteration counter (it restarts with the process, which is why Plan 1 showed 61 next to 16).

Agents Control Centre launches record real named steps. A live loop not yet cut over shows what its logs reveal, labelled as such (see §8).

**Board** (mockup `board.html`): per repo or all repos, read from and written to the real GitHub Project. Columns: **Needs detail → Ready → In flight → Blocked → Done**. Cards show the PM's note (e.g. "needs acceptance criteria", "spike running"), which agent holds an in-flight ticket and its step, blocked tickets grouped by their blocker with the CTO's suggestion, and a **goal bar** (milestone progress and whether the PM thinks it is on track). Clicking a card opens the ticket: description, PM notes and research, sub-issues, the agent and its loop progress, the conversation, the PR.

**Not in project 1's UI:** Plan 1's Metrics and Config tabs are dropped from the main navigation; their useful numbers move into agent and ticket detail. (Builder may keep a settings page for the few things that are configured.)

### 6.2a How the UI must feel (decided)

- **Quiet pages.** No text describing what a page shows; words appear only where they are content (a ticket, a decision, an agent's message). Anything that benefits from explanation gets a small **help icon** with a tooltip.
- **Status lights, not prose.** A subtle **amber** light for things that need attention, **green** for things going well, **red** for blockages and failures, grey for idle. The light is never the only signal (shape or label too), and amber stays reserved for "needs you".
- **Good form.** Consistent spacing and padding (metrics and stat tiles properly padded, aligned figures), clear navigation with few top-level destinations, detail on click.
- **Dark and light mode**, both with text contrast meeting WCAG AA, following the system setting with a manual switch.
- **Usable at phone width** without horizontal scrolling.
- UI work is checked by design and accessibility reviews (contrast, keyboard, focus, tap targets) and by looking at the real screens in a browser, not only by unit tests.

### 6.3 GitHub as the source of truth

Verified against GitHub's API on 2026-10-18 for the operator's repos:

- **Status** on the Project keeps its existing options untouched (scripts such as shop-app's `board.sh` move cards by Status name, and GitHub replaces a single-select's option list as a whole). The PM's stage lives in a new single-select **Stage** field (*Needs detail* / *Ready*); a ticket with no Stage counts as Ready. (Revised 2026-10-18 while planning: additive fields cannot disturb existing data.)
- A single-select **Owner** field on the Project (PM / CTO / Agent / Operator) says who acts next; a saved "Needs PM" view filters on it. This is how a ticket is "assigned to the PM", since agents are not GitHub users.
- Both fields are created once, from a setup button the operator presses on the board; Control Centre never creates or changes project fields on its own.
- **Sub-issues** hold a feature's research and spike tickets (the board already shows Parent issue and Sub-issues progress).
- **"Blocked by" issue links** are the dependencies the Blocked column groups by.
- **Milestones** are a repo's direction and delivery date.
- Labels stay available for cross-repo search but are not the primary mechanism. Issue types are not available (personal-account repos).

Agents act on GitHub under **the operator's own account** for now (decided). Control Centre and the agents read and write these fields, so GitHub and the hub always agree.

### 6.4 No sign-in

The hub binds to `127.0.0.1` only and has no login, like VS Code or other local developer tools. The existing DNS-rebinding (Host) check and the JSON-only, same-origin POST rule stay, so a web page in the browser still cannot read or drive it. The first-run password setup and session cookies are removed. Remote access (phone, watch, PC) is a later concern, to be done through Tailscale's identity headers rather than a password.

### 6.5 Usage budget per repo

Each repo (project) has its own budget setting (decided):

- **a stop threshold** on the account's 7-day window — e.g. site-builder stops new runs at 80%; shop-app has none and keeps going;
- **when the account runs out**, that repo's agents wait until the window resets or capacity returns, then resume on their own.

The CTO and PM keep a **small reserve** so they can still report and unblock when workers are stopped; workers are stopped first. Falling back to the Codex account when Claude runs low is a per-repo option, **off by default** (Claude's call — the operator did not decide it).

### 6.6 Choosing the model for the work

Model choice is configuration, by role and by step, so cost goes where thinking is needed (decided direction; defaults are Claude's call):

- **Opus 5.5** for the CTO and PM, and for steps that form the plan: research, spikes, planning, design, untangling a failed attempt.
- **Sonnet 5.5** for executing a formed plan: implement, test, fix review comments, routine board and PR work.
- **Escalate on trouble**: a step that fails its gates twice, or a ticket the PM marks complex, moves to Opus for the next attempt.
- The **gates** (tests, UI check, code review, never unusable) are what make a cheaper model safe to use; every repo must have its PR checks in place before an agent may merge there.
- Per-repo overrides (e.g. pin a model) and per-ticket overrides by the PM. Codex models are available where a repo enables the Codex account.

## 7. Constraints and known facts

- **Subscriptions, not API billing.** Agents run as Claude Code / Codex CLIs on the operator's Claude and Codex plans (the Agent SDK's subscription billing is unproven — Plan 1 spike). The CTO and PM are long-running Claude Code sessions, not API calls.
- **Cross-session messaging** (Claude Code ≥ 2.1.224) is the only built-in way to reach a running headless `claude -p` session: each session has an inbox, `ListAgents`/`SendMessage` discover and send, messages are plain text and cannot approve permission prompts. A `-p` worker must have `crossSessionInbound: accept` to take messages unattended; otherwise held messages expire. It is a preview feature and may change.
- **Claude Code agent view and agent teams do not list or manage `-p` sessions**, so the hub cannot lean on them for the headless loops.
- **Lanes and rules come from each repo's own Claude files**; Control Centre does not invent its own.
- **Builds on the existing code** (Node/TypeScript server, React web app, SQLite store, the Plan 1 collectors); Plan 1's runtime and absorption design stands.
- Engineering standards from the operator's global `CLAUDE.md` apply to this repo (branch + PR, review, lint/typecheck/tests before done).

## 8. Left to the builder

- How the CTO and PM run: their prompts and tools, how often they wake, how they hold state between wakes, and how they talk to workers and to each other within the constraints in §7.
- How quickly "blocked / stalled" is detected and what counts as an overnight action worth listing. Detection is done by code (the collectors), which wakes the CTO only when something needs it — the CTO does not poll by spending tokens (Claude's call).
- What step information can honestly be shown for a live loop before it is cut over (e.g. from transcript tool events, branch and PR state, board moves) and how it is labelled.
- Whether to set up the Status options and Owner field on the GitHub Projects automatically or ask the operator once. Existing Todo/Backlog tickets start as **Ready**; the PM sweeps the backlog over the first days and moves vague ones to Needs detail; existing Status names that scripts depend on (e.g. shop-app's `board.sh`) are kept (Claude's call).
- Layout details within the mockups; which Plan 1 components are reused.

## 9. Calls made in the design conversation (Claude's, for the operator to check)

- The CTO and PM appear in the agent list like workers, with their own state.
- The PM's "ready" mark gates whether a worker may start a ticket.
- The overnight log is expandable from the main screen rather than its own page.
- Plan 1's Metrics and Config tabs leave the main navigation.
- The Owner project field, not labels or a machine account, marks who acts next.
- Remote access later via Tailscale identity, not a password.
- Stall detection by code that wakes the CTO, not by the CTO polling.
- Existing backlog tickets start as Ready; the PM sweeps them.
- Codex fallback off by default; model defaults (Opus plans, Sonnet executes, escalate after two failed gates).
