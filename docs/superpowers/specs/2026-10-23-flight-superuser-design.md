# FLIGHT as the crew's superuser

**Status:** design, 2026-10-23.

This changes four earlier texts, as set out below:
- §8.1 of `2026-10-20-build-loop-flight-design.md` (what FLIGHT never does);
- §8.2 and §8.5 of the same spec (its tools and its asks);
- the "no merge tool" and "For the controller" steps in `roles/FLIGHT.md`;
- the hard-rule merge line in `CLAUDE.md`.

§8b.1 of that spec (crew isolation from the operator's environment) still stands. Where this design and older text differ, this design wins.

## Why

The operator's words:
- **2026-10-22:** "FLIGHT must be able to do anything needed to keep everything moving, as the controller does."
- **2026-10-23:** "flight needs to be a super user"
- **Also 2026-10-23:** "it's the head, the main agent, should be elevated and override anything, help out and do anything … If it needs to merge things, it should make that judgement. If it needs better research, skills, tools, it should get those. It has its own page, to use for recording its notes … taking some ownership of progress and steering work … Being able to respond to questions from me or any agent."

The evidence from 22–23 Oct:
- **FLIGHT handed most of its work to the controller.** In the 24 hours to 20:00 on 23 Oct it logged 220 notes, and 114 of them begin "For the controller:". By topic: merges, mostly of hard-rule PRs (98); CI re-runs and rulings (92); review and ruling parks (62); board fields (15).
- **Its memory doesn't accumulate.** The brief has nine sections, at most 4,000 characters each, and was rewritten about 150 times a day. So known faults keep being found again.
- **Nothing orders merges.** The `main` ruleset requires branches to be up to date, there is no GitHub merge queue on a personal account, and the engine updates every PR that falls behind. So PRs chase main.

## The principle

FLIGHT acts with the operator's authority and its own judgement on the repos it is raised on.
- **Its judgement covers everything its tools reach,** including merges (hard-rule PRs and changes to its own powers too), accepting a ruling or a review, board fields and clearing items.
- **Its powers are hub tools, not a general shell.** Each tool covers a whole kind of work FLIGHT has needed, is pinned to a repo FLIGHT is raised on, and logs a basis. The hub enforces a short **floor**. FLIGHT's Bash keeps its sandbox: no network, no credentials, no writes. A general instrument, such as raw `gh`, any HUD route, or the operator's skills, can't be fenced reliably, so FLIGHT doesn't get one.
- **When FLIGHT lacks a power, it names it.** A "For the controller" note now means a missing power. The retrospective counts these notes and files each gap as a ticket for a new tool.
- **Code is written by the crew.** FLIGHT gets code changed by filing a ticket and starting a writer seat. It doesn't write code itself.
- **Questions reach FLIGHT through what exists.** The operator uses the dock. Seats use seat questions (`answer_question`). Loops' escalations reach FLIGHT as Needs-you items it briefs.

Elevation is set per repo, in the user config only:

```yaml
# ~/.config/mission-control/config.yaml
repos:
  - id: mission-control
    autonomy: merge
    flight_powers: superuser   # standard | superuser; default standard
```

- **Where it can be set.** No repo's `mc:` block can raise it, and `POST /api/repos` doesn't accept it.
- **When a change applies.** It reloads live, without a restart. FLIGHT's seat restarts when the value changes, and the guard checks it on every tool call.
- **Where it is raised.** It is set to `superuser` on `mission-control` only, and only once the merge ticket (#457) has landed, so hard-rule PRs are never stranded. The observed loops' repos stay `standard`.

## The floor

The hub enforces these even for a `superuser` FLIGHT. They are a recommendation; the operator can strike any line.
1. **The default branch.** No force-push, history rewrite or direct push to it. No deleting a repo, or a branch that hasn't been merged.
2. **The safety net.** No changes to branch protection, rulesets, secrets, collaborators, keys, repo settings or the CI workflow. That means FLIGHT doesn't merge a PR that touches `.github/workflows/**`; it gives the operator its recommendation instead.
3. **Untrusted code.** No merging a PR from a fork whose author isn't a collaborator, and no approving a fork's workflow runs.
4. **The operator's decisions.** An operator's pause, stop, hold or answer wins. So do money budgets and account stops. Each tool names the record it checks: seat state `stopped` versus `error`, budget and account parks, and the operator's holds. Away mode joins this list with #340.
5. **Its own powers.** FLIGHT can't change `flight_powers`, the user config, or anything the operator approves.
6. **Going live.**
   - **Auto-Update is an allowlist.** It applies only ranges whose every path is under `apps/web/src/**`, `apps/web/public/**`, `apps/web/index.html` or `docs/**`.
   - **Everything else waits:** server, packages, roles, any `package.json`, lockfiles, workspace and npm config, and build config. The operator, or the controller session on this repo, runs that Update after reading the held range, never FLIGHT. While a range is held, later web-only commits wait behind it.
   - **The check runs inside `update()` after its own fetch,** and it pulls exactly the SHA it checked.
7. **The repo's own rules.** On a `superuser` repo, FLIGHT never clears a PR that changes the `## Mission Control` block in `CLAUDE.md` or `.github/workflows/**`. That block is read live at `origin/HEAD`, so a merge alone would change the rules. The engine enforces this at its merge step, from a fixed list in code. The effective hard-rule list there is the repo's list plus `DEFAULT_HARD_RULES`.

**Tradeoff, stated plainly.** FLIGHT can merge changes to its own guard and tools. By mistake, or through text injected into a ticket or PR, it could widen what it may do. That change only goes live when the operator or the controller session runs Update, and FLIGHT can't clear a change to the repo's rules or CI. Protection, the history of `main`, CI and the config stay out of its reach.

## Slices

Each slice is one ticket, with `Depends on` lines enforcing this order:
1. #262 and #198 first.
2. Then #449.
3. Then the merge, board and research tickets.
4. Then #176 and #450.

### #262: evidence in the digest (S; in progress)

For each PR in review, the digest carries RETRO's verdict, the blocking-finding count, the head and the failing check names. A ruling park carries the seat's report.

### #198: powers foundation (M)

- **The `flight_powers` key.** Add it, with a `requirePowers` helper, live reload, a FLIGHT seat restart when it changes, and a guard check per call (`GuardContext.repo`).
- **The fixed list for auto-Update.** An auto-only check in `createAutoUpdate`. A manual Update is unaffected. When the check skips a range, it raises a Needs-you item.
- **The role and repo rules.** Rewrite `roles/FLIGHT.md` around the principle. Change `CLAUDE.md`'s hard-rule merge line to "on a `superuser` repo, FLIGHT merges by its judgement". The operator merges these, since they are hard-rule files.
- **The hard-rule merger setting.** Reconcile `hard_rules_by` (`engine/rules.ts`): on a `superuser` repo the merger is FLIGHT.

### #449: the merge queue (L; replan after this spec merges; no dependency)

- **What joins.** Run PRs only, per hub. Run PRs join once their review is clean (or carried, or accepted) and CI is green.
- **Merge order.** A "queue front" fact is required in `gateView.passes`, so nothing merges out of order. `sync_main` is refused for queued PRs that aren't at the front. A PR that left the queue rejoins only on a new head, or when FLIGHT re-adds it.
- **Bringing the front up to date.** Only the front PR is brought up to date, by the engine's worktree merge of main. `branchUpdateDue` returns null for queued PRs behind the front.
- **Leaving the queue.** A PR leaves on a conflict, on red CI, or after 45 minutes at the front without merging. The queue then moves on.
- **Lanes.** It refuses other-lane PRs. A merge to main by another hub or a person just moves main.

### FLIGHT merges and settles (new; depends on #198 and #449)

- **The hard-rule join.** On a `superuser` repo, hard-rule run PRs join the queue and wait `awaiting-flight` at the front, and `hard_rules_by` resolves to FLIGHT. This ticket brings that in, so nothing is stranded before `merge_pr` exists.
- **`merge_pr { pr, urgent?, basis }`.** It clears a run PR in FLIGHT's lane at the front of the queue, hard-rule included, within the floor. Its clearance carries across a main merge when the PR's own diff is unchanged. The hub posts the basis on the PR, after `scanSecrets` and the notifier check. "Urgent" means FLIGHT moves the PR to the front.
- **`settle_park { runId, action, basis }`.** The actions are:
  - `lift`: a stuck park whose head descends from the push;
  - `rereview`: a fresh RETRO review;
  - `accept`: accepts a ruling or a review by FLIGHT's judgement, through the existing waiver path (`mc/review` is set to "waived"). It is refused for a blocked RETRO review of floor-enforcing code, so RETRO stays the independent check on FLIGHT's own powers;
  - `rework`: sends the findings back to the seat.
- **`rerun_ci { pr, basis }`.** Re-runs a run PR's failed jobs, at most twice per head, 4 an hour.

### FLIGHT runs the board and Needs you (new; depends on #198)

- **`edit_card { issue, size?, priority?, lane?, assignees?, labels?, basis }`.** Assignees are limited to configured logins. On a `superuser` repo, priority swaps skip #402's approval. Status moves stay with `promote`.
- **`dismiss_item { key, basis }`.** It clears any item that isn't operator-owned, plus items whose subject has resolved. It never clears guard acks, budget or account items, approvals, or the auto-Update hold.
- **`restart_seat { seat, basis }`.** It restarts a crew seat stopped on an error. It never restarts a seat the operator, an account or a budget stopped, and never FLIGHT itself or an observed loop.

### FLIGHT reads GitHub and the web (new; depends on #198 and #203)

- **`gh_read { path }`.** GET only, on fixed path templates, for the repo FLIGHT is raised on. It runs from an empty folder with its own `GH_CONFIG_DIR`. The output goes through `scanSecrets`, and it is capped per hour.
- **WebFetch and WebSearch** are allowed for a `superuser` FLIGHT seat.
  - Loopback and private address ranges are denied, and a test proves it.
  - It depends on #203, so that nothing outside the deny list in the home folder is readable first.
  - The CLI's subagent tool name is checked by experiment before it is granted.
- **Untrusted text is marked.** Text written by people who aren't collaborators is marked as such in `read_ticket` and in the digest. The role doesn't act on it without the operator.

### #176: ops signals and triage (depends on #449 and #198)

- **The signals:** `flaky_test`, `repeat_park`, `queue_stall`, `idle_seat`, `github_budget` and `hub_error`. Each wakes FLIGHT once per key.
- **Triage wakes:** new Backlog tickets, finished plans and resolved dependencies.
- **No wake on a phase change:** the PR list doesn't change when only a phase changes.

### #450: memory and the retrospective (depends on #449)

- **The memory store:** a store per repo of lessons, the repo profile, the crew and playbooks.
  - Notes are evidence, never authority.
  - The operator can edit and delete them.
- **The retrospective:** the hub schedules a wake for it once a day.
- **The FLIGHT page panel** is a follow-on web ticket.

### Later

- **The hub's loopback API needs an operator token on its mutating routes.** Today the HUD bundle and anything on the machine can call them. This is a security follow-up, and it comes before any power is widened further.
- **Repo skills as a readable index** (#174). The operator's own skills and plugins never reach the crew (§8b.1).
- **Ownership across repos** (#175).
- **Away mode overriding these tools** (#340).

## Security model

- **New GitHub writes,** all under the operator's account, only on `superuser` repos, and only through typed hub tools that log a basis:
  - merges of run PRs in FLIGHT's lane;
  - the engine's worktree merges of main (already made today, now in order);
  - CI re-runs (capped);
  - PR comments carrying FLIGHT's basis, after secret and notifier checks;
  - project fields, labels and configured-login assignees.
- **New reads:** `gh_read` (GET only, fixed templates, one repo, capped), and WebFetch and WebSearch for FLIGHT's seat, with private ranges denied.
- **No general instruments.** FLIGHT's Bash keeps its sandbox. FLIGHT has no raw `gh`, no general HUD-route tool, none of the operator's skills or plugins, and no code writing.
- **The floor** is enforced in the hub's tools and the guard. Floors 6 and 7 keep any merged change to the hub's code from going live without the operator or the controller session, and keep FLIGHT from changing the repo's rules or CI.
- **Audit.** Every elevated call is logged with its basis. Lowering `flight_powers` takes effect at the next call and restarts FLIGHT's seat.

## Done when (measured once these slices have merged)

- FLIGHT's "For the controller" notes fall to near zero, and the retrospective reports the count.
- Crew PRs on `mission-control`, hard-rule ones included, merge without a person-side controller. Hub-code Updates are still run by the operator or the controller session.
- No queued PR is brought up to date with main while it is behind the front.
- A flaky check seen twice becomes a ticket with evidence, or gets fixed, before a person notices it.
- FLIGHT's memory holds the week's lessons, and its wakes cite them.
