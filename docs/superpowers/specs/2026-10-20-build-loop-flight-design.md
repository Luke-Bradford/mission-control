# The build loop and FLIGHT — design

Status: draft, written 2026-10-20 from the HUD mockup catalogue and the Mission Control spec, without
questions to the operator (the operator's choice: "fine tune anything later"). Calls made while writing are listed in §14
for the operator to check whenever convenient. This is phase 2c (the loop engine) plus a first FLIGHT (phase 3),
built as one design because the operator's goal needs both: "let the app build, no gaps, all working as
planned in their loops from the board, flight ensuring we're working towards getting things over the
line, being able to re-direct the plan via flight."

Parent spec: `docs/superpowers/specs/2026-10-18-mission-control-design.md` (binding where this is
silent). Source for every surface: `docs/prototype/mission-control-hud-catalogue.md` (CAT).

## 1. What this is

Today a Claude Code session is the loop: it writes tickets, pushes each seat's commits, opens the PR,
dispatches a review, relays findings, merges, ends the run, starts the next ticket. Nothing moves
unless that session notices. After this design, Mission Control is the loop:

- a seat takes the next ticket from the board, works it through its template's steps, and
  Mission Control runs every check itself;
- a RETRO seat reviews each PR with fresh eyes; findings go back to the author as a fix step;
- when every gate passes, Mission Control merges, closes the issue, moves the card to Done and the
  seat takes the next ticket;
- FLIGHT keeps the board flowing (triage, queues, unblocking, answering agents) and brings the operator only
  what needs the operator, each with a brief; the operator redirects by talking to FLIGHT.

Everything an agent "says" is evidence only; the engine decides every move from its own checks
(CAT §2.7.2: "an agent saying it is done can only hold work back, never push it forward").

## 2. Goals, non-goals, anti-goals

Goals
- The mission-control repo builds itself from its board with no controller session in the loop.
- Every move is recorded with its basis and visible on the HUD (Loop column, Work in flight, Agent
  Loop panel, FLIGHT page, Activity).
- The operator redirects from the FLIGHT dock, and sees what changed.
- Every outward write is listed in §12. Most are what the spec's `merge` workspace already allows
  (§4.3, §8a.3); the six that go beyond it are declared there as deviations, each with its basis
  and its off-switch.

Non-goals (later phases, unchanged from the spec)
- Teams, notifications/PWA, the away-mode behaviours (the settings UI stays; nothing acts on it).
- Codex seats, work-repo profiles, Tailscale.
- Editing loop templates in Setup (templates are YAML files changed by PR; Setup › Loops shows them).
- The `tiger-team` template runs (it is defined, not executed, in this phase).
- EECOM (the audit role the operator described) and SURGEON. Both need the run records this phase produces.
- Multi-session on one repo. One session per repo in this phase; the schema does not assume it.

Anti-goals (would make this a failure even if it works)
- FLIGHT or a seat merging, marking ready, pushing, posting or moving cards on its own say-so. Only the
  engine does outward writes, and only the ones listed in §12.
- A loop that keeps a stuck ticket spinning. Retries are bounded; a ticket parks and tells the operator why.
- A review that only reads. RETRO runs the tests and mutation-checks the fixes; the five-round guard
  review in Plan 6 showed that reading alone misses most real bugs.
- The operator having to answer questions to keep work flowing. Within the rules, FLIGHT decides and records;
  the operator overturns.

## 3. Constraints

- Everything in Plans 3–6 still holds: live loops observed only; previews run no crew; erasable
  TypeScript; constants once in `@mc/core`; every route in the route table with a zod body; tests
  never spawn the real `claude` and never bind a port.
- Agents act on GitHub under the operator's account. Every new GitHub write this design adds is listed in §12
  and in each PR's security note.
- The guard stays as built: seats cannot commit, push, merge, mark ready or move cards. The engine
  does those in the hub, through `crewGit` and `gh`, after its own checks.
- One full suite at a time across the machine (the test lock) for seats' own runs, as Plan 6 built
  it. The engine's verify reads CI and runs nothing on the Mac.
- The hub never restarts itself. §11 adds a queued, idle-time Update that the operator switches on.

## 4. The board is the work queue

The board is GitHub Project #5 as the spec shaped it (§8a.2): Status `Backlog, Refinement, Blocked,
Ready, In progress, In review, Ready for QA, Done`; Priority `P0–P2`; Size `XS–XL`. GitHub stays the
source of truth; the hub reads it through the existing collectors and writes to it only as §12 lists.

Where a ticket comes from and where it goes

| Status | Who puts a card here | What happens next |
|---|---|---|
| Backlog | The operator, FLIGHT (tickets it raises), tech-debt issues | FLIGHT triages (§8.3): promote to Ready, or to Refinement with a question |
| Refinement | FLIGHT, when a ticket lacks what a seat needs | The operator (or the reporter) answers; FLIGHT re-triages |
| Ready | The operator, or FLIGHT within the repo's rules | The next free seat whose focus matches takes it, by Priority then age |
| In progress | the engine, when a run starts | the run's template drives it |
| In review | the engine, when the draft PR opens and verify has passed | RETRO review; fix rounds; merge gate |
| Blocked | the engine, when a run parks; the operator | Needs-you item with the reason; FLIGHT's Watch list tracks it |
| Ready for QA | unused at home (`merge` workspace); kept for work repos | — |
| Done | the engine, on merge (issue closed) | — |

Per-repo rules live in the repo, in a `## Mission Control` section of its `CLAUDE.md`, as prose plus
one fenced `yaml` block the hub parses. Prose is for FLIGHT and the seats; the block is for the
engine. Keys, with the home defaults:

```yaml
mc:
  pick_from: [Ready]            # statuses a seat may take tickets from
  promote_backlog: true         # FLIGHT may move Backlog → Ready when a ticket is complete (§8.3)
  needs: [done_when, size]      # what "complete" means: a "Done when" section, a Size
  templates:                    # label → template; first match wins; else by size (XS/S → small-change, else feature)
    "type:feature": feature
    "bug": bugfix
    "chore": small-change
    "test": small-change
    "docs": small-change
    "research": research
  areas:                        # area label → the globs it covers; a seat's focus is the labels inside its area
    "area:server": ["apps/server/**"]
    "area:web": ["apps/web/**"]
    "area:core": ["packages/core/**"]
  hard_rules: null              # paths that never auto-merge or auto-Update; null or absent = the §5 list, [] = none
  ci: null                      # check-run names verify requires; null = every check run on the head sha
  always_ask: []                # labels that force a go/no-go ask to CAPCOM
```

A repo with no section gets these defaults with `promote_backlog: false`. The permissions ceiling
(spec §8c) sits above all of this: a `reference` repo yields no runs.

Picking order (CAT §2.4.6, the operator's "ready, then backlog"): a seat's queue is filled from `pick_from`
statuses, highest Priority first, oldest first within a Priority, filtered by the seat's focus
(the area labels inside its area). A ticket with no template label takes `small-change` when its
Size is XS or S, else `feature` (the strictest checks); the per-repo `templates` map can override
either. Backlog tickets never go straight to a seat; FLIGHT promotes them first, so
"then backlog" means "FLIGHT triages the backlog when Ready runs dry". A seat with an empty queue
is idle and says so ("Nothing assigned · FLIGHT fills this from the focus").

## 5. Runs and the loop engine

A **run** is one ticket on one seat: its own branch (`branchFor`), worktree, draft PR, template and
step records. It is created when a seat takes the ticket and ends when the PR closes. The run row
gains: `template`, `node`, `attempt`, `round`, `parked_reason`, `tokens_used`; `run_steps` records
`[step, try, outcome, tokens, minutes, started_at, ended_at, failure]`; `run_checks` records each
check's `[kind, text, status pass|fail|run|wait, detail, at]` for the current node.

Templates are the catalogue's seven, as YAML in `loops/*.yaml`, validated at start. A bad template
turns the engine off with a note naming the file and path; it never refuses hub start, which would
crash-loop under launchd. The schema follows CAT §3.6: `trigger`, `rounds`, `budget`,
`rules`, `path`, `nodes[{id, role, gate?, max?, checks[[kind, text]]}]`. The initial files carry
the catalogue's steps, checks, budgets and retry rules verbatim (feature 3/400k, bugfix 3/250k,
small-change 2/120k, research 2/150k, review 1/120k, tiger-team 2/600k, watch ∞).

Check kinds and who runs them (CAT §5.6):

| kind | runs | examples |
|---|---|---|
| `ci` | the repo's CI on the pushed head sha, read by the hub from GitHub | full suite; typecheck; lint; build |
| `rule` | the hub, from the diff, the board or the PR (git and GitHub reads only) | diff inside the area; no stray files; no test weakened, skipped or deleted; PR is open as a draft; no hard-rule file without CAPCOM's go |
| `review` | a fresh RETRO run (§6) | spec verdict; quality verdict; blast radius; "new test fails on the base commit" |
| `gate` | FLIGHT or CAPCOM | go/no-go after plan; starting a new seat |
| `agent` | the seat's own evidence, via `report_evidence` | the test file it wrote; "each finding has a commit or a written ruling" |

**Verify runs on CI; the hub runs no worktree code.** The catalogue's `[cmd]` checks (full suite,
typecheck) are judged from the repo's CI on the run's pushed head sha: every check run GitHub
reports for that sha must finish `success` (or `skipped`/`neutral`), with at least one present; a
repo can name the required ones with `ci: [names]` in its `mc` block. This is sound because a seat
cannot change what CI runs: `.github/**`, every `package.json`, the lockfile, the vitest, vite,
biome and tsconfig files are protected and the commit tool refuses them (Plan 6), and test
weakening is a `rule` check on the diff. CI runs on GitHub's machines, never on the Mac, so no
sandbox for code under test is needed and no install of a branch's dependencies happens on the hub.
Seats keep running their own single-file tests and full suite inside their sandbox through Plan 6's
guard and test lock, unchanged. A repo with no CI cannot run a template with `ci` checks: the
engine parks its run at verify with "this repo has no CI". "New test fails on the base commit" is
RETRO's to prove in its scratch copy (7b); before 7b it is an `agent` check (the seat names the test
file) and is recorded, not gated. A hub-owned sandboxed check runner, for repos without CI and for
the base-commit proof without RETRO, is later work (§16) and was dropped from 7a after four review
rounds showed its surface (sandbox profile, branch-controlled install, process reaping) cost more
than it bought while CI exists.

The engine is a state machine per run, persisted, advanced by events, never by polling an agent: a
`report_evidence` call, the seat becoming idle, the GitHub poll (CI state of the head sha, PR
draft/review/merge state, the card's column), an operator or FLIGHT message, a RETRO run ending,
and a 60 s scheduler tick as the safety net. **The engine writes to a seat only between turns**
(a rate-limited seat may be written to, as the operator's messages may), so its lines never fold into a turn someone else
started; a send due while the seat is busy waits for idle. The engine is **level-triggered**: on
every trigger it re-derives, from stored facts alone (evidence rows, commits, the pushed sha, the PR
and CI state, the card's column, the lines and notes already raised), both the run's next state and
every action that should already have happened (push, PR, card column, Needs-you item, a keyed line
to the seat), and does whatever is missing; so a lost trigger, a crash or an Update at any moment
only delays an action to the next pass. A go/no-go or a hard-rule touch that needs the operator is a Needs-you
approval the engine raises itself; the operator answers with `go` or `no-go` to the seat, and the engine
consumes that message rather than forwarding it. Every transition is an Activity row. Today's
Activity kinds are run-start, run-end, escalation, collector, state, pr-opened and pr-merged,
derived from tables; this design adds `step`, `check`, `board` and `push` rows, each derived from
the table that records the move, so a board move or a push never happens without a row.

How a step runs
1. The engine opens a step (one row per visit to a node), writes the step's brief to the seat (the
   ticket, the node's checks in plain words, and for a retry the exact failure), and lets the seat
   work. The seat ends the step with `report_evidence`, accepted only at a node the seat works. A
   plain reply does not end a step: once the brief has been delivered and the seat has since gone
   idle with no evidence for that step, the engine nudges once; idle again with still none, the step
   fails. Lines from the operator, answers to `ask_operator` and suite results go to the seat as today and
   change nothing in the loop.
2. At a checks node the engine pushes the run's new hub-made commits first (Plan 6's push), then
   judges the node's `ci` checks from GitHub for that head sha and its `rule` checks from the diff.
   A check that needs something outside the run (CI still running, the operator's go on a hard-rule file)
   is `wait`: it holds the step without burning a try and is re-read on the poll and the tick.
3. All pass → next node on `path`. Any fail → the node's `rules` decide, per the retry rule below:
   `fix → back to verify` resumes the same seat with the failure text. `review` findings route the
   same way (§6).
4. `gate` nodes: at home, **go/no-go is FLIGHT's call** when the plan check passed and the ticket has
   no `always_ask` label; otherwise it is an ask to CAPCOM with the brief. FLIGHT's go is recorded in
   Decided without you. **Before FLIGHT exists (parts 7a–7b)** a go/no-go auto-passes unless the
   ticket carries `always_ask`, and is recorded as "auto: no FLIGHT yet"; an ask is the engine's own
   Needs-you approval, answered by `go`/`no-go` to the seat.
5. **Push and draft PR are engine actions**, not seat tool calls: when a run reaches its `draft PR`
   node the engine pushes the branch (Plan 6's push: fast-forward, hub-made commits only, secret
   scan) and opens the draft PR; every later checks node pushes again first. The seat's `mc push`
   and `mc draft_pr` from Plan 6 become the functions the engine calls and leave the seat's
   allowlist. Because verify reads CI, which needs a pushed branch, the shipped templates put
   **draft PR after implement and before verify**; In review means "verify passed, PR open"; the
   YAML says so.

Retry, escalation, parking (spec §5, CAT RETRY_NOTE): tries 1 and 2 resume the same seat with the
failure; try 3 relaunches the seat as a fresh session on the same run and worktree with a stronger
model (`crew.escalation_model`, default opus); then the ticket **parks**: status Blocked, a Needs-you item with the last
failure, FLIGHT's Watch list entry. A retry that makes no progress (same failing tests and the same
diff hash as the previous try) stops early and parks. Budgets: a run past its template's token or
round budget parks with "over budget" (on the always-ask list). The per-repo 7-day quota stop uses the
existing account readings: at the threshold no new run starts and FLIGHT says so.

Stray changes: the commit tool refuses paths outside the seat's area (Plan 6 Task 8); the engine's
`rule` check re-reads the diff at verify and at the merge gate, so a stray that slipped past a commit
still blocks. A ticket whose work spans two writers' areas cannot be committed by either; before
FLIGHT it parks with "spans two areas; split it", and from 7c FLIGHT splits it into two tickets.

**Hard-rule files.** The spec's always-ask list names "hard-rule files" without listing them. For
this repo they are the files that confine or drive the crew: `apps/server/src/guard/**`,
`apps/server/src/mcp/**`, `apps/server/src/runtime/**`, `apps/server/src/engine/**` (this design),
`packages/core/src/guard.ts`, `packages/core/src/runtime.ts`, `loops/**`, `roles/**`, `CLAUDE.md`,
`.github/**`, `config.example.yaml`. They are listed under `hard_rules:` in the repo's `mc` block,
with these as the default. A PR that touches one is never auto-merged: the gate stops at "ready for
CAPCOM" with an approval ask, the operator merges, and §11's idle-time Update never applies a merge that
touched one; the operator presses Update for those. This closes the loop a seat could otherwise use to
loosen its own gates and have them go live unseen.

**Board fields and labels on day one.** Project #5 has Status today but no Priority or Size field,
and the repo has none of the template labels. Part 7a's setup action (spec §8a.2, the operator's one click)
creates the Priority and Size fields and the labels `type:feature`, `bug`, `chore`, `test`, `docs`,
`research`, plus area labels `area:server`, `area:web`, `area:core` mapped to globs in the `mc`
block (`areas: {"area:server": ["apps/server/**"], …}`). Focus matching uses the area labels, not
prose in the body. Existing open tickets are labelled once by the controller before 7a goes live;
after that FLIGHT's triage labels new ones. An unset Priority sorts after P2; an unset Size is
"incomplete" for promotion but a Ready ticket is still picked, with the template chosen by label and,
with no label, `feature` (its checks are the strictest).

## 6. Reviews: RETRO runs

A review is a run of kind `review` on the `review` template, started by the engine when a draft PR
reaches In review (and again after every fix round, on the new head sha). RETRO is read-only in
mode but needs a working copy: the hub checks out the PR branch into a **scratch worktree** that
RETRO may edit and run single-file tests in (mutation checks), but never commit from; the worktree
is deleted when the run ends. (Call: a third seat mode, `scratch`, = Edit/Write in its own worktree,
git writes denied, no PR. Marked in §14.)

RETRO's inputs are the ticket, the run's plan if the template has one, the diff as a file, and the
check output — not the author's chat (spec §2). Its brief asks for every finding at every severity,
`file:line` and a failure scenario each, and for mutation checks on the fixes: revert each in the
scratch copy and confirm a test fails. It reports with the `report_findings` tool: `[{severity:
Critical|Important|Minor, file, line, summary, scenario}]` plus a verdict for the two review checks
(spec, quality).

The engine, not RETRO, decides: Critical or Important → a `fix` step on the author's run with the
findings as its brief, then `verify` again, then a fresh review on the new sha (a review round);
Minor only → recorded on the run and listed in the PR body under "Minor findings (logged, not
looped)"; nothing → the review check passes. Review rounds count against the template's `rounds`.

Of the catalogue's four REVIEW_CHECKS, two gate in this phase (spec verdict, quality verdict). "Blast
radius" is fed by the hub: it lists the files that import each changed module (an import-graph grep,
no type analysis) and hands RETRO the list; RETRO's verdict covers them. "Pages it touches opened in
a real browser" cannot gate yet: RETRO has no browser or network. It is recorded as "not checked"
on INCO runs until a browser runner exists (a later phase), and the PR body says so. The catalogue's
`review` template ends in a `propose` gate for posting comments; findings here never post, so that
node is dropped from the shipped file. The `research` template needs a NETWORK seat this phase does
not add; research tickets are not picked, and FLIGHT's triage leaves a Watch entry ("no seat covers
research").

## 7. The merge gate and after

In a `merge` workspace (home) the engine merges when, **on the PR's current head sha**: verify passed;
the latest review is clean; CI is green (from the GitHub poll); the area/stray rule passes; the
branch **contains current `main`**; and the PR is still the run's own branch with only hub-made
commits (`run_commits`, Plan 6). Any push resets all six.

Behind `main`: branch protection is not available on this repo, so the engine enforces it. When
`main` moves, the engine merges `main` into the branch in the clone (an engine-made merge commit,
recorded in `run_commits`; Plan 6's push rule becomes "no merge commit unless it is in
`run_commits`"), pushes, and verify runs again on the new sha. A conflict becomes a `fix` step:
the engine leaves the conflicted files with their markers in the seat's worktree, the brief names
them, and the seat resolves and calls `mc commit`. The commit tool knows a merge is in progress
(`MERGE_HEAD` exists for that worktree): it diffs the index against **both** parents, allows a
path outside the seat's area only when the index matches `main`'s side of it exactly, refuses any
other out-of-area path as today, and commits with the merge's two parents. The push rule becomes
"no merge commit unless it is in `run_commits`". If the fix fails its tries the run parks like any
other. Then, in order: mark ready, merge (merge commit, never force), close the issue, move the
card to Done, delete the remote and local branch, remove the worktree, end the run, and let the seat
take its next ticket. Each step is an Activity row; a failure part-way parks the run with the step
name (never a half state the next tick cannot see).

In a `draft` workspace the gate stops at "ready for a human": the card goes to Ready for QA and the
PR stays a draft (spec §4.2).

## 8. FLIGHT

### 8.1 What it is

A seat with role `FLIGHT`, read-only mode, opus, session rotating after `flight.max_turns` (default
40) with a handoff brief FLIGHT writes and the hub stores. It never polls: the engine wakes it with
an event and a compact payload (CAT §4, spec §5). Wake events: a new or changed ticket in Backlog or
Refinement; a seat with an empty queue; a run parked, stalled or over budget; an `ask_flight` from a
seat; a message from the operator; the lock blocked by a stalled holder; a PR waiting on a person for more
than a day; a seat finished a ticket (to refill its queue); a daily tick for the Situation.

### 8.2 Tools

Read: `board` (cards with the overlay), `crew` (seats, runs, steps), `runs` (step records), `attention`
(the Needs-you list), `repo_rules`. Write, all recorded with a basis:

| tool | effect | approval |
|---|---|---|
| `assign {seat, issues[]}` | sets a seat's queue order | none, within focus and `pick_from` |
| `promote {issue, to, basis}` | Backlog → Ready or Refinement | none when `promote_backlog`; else an ask |
| `reprioritise {issue, priority, basis}` | Priority on the board | **ask** (spec §4.3) until Auto-approve |
| `answer {ask_id, text, basis}` | replies to a seat's `ask_flight` | none; recorded in Decided without you |
| `ask_operator {brief}` | a decision or approval for the operator | — |
| `draft {to, via, where, text}` | a draft for the operator to send | none; the operator posts |
| `watch {title, detail, next, next_at}` | Watch-list entry with a re-check time the hub runs | none |
| `situation {text}` | the Situation paragraph | none |
| `standing_orders {orders[]}` | The operator's redirects, as rules FLIGHT follows (§8.4) | none |
| `message {seat, text}` | a message to a seat (mid-turn or queued) | none |
| `raise {repo, title, body, labels}` | a new issue in Backlog | none at home; counts as a GitHub write (§12) |

FLIGHT never: stops a run (the operator's button, CAT §5.5), merges or marks ready (the engine), posts
comments (drafts only), changes templates or rules (a PR), or starts a new seat (an ask, spec §8a.3).

### 8.3 Triage (the `watch` loop)

Every 10 minutes, or on a board event, the engine runs the `watch` template: `poll` (hub: new or
changed tickets) → `triage` (FLIGHT: each ticket matched to a lane and a template) → `assign`. For a
Backlog ticket FLIGHT checks the repo's `needs`: complete → `promote` to Ready with a basis; incomplete
→ `promote` to Refinement and, for a ticket the operator wrote, an `ask_operator` brief with the missing
piece and FLIGHT's suggested wording; for another reporter, a `draft` comment. A Ready ticket with no
seat whose focus matches gets a Watch entry ("no seat covers `apps/mobile/**`").

### 8.4 Redirecting through FLIGHT

The operator talks to FLIGHT in the dock ("This week GUIDO-1 stays on the runtime; INCO-1 takes the HUD
polish first"). FLIGHT turns it into **standing orders**: short rules stored by the hub, shown on the
FLIGHT page, carried into every handoff, and applied by `assign` and `promote`. It re-plans the
queues, replies with what changed ("GUIDO-1: #A then #B; INCO-1: #C then #D; I will ask you
before changing Priority"), and raises asks for anything the order needs that is on the approval list
(a Priority change, a new seat). An order that conflicts with a repo rule is refused with the rule
named. Overturn (CAT §2.2.7) is a standing order too: "hold that point" to the seat, and the decision
marked overturned.

### 8.5 What FLIGHT decides, what it asks

Decides and records (Decided without you, with basis; Overturn available): agent questions it can
answer from the ticket, the code, the docs or a standing order; go/no-go within the rules; Backlog
promotion; queue order within focus; Watch entries; retry-or-park when the rule leaves a choice.

Asks CAPCOM, with the catalogue's brief (catch-up, why it came to you, what FLIGHT checked, options,
recommendation): the spec's always-ask list (unmerged-branch deletion; CI, workflows, branch
protection or hard-rule files; operator-gated escalations; milestone changes; over budget); a
Priority change; starting or stopping a seat; switching an account; a ticket labelled in
`always_ask`; and anything FLIGHT marks below its own confidence (tuning, not a blocker: "the
escalation rules and Overturn are the safety net", CAT §4).

## 9. Seats and queues

Each writer seat has a **focus** (its area globs plus optional labels) and a queue `{now, next[],
done[]}` (CAT §2.4.6). Slot limits stay: `max_seats` total, up to 4 per session, "no room" when free
memory ≤ 2 GB. Seats for this phase on the mission-control session: `guido-1` (writer,
`apps/server/**`, `packages/core/**`), `inco-1` (writer, `apps/web/**`), `retro-1` (review runs in
every session), `flight`. GUIDO-2/INCO-2 come when one writer per side is measurably the
bottleneck; areas must then be split so they never overlap, which is a Setup change the operator approves.

## 10. Mailbox, minimal

Threads between seats, FLIGHT and CAPCOM: `threads(id, kind seat|flight|capcom, participants)` and
`messages(thread_id, from, text, at, read_at)`. `ask_flight` and `ask_operator` create messages with
an `ask` payload; `@CAPCOM` in any message is parsed into a Needs-you item (spec §5). The dock chat
is the CAPCOM↔FLIGHT thread, live over SSE. A message to a seat that is not running is queued and
delivered at its next turn (CAT §2.4.4).

## 11. Hub updates without stopping work (#10)

Config gains `update: {auto: off|when_idle, cli: off|when_idle}`. With `when_idle`, the hub applies
Update (pull, build, restart) when main is ahead and **no run is mid-turn, no hub check is running,
the test lock is free, and no live loop is within 5 minutes of its next fire** (the collectors know
the fire times). Seats
resume on `--resume` as today. `cli: when_idle` does the same for `claude` (and later `codex`)
version bumps through the existing updater, with the same idle rule, and records the version in each
run. The Update button shows "queued · waiting for idle" when a run is mid-turn, and FLIGHT can say
"update when idle" from its tools. The hub still never restarts itself for any other reason.

## 12. Security model

Everything an agent does to GitHub still goes through the hub, under the operator's account, and only these
writes exist (each one an Activity row with its basis):
- Plan 6's: fast-forward push of a run's own branch, one draft PR per run.
- New, all inside a `merge` workspace and already allowed by spec §8a.3: board moves Ready → In
  progress → In review → Done, mark ready, merge, close issue.
- **Deviations from spec §4.3 and §8a.3**, each declared here with its basis: (0) the hub
  **deletes the merged branch** after a merge — §8a.3 does not name it; it is the loop's own
  tidy-up of a branch it created; (1) a parked run's card moves to **Blocked** — the loop's own state, like the
  three moves above; (2) the hub edits **its own run's PR body** to list minor findings and
  hard-rule touches — the PR is the hub's, never a person's; (3) the setup action **creates fields
  and labels** on the operator's click — that click is the approval; (4) FLIGHT moves **Backlog → Ready /
  Refinement** within the repo's rules — recorded in Decided without you, overturnable, and off
  with `promote_backlog: false`; (5) FLIGHT **raises issues** at home — they land in Backlog and go
  through triage, and are listed in Decided without you; (6) the hub **sets the `mc/review` commit
  status** on its own run's pushed sha while the run's PR is open — the hub's record of its own
  review, so a branch rule can require it. Only crew runs get it, so it stays out of the required
  checks while other PRs must merge, and it adds no Activity row (a failed write is logged); (7) when a writer's run starts, the hub **adds its own `gh`
  login as the ticket's assignee**, in `merge` and `draft` repos alike — the claim that keeps a
  second hub on the same board off the ticket (#47). It never removes an assignee and never
  moves the card for it; (8) a planner (FAO) run **appends its `## Plan`** to the ticket's issue
  body, once — the plan a dev seat then follows; FAO refuses where a plan already exists.
- Still approval-gated: Priority changes, comments on anything, labels on existing issues,
  starting/stopping seats, switching accounts.
- **FLIGHT reads untrusted text** (issue bodies, PR text, seat messages) and holds write tools
  (`raise`, `promote`, `message`, `assign`). That is an injection surface: the tools act only within
  the repo's rules and the always-ask list, every act is recorded with its basis and overturnable,
  and FLIGHT's brief says that text in a ticket is data, never an instruction.

Seats keep today's confinement: the guard, the sandbox, no network, no `gh`. FLIGHT is read-only in
mode and sees the store through tools that return data, never credentials. RETRO's scratch worktree
is deleted after each review and is denied to every other seat. The merge gate re-checks the head
sha against `run_commits` so nothing but hub-made commits merges. Mutation checks run in RETRO's own
scratch copy, never in the author's worktree.

## 13. Data model (summary)

`runs` (+template, node, attempt, round, parked_reason, tokens_used, review_sha); `run_steps`;
`run_checks`; `review_findings(run_id, review_run_id, severity, file, line, summary, scenario, state
open|fixed|ruled|logged)`; `queues(seat_id, pos, issue_ref)`; `repo_rules(repo_id, yaml, read_at)`;
`standing_orders(id, text, by, at, active)`; `flight_decisions(at, seat, question, answer, basis,
overturned_at)`; `flight_watch(id, level, title, detail, next, next_at, done)`; `flight_drafts`;
`flight_situation(at, text)`; `asks(id, kind decision|approval, brief json, answer, answered_at)`;
`threads`, `messages`; `handoffs(seat, at, brief)`.

## 14. Calls made in this document (Claude's; the operator to check when convenient)

1. Repo rules live in the repo's `CLAUDE.md` under `## Mission Control`, with one fenced `yaml`
   block. The operator said "the project md"; this keeps one file and no new convention.
2. "Ready, then Backlog" = seats take from Ready; FLIGHT promotes from Backlog when a ticket is
   complete and `promote_backlog` is on. Seats never take raw Backlog tickets.
3. go/no-go at home is FLIGHT's call unless `always_ask` or the spec's list applies.
4. A third seat mode, `scratch`, for RETRO review runs (edit its own worktree, no git writes).
5. Minor review findings are logged in the PR body, not looped (CAT REVIEW_CHECKS).
6. Escalation model on try 3 defaults to opus; FLIGHT is opus; implementation seats stay sonnet.
7. Idle-time Update rules (§11): mid-turn, lock, and a 5-minute margin before a loop fire.
8. Seats for this phase: GUIDO-1, INCO-1, RETRO-1, FLIGHT. More writers after the loop runs.
9. Templates are changed by PR, not in Setup; `tiger-team` is defined but not run.
10. FLIGHT may raise issues at home without asking; they land in Backlog and go through triage.
11. Verify reads the repo's CI on the pushed sha; the hub runs no worktree code. Seats keep their
    own suite runs through Plan 6's guard and lock. A hub-owned sandboxed runner is later work.
12. Hard-rule files are listed (§5) and never auto-merge or auto-Update.
13. Push and draft PR are engine actions at the `draft PR` node; the shipped templates put that node
    after implement and before verify, since verify reads CI on the pushed branch.
14. Before FLIGHT, go/no-go auto-passes unless the ticket carries `always_ask`; asks are the
    engine's own Needs-you approvals, answered by `go`/`no-go` to the seat.
15. A branch must contain current `main` to merge; the engine updates it with a recorded merge
    commit; conflicts are a fix step.
16. The browser check is recorded, not gated, until a browser runner exists; blast radius is an
    import-graph list the hub supplies; `research` tickets are not picked this phase.
17. Day-one board setup: Priority and Size fields plus type and area labels created by the setup
    action; existing tickets labelled once by hand.

## 15. Left to the builder

- Exact YAML schema and validator messages; the `loops/*.yaml` files.
- The engine's persistence and crash recovery (a run must resume at the same node after an Update).
- How "no existing test weakened, skipped or deleted" is detected from a diff (removed `it(`/`test(`,
  added `.skip`/`.only`/`xit`, deleted test files), and what counts as a false positive.
- The diff hash used for "no progress".
- RETRO's brief and the `report_findings`/`report_evidence` tool schemas.
- FLIGHT's role file, the event payload shapes, the handoff brief format, and the confidence rule.
- SSE topics and HUD wiring for each surface in CAT §2.1.2 (Loop step), §2.2 (FLIGHT page), §2.4.5
  (Agent Loop panel), §2.3.2 (Board overlay), §2.9 (Item panel).
- The update policy's loop-fire margin source and the CLI updater integration.

## 16. Order of work

Each part ships on its own and removes a piece of the controller's bridging. All of it starts after
Plan 6 merges: the commit tool, `run_commits`, push and draft PR are Plan 6 Tasks 8–11.
1. **7a The first loop**: one implicit loop per run (working → push and draft PR → CI → In review →
   merged → next ticket, with parking), reconciled each tick from stored facts rather than driven by
   events; the board setup action (fields, labels); board moves In progress/In review/Blocked; seat
   queues filled by rule (Priority, focus); the loop phase in the HUD. Templates, per-node checks,
   gates and escalation (the rest of this section's engine) follow once it runs, as **7a+**,
   reconciled the same way. FLIGHT not yet: assignment is the rule in §4.
2. **7b Review and merge**: RETRO review runs in scratch worktrees, `report_findings`, fix rounds, the
   merge gate and the after-merge sequence, Agent Loop panel. After 7b the controller is out of the
   loop for the mission-control repo.
3. **7c FLIGHT**: the seat, wake events, tools, triage/promotion, standing orders and redirect,
   Decided without you and Overturn, asks with briefs and the Item panel, the mailbox, the dock chat.
4. **7d Update policy and polish**: §11, Situation and Watch re-checks, Setup › Loops read-only view,
   Telemetry's loop-derived tiles.
5. **Later: the hub's sandboxed check runner**, for repos without CI and for the base-commit proof
   without RETRO (the design's review rounds were not carried into this repo).
