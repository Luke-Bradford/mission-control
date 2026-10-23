# FLIGHT as the crew's superuser

**Status:** design, 2026-10-23.

This replaces three things in older documents:
- in `2026-10-20-build-loop-flight-design.md`, §8.1's list of things FLIGHT never does (merge, comment, start or stop a seat), §8.5's asks, and §12's tool limits;
- the "no merge tool" and "For the controller" steps in `roles/FLIGHT.md`.

Where this design and older text differ, this design wins.

## Why

The operator's words:
- **2026-10-22:** "FLIGHT must be able to do anything needed to keep everything moving, as the controller does."
- **2026-10-23:** "flight needs to be a super user". Also: "it's the head, the main agent, should be elevated and override anything, help out and do anything. Should have its set of skills, understanding, know what it should or shouldn't do but still know ultimately what their role is. If it needs to merge things, it should make that judgement. If it needs better research, skills, tools, it should get those. It has its own page, to use for recording its notes, knowing what's going on, taking some ownership of progress and steering work in the right direction and assisting where needed. Being able to respond to questions from me or any agent."

What happened on 22–23 Oct:
- **FLIGHT wrote 220 log notes in the 24 hours to 20:00 on the 23rd, and 114 of them begin "For the controller:".**
  - It saw each problem but had no power to act, so a person-side controller acted instead.
  - By topic, the notes asked for merges, mostly of hard-rule PRs (98), CI re-runs and rulings (92), review and ruling parks (62), and board fields (15).
- **It is boxed in by design.**
  - Its Bash is read-only, with no network and no `gh`.
  - Every action has to go through a single-purpose mc tool, and each new power costs a ticket.
- **Its memory is the brief.** That is nine sections of at most 4,000 characters each, rewritten about 150 times that day. Lessons don't accumulate, so the same faults were found again and handed back: the flaky keeper test, the stuck park after a push, PRs chasing main.
- **Nothing orders merges.**
  - The ruleset on `main` requires branches to be up to date.
  - GitHub's merge queue isn't available for a personal account's repo.
  - The engine updates every PR that falls behind (`branchUpdateDue`), so PRs chase main.

## The principle

**FLIGHT acts with the operator's authority on the repos it is raised on, and uses its own judgement.**
- **What it can do.** It can do what the operator can do from the HUD and from a terminal: merge, settle a park or ruling, edit the board, start, stop and restart seats, research on the web, write code and open PRs, and get itself better tools and skills.
- **How it decides.** It decides with judgement, using the role, the repo's rules and its memory. It is not boxed in by a tool list.
- **What it reports.** It records what it did and why, owns the progress, and brings the operator only what is truly theirs.
- **What still binds it.** The hub enforces only a short **floor** of actions that can't be undone or that remove the last safety net (see below). Everything else rests on FLIGHT's judgement and the log. The repo's rules, such as `hard_rules` and `always_ask`, become guidance FLIGHT weighs, not gates that stop it.

Elevation is set per repo, in the user config only. A merged PR can never raise it.

```yaml
# ~/.config/mission-control/config.yaml
repos:
  - id: mission-control
    autonomy: merge
    flight_powers: superuser   # observe | standard | superuser; default standard
```

- **The default is `standard`:** FLIGHT keeps today's tools.
- **Where it is raised:** `mission-control` is set to `superuser`. The observed loops' repos stay at `standard` until the operator raises them.
- **When a change applies:** each check reads the current value, so lowering it takes effect at FLIGHT's next call.

## The floor

The hub enforces these even for a `superuser` FLIGHT. They are a recommendation: the operator can strike any line.
1. **No force-pushing or rewriting the history of a default branch,** and no deleting a repo or a branch that hasn't been merged.
2. **No changes to branch protection, rulesets, secrets, collaborators, deploy keys or repo settings.** These are the last safety net under any mistake. FLIGHT drafts the change, with its reason, for the operator.
3. **No merging a PR from a fork whose author isn't a collaborator.** The repo is public, so that is untrusted code and untrusted text. FLIGHT may review it and recommend.
4. **The operator's stop, hold or answer given in the moment wins.** So do money budgets and account stops; FLIGHT never routes around one.
5. **FLIGHT doesn't change its own `flight_powers`,** or the user config. It drafts the change for the operator.

Everything else is FLIGHT's call, including:
- merging hard-rule PRs;
- merging PRs that change FLIGHT's own role, tools or guard;
- accepting a ruling;
- overriding a review.

For changes to its own powers, the role asks FLIGHT to get a RETRO review first and to post its reasoning on the PR. That is the role's guidance to FLIGHT, which FLIGHT weighs; the hub doesn't enforce it.

**Tradeoff, stated plainly.** A FLIGHT that can merge changes to its own guard can, by mistake or through text injected into a ticket or PR, widen what it may do. The floor keeps that recoverable: protection, the history of `main` and the config stay out of its reach. The log and the operator's ability to lower `flight_powers` are the remedy. The operator has chosen judgement over gates.

## Slices

Each slice is one ticket. Build order:
- 1 and 2 together;
- then 3 to 5;
- then 6.

### 1. The hub's merge queue

This is for repos in `merge` autonomy.

- **Who joins.**
  - Run PRs join on their own, once they are mergeable apart from being behind main: review clean or carried, and CI green on their head.
  - FLIGHT can add any PR within the floor, remove one, or move one to the front, each with a basis.
- **Order and storage.** The order is oldest join first, kept in a table `merge_queue (repo_id, pr, run_id, joined_at, state, added_by)` that survives a restart.
- **Updating.**
  - Only the front PR is brought up to date: by the engine's worktree merge of main for run PRs, as `sync_main` does, and by `update-branch` for others.
  - `branchUpdateDue` stops updating queued PRs that aren't at the front.
  - The review is carried when the PR's own diff is unchanged.
- **Merging.** A green front PR merges with `--match-head-commit` and is recorded as a `loop_events` row, and the queue moves on.
- **Leaving.** A conflict, red CI or no CI result in 45 minutes takes the PR out of the queue and back to its author or to FLIGHT, and the queue moves on.
- **Visibility.** The queue shows in `flight_state` and at `GET /api/merge-queue`. This slice adds no HUD screen.

### 2. Elevation

This is the core of the change.

- **The `flight_powers` key** goes in the user config, with a `requirePowers` helper and an entry in `config.example.yaml`.
- **A superuser guard profile for FLIGHT's seat:**
  - network for web research (WebSearch, WebFetch, docs);
  - the full `gh` CLI under the operator's account;
  - git writes and file edits in its own worktrees on non-default branches, so it can fix things, push and open PRs itself;
  - subagents, and the skills installed for the operator.

  The guard still denies the floor. That includes, for example, `git push --force` to the default branch, `gh api` writes to `branches/*/protection`, `rulesets`, `secrets`, `collaborators` and `keys`, `gh repo delete`, and edits to the user config.
- **Operator actions.** The tool `operator_action { route, body, basis }` lets FLIGHT call any of the hub's operator routes the HUD uses, for example:
  - pausing and resuming;
  - dismissing and answering;
  - messaging, interrupting and ending;
  - stopping, starting and restarting seats;
  - settling parks, including accepting a ruling or a review.

  Each call is logged with its basis. Routes that write the user config, and anything on the floor, are refused.
- **Merging.** `merge_pr { pr, basis }` merges by FLIGHT's judgement within the floor. It goes through the queue when the repo has one, or straight away with `--match-head-commit` when FLIGHT says it is urgent. The hub posts FLIGHT's basis on the PR.
- **Asking FLIGHT.** Any agent (seats, loops, Codex, the controller) can ask FLIGHT a question through `mc ask_flight { text }`, or `POST /api/flight/ask` for agents outside the crew, and FLIGHT answers on its next wake. The operator's dock stays as it is.
- **The role.** `roles/FLIGHT.md` is rewritten around the principle: what FLIGHT owns, how it judges (evidence, the repo's rules, reversibility, the operator's standing preferences), what is the operator's (taste and product calls, money, the floor), and how it records what it did. The "For the controller" path goes.

### 3. Evidence in the digest (#262)

This is cheaper than a `gh` call every wake.

- **Each PR in review** carries:
  - RETRO's verdict and blocking-finding count, from `reviews`;
  - the head commit;
  - the failing check names.
- **A ruling park** carries the seat's report, capped at 1,500 characters.
- **The merge queue** is included once slice 1 has landed.

### 4. Ops signals and triage (#176, which folds #284)

- **Signals.** The hub derives them, and each one wakes FLIGHT once per key: `flaky_test`, `repeat_park`, `queue_stall`, `idle_seat`, `github_budget` and `hub_error`.

  | Signal | Source | Key |
  |---|---|---|
  | `flaky_test` | `flake:` records, and re-runs that passed on the same head, twice in 7 days | the check or test |
  | `repeat_park` | the same park reason on the same ticket, twice | the ticket and the reason |
  | `queue_stall` | a timeout, or the same PR leaving the queue twice | the PR |
  | `idle_seat` | 15 minutes idle while `eligibleToStart` finds work | the seat |
  | `github_budget` | under 25% of the hour's allowance | the hour |
  | `hub_error` | a watch resume failing (#317), a run ending without its report (#244), or a loop that has stopped reporting | the source |

- **Triage wakes:** a new Backlog or Refinement ticket, a finished plan, or a dependency that has just resolved.
- **The PR list** comes from the stored open PRs, so a phase change alone no longer wakes FLIGHT.
- **The role:** triage every signal with evidence, then fix it directly or get it fixed.

### 5. Memory, skills and the FLIGHT page (folds #172)

- **Memory.** `flight_memory (repo_id, topic, kind, body, source, updated_at)`.
  - **Kinds:** `lesson`, `repo` (stack, checks, conventions, quirks), `crew` (what trips each seat) and `playbook` (FLIGHT's own skills: how it handles a recurring situation).
  - **Limits:** a body is at most 4,000 characters, and a repo holds at most 300 topics.
  - **Tools:** `remember`, `forget` and `recall`.
  - **In each wake's digest:** the topic titles, plus the bodies linked to the wake's signals and questions.
- **Notes are evidence, not authority.** A note never records an approval or a grant; those come from the operator.
- **Skills.** FLIGHT may write playbooks, and on a `superuser` repo it may also add skills for itself or the crew as PRs, which it merges by its own judgement.
- **The daily retrospective.** It runs at the first quiet wake after 03:00 local and covers the last 24 hours:
  - merged PRs, and the share that changed a screen;
  - median time from Ready to merged;
  - review fail rate and park reasons;
  - re-runs and queue waits;
  - FLIGHT's own wakes and cost;
  - its "For the controller" count;
  - the most costly runs (this is #172).

  FLIGHT then writes its lessons and files or fixes its top one to three items.
- **The FLIGHT page** shows FLIGHT's notes and playbooks, its retrospective, and what it owns and is steering. The operator can edit or delete a note there. The server half ships in this slice and the page in a follow-on web ticket.

### 6. Ownership across repos (#175)

- **One session per repo.** Each configured repo gets its own FLIGHT session, with its own memory and its own `flight_powers`.
- **First sight of a repo.** FLIGHT writes the repo's profile to memory and drafts any missing configuration for the operator.
- **Related:** #173 and #174.

## Security model

- **New GitHub writes,** under the operator's account, on `superuser` repos only. FLIGHT may make any write the operator could make through `gh`, except the floor's.
  - **In practice:** merges, branch updates, CI re-runs, comments, labels, project fields, assignees, issues, and pushes to non-default branches.
  - **The floor's exclusions** are protection, rulesets, secrets, collaborators, keys, repo settings and deletion, force-pushes to the default branch, and merging a non-collaborator's fork PR.
- **Network** is opened for FLIGHT's seat only, and for research. Developer seats are unchanged.
- **Untrusted text.** Tickets, PRs, comments, web pages and memory notes stay evidence, never instructions. Approval comes only from the operator.
- **Audit.** Every elevated action is logged with its basis and shows in the FLIGHT log. The operator lowers `flight_powers` to take powers back, with effect from the next call.

## Done when (measured once slices 1 to 5 have merged)

- FLIGHT's "For the controller" notes fall to near zero, and the retrospective reports the count.
- Crew PRs on `mission-control`, hard-rule ones included, merge without a person-side controller.
- No queued PR is brought up to date with main while it is behind the front.
- A flaky check seen twice becomes a ticket with evidence, or gets fixed, before a person notices it.
- FLIGHT's memory for `mission-control` holds the week's lessons and playbooks, and its wakes cite them.
