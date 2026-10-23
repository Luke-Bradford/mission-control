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
- **FLIGHT handed most of its work to the controller.** In the 24 hours to 20:00 on 23 Oct it logged 220 notes, and 114 of them begin "For the controller:". Counted by keyword across all 220 notes, where one note can match several keywords: merge (98, many of them hard-rule merges), CI or checks (92), review (62), labels and lanes (15).
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
5. **Its own powers.** FLIGHT can't change `flight_powers`, the user config, or anything the operator approves. The one exception is #402's priority approval on `superuser` repos (#458).
6. **Going live.**
   - **Auto-Update is an allowlist.** It applies only ranges whose every path is under `apps/web/src/**`, `apps/web/public/**`, `apps/web/index.html` or `docs/**`.
   - **Everything else waits:** server, packages, roles, any `package.json`, lockfiles, workspace and npm config, and build config. The operator, or the controller session on this repo, runs that Update after reading the held range, never FLIGHT. While a range is held, later web-only commits wait behind it.
   - **The check runs inside `update()` after its own fetch,** and it pulls exactly the SHA it checked.
7. **The repo's own rules.** On a `superuser` repo, FLIGHT never clears a PR that changes the `## Mission Control` block in `CLAUDE.md` or `.github/workflows/**`. That block is read live at `origin/HEAD`, so a merge alone would change the rules. The engine enforces this at its merge step, from a fixed list in code. The effective hard-rule list there is the repo's list plus `DEFAULT_HARD_RULES`.

**Tradeoff, stated plainly.** FLIGHT can merge changes to its own guard and tools. By mistake, or through text injected into a ticket or PR, it could widen what it may do. That change only goes live when the operator or the controller session runs Update, and FLIGHT can't clear a change to the repo's rules or CI. Protection, the history of `main`, CI and the config stay out of its reach.

## Slices

Each slice is one ticket. Order:
1. #262 and #198 start first.
2. #449 has no dependency, and its plan orders it.
3. #457 (merges and settles) depends on #198 and #449.
4. #458 (board) depends on #198.
5. #459 (research) depends on #198 and on #203's home-read build tickets.
6. #176 depends on #198 and #449.
7. #450 depends on #176.

### #262: evidence in the digest (S; in progress)

- **For each PR in review,** the digest carries RETRO's verdict, the blocking-finding count, the head and the failing check names.
- **A ruling park** carries the seat's report.

### #198: the powers foundation (M)

- **The `flight_powers` key.**
  - It comes with a `requirePowers` helper.
  - It reloads live: `settle()` in `crew-apply.ts` copies each repo's value.
  - FLIGHT's seat restarts when the value changes.
  - A `flightPowers` field on the guard context is checked on every call.
- **The auto-Update allowlist (floor 6).**
  - The check runs inside `update()`, after its own fetch, behind `{ auto: true }`.
  - It pulls exactly the SHA it checked (`merge --ff-only <sha>`), and refuses if `origin/main` moved after the check.
  - A held range raises a Needs-you item that lists the held commits and their paths.
  - A manual Update is unaffected.
- **Floor 7 at the engine's merge step.** A fixed list in code. The effective hard-rule list is the repo's list plus `DEFAULT_HARD_RULES`. `update.ts`, `config.ts` and `crew-apply.ts` are added to `DEFAULT_HARD_RULES` and to `CLAUDE.md`'s block.
- **The role rewrite** covers only what has landed: the principle, the floor, code written by the crew, and naming missing powers. Each tool ticket adds its own lines.

### #449: the merge queue (L; no dependency)

- **What joins.** Run PRs in this hub's lane, once their review is clean or carried and CI is green. Accepted heads are admitted from #457.
- **Merge order.**
  - A "queue front" fact is required in `gateView.passes`.
  - `sync_main` is refused for queued PRs that aren't at the front.
  - A PR that left the queue rejoins only on a new head.
- **Bringing the front up to date.** Only the front PR is brought up to date, by the engine's worktree merge of main. `branchUpdateDue` returns null for queued PRs behind the front.
- **Leaving the queue.** A PR leaves on a conflict, on red CI, or after 45 minutes at the front without merging. The queue then moves on.
- **Main moving underneath.** A merge to main by another hub or a person just moves main.

### #457: FLIGHT merges and settles (M; depends on #198 and #449)

- **The hard-rule join.**
  - On a `superuser` repo, hard-rule run PRs join the queue. At the front they wait `awaiting-flight`, which is a wake fact for FLIGHT.
  - `hard_rules_by` resolves to FLIGHT.
  - `CLAUDE.md`'s hard-rule merge line changes in this PR.
  - `mission-control` is raised to `superuser` only after this merges.
- **`merge_pr { pr, urgent?, basis }`.**
  - It clears an `awaiting-flight` run PR in FLIGHT's lane.
  - `urgent` moves the PR to the front, and the previous front PR goes second.
  - The clearance carries across a main merge when the PR's own diff is unchanged.
  - It refuses floors 2, 3, 4 and 7. Floor 4 is checked against seat state `stopped` versus `error`, park kinds and operator holds.
  - The hub posts the basis after `scanSecrets` and the notifier check.
- **`settle_park { runId, action, basis }`.** The actions are:
  - `lift`: a stuck park whose head descends from the push;
  - `rereview`: a fresh RETRO review;
  - `accept`: accepts a ruling or a review through the existing waiver path (`reviewWaivedSha`; `mc/review` is set to "waived"), and the queue admits the accepted head. It is refused for a blocked RETRO review of the hard-rule files that enforce the floor: `apps/server/src/{guard,flight,mcp,engine}/**`, `update.ts`, `config.ts`, `crew-apply.ts`, `apps/server/src/runtime/**`, and `packages/core/src/{guard,flight,runtime,loop,repo-rules}.ts`, so RETRO stays the independent check on FLIGHT's own powers;
  - `rework`: sends the findings to the seat.
- **`rerun_ci { pr, basis }`.** Re-runs a run PR's failed jobs, at most twice per head, and 4 an hour shared with `accept_ruling`.
- **Untrusted authors.** `read_ticket` and the digest mark text written by people who aren't collaborators, from a cached `GET collaborators/{login}/permission`. The role doesn't act on that text without the operator.

### #458: FLIGHT runs the board and Needs you (M; depends on #198)

- **`edit_card { issue, size?, priority?, lane?, assignees?, labels?, basis }`.**
  - Assignees are limited to configured logins.
  - It refuses `always_ask` cards, and cards in another lane except to settle a lane conflict.
  - On a `superuser` repo, priority changes skip #402's approval.
  - Status moves stay with `promote`.
- **`dismiss_item { key, basis }`.**
  - It clears items that aren't operator-owned or `lane:<login>`-owned, plus items whose subject has resolved.
  - It never clears guard acks, budget or account items, approvals, or the auto-Update hold.
- **`restart_seat { seat, basis }`.**
  - It restarts a crew seat in state `error`.
  - It never restarts one that is `stopped` by the operator, an account or a budget, FLIGHT itself, or an observed loop.

### #459: FLIGHT reads GitHub and the web (M; depends on #198, and on #203's home-read build tickets or #203's recorded "accepted" decision)

- **`gh_read { path }`.**
  - GET only, on fixed path templates, for the repo FLIGHT is raised on.
  - It runs from an empty folder, with its own `GH_CONFIG_DIR` and `GH_TOKEN` from the hub's `gh auth token` (in the environment only).
  - It always passes `--method GET`, and refuses `-f`, `-F`, `--input` and `graphql`.
  - Output goes through `scanSecrets`, capped at 20,000 characters, with a per-hour call cap.
- **WebFetch and WebSearch** for a `superuser` FLIGHT seat.
  - The URL is normalised first (`127.1`, `0x7f000001`, `2130706433`). Then these are denied: loopback, `localhost`, `[::1]`, `::ffff:127.0.0.1`, private ranges, `169.254/16` and `fc00::/7`.
  - Only http and https are allowed. The host is resolved, and the fetch is denied if any address is private.
  - Whether WebFetch follows redirects to another host is checked by experiment.
  - Each case has a test.
  - The CLI's subagent tool name is checked by experiment before it is granted, with a test.

### #176: ops signals and triage (M; depends on #198 and #449)

- **The signals:** `flaky_test`, `repeat_park`, `queue_stall` (from `merge_queue`), `idle_seat`, `github_budget` and `hub_error`. Each wakes FLIGHT once per key.
- **Triage wakes:** new Backlog tickets, finished plans and resolved dependencies.
- **No wake on a phase change.**
- **The role:** fix it with your tools, or file a ticket.

### #450: memory and the retrospective (M; depends on #176)

- **The memory store:** a store per repo of lessons, the repo profile, the crew and playbooks.
  - Notes are evidence, never authority.
  - The operator can edit and delete them.
- **The retrospective.** The hub raises a retrospective wake fact at 03:00 local, so it runs even when nothing else wakes FLIGHT. FLIGHT files a ticket for each missing-power gap, and writes lessons, files tickets or acts with its tools on up to three other items.
- **The FLIGHT page panel** is a follow-on web ticket.

### Later

- **#460: an operator token on the hub's mutating loopback routes.** Today the HUD bundle and anything on the machine can call them. This comes before any power is widened further.
- **Repo skills as a readable index** (#174). The operator's own skills and plugins never reach the crew (§8b.1).
- **Ownership across repos** (#175).
- **Away mode overriding these tools** (#340).

## Security model

- **New GitHub writes,** all under the operator's account, only on `superuser` repos, and only through typed hub tools that log a basis:
  - merges of run PRs in FLIGHT's lane;
  - the engine's worktree merges of main (already made today, now in order);
  - CI re-runs (capped);
  - `mc/review` set to "waived" by `settle_park accept`;
  - PR comments carrying FLIGHT's basis, after secret and notifier checks;
  - project fields, labels and configured-login assignees.
- **New reads:**
  - `gh_read` (GET only, fixed templates, one repo, capped);
  - a cached collaborator-permission lookup;
  - WebFetch and WebSearch for FLIGHT's seat, with private ranges denied.
- **No general instruments.** FLIGHT's Bash keeps its sandbox. FLIGHT has no raw `gh`, no general HUD-route tool, none of the operator's skills or plugins, and no code writing.
- **The floor** is enforced in the hub's tools, the guard and the engine's merge step.
  - **Floor 6:** a merged change to the hub's code doesn't go live without the operator or the controller session.
  - **Floor 7:** FLIGHT can't change the repo's rules or CI.
- **Audit.** Every elevated call is logged with its basis. Lowering `flight_powers` takes effect at the next call and restarts FLIGHT's seat.

## Done when (measured once these slices have merged)

- FLIGHT's "For the controller" notes fall to near zero, and the retrospective reports the count.
- Crew PRs on `mission-control`, hard-rule ones included, merge without a person-side controller. Hub-code Updates are still run by the operator or the controller session.
- No queued PR is brought up to date with main while it is behind the front.
- A flaky check seen twice becomes a ticket with evidence, or gets fixed, before a person notices it.
- FLIGHT's memory holds the week's lessons, and its wakes cite them.
