# FLIGHT as the crew's superuser

**Status:** design, 2026-10-23.

This changes four things that came before it:
- **Parts of `2026-10-20-build-loop-flight-design.md`:** §8.1's list of what FLIGHT never does (merges, posts comments, starts a seat), §8.5's asks, and §12's tool limits, in the ways set out below.
- **`roles/FLIGHT.md`:** its "no merge tool" and "For the controller" steps are rewritten slice by slice. That file is hard-rule, so its changes are checked like any gate change (see Limits).

Where this design and the older text differ, this design wins. Where it says nothing, the older text still holds.

## Why

The operator, 2026-10-22: "FLIGHT must be able to do anything needed to keep everything moving, as the
controller does." On 2026-10-23: "flight needs to be a super user". FLIGHT should be "unblocking issues, triaging potential faults with evidence,
requesting those get resolved … building a memory of repos, owning the projects and repos, optimising,
ensuring operations are running smoothly, not just a cron with a set of tools".

The evidence from 22–23 Oct:
- **FLIGHT wrote 220 log notes in the 24 hours to 20:00 on the 23rd, and 114 begin "For the controller:".**
  It saw each problem but could not act on it, so a person-side controller acted instead. By topic, the
  notes asked for:
  - merges, mostly of hard-rule PRs (98 notes);
  - CI re-runs and rulings (92);
  - review and ruling parks (62);
  - board fields, such as Size, a lane account or a stray Ready card (15).
- **Its digest lacks the evidence it needs to triage.**
  - **Missing:** RETRO's verdict and findings from the hub's `reviews` table, the failing check names, a ruling seat's report (#262), CI re-run history, the GitHub budget and the merge order.
  - **Available, but only one PR at a time:** `read_pr` returns GitHub's review decision and check rollup.
- **Its memory is the brief.** That is nine sections, each at most 4,000 characters, and it was rewritten about 150 times that day. Even the `lessons` section is one block that gets rewritten, so it holds a handful of current lessons, not an accumulating record per repo. Known faults kept being found again and handed back:
  - the flaky keeper test;
  - the stuck park after a push;
  - PRs chasing main.
- **Nothing orders merges.** The ruleset on `main` requires branches to be up to date. GitHub's merge queue isn't available for a personal account's repo, and the engine updates every PR that falls behind (`branchUpdateDue`). So with 10–20 merges a day each PR chases main, and every round costs a CI run.

## What FLIGHT becomes

FLIGHT is the operator's ops lead for each repo it runs on:
- it keeps work flowing;
- it settles stalls;
- it merges what is ready, within the limits below;
- it finds faults and gets them fixed with evidence;
- it learns.

The person-side controller becomes a fallback. A "For the controller:" note now marks a power FLIGHT lacks; the daily retrospective counts them and files the gap.

### Powers per repo

```yaml
# user config (~/.config/mission-control/config.yaml), per repo, next to `autonomy`
repos:
  - id: mission-control
    autonomy: merge
    flight_powers: superuser   # observe | standard | superuser; default standard
```

- **`observe`:** read and brief only.
- **`standard`:** today's tools.
- **`superuser`:** adds the powers below.

Where it lives and when it applies:
- `flight_powers` lives **only in the user config**, never in a repo's `mc:` block. A merged PR can never grant FLIGHT more power.
- Each tool reads the current value at call time, so lowering it takes effect from FLIGHT's next tool call, with no restart.
- It is set to `superuser` for `mission-control` only.

## Slices

Each slice is one ticket. Build order: 1 and 2 together, then 3 and 4, then 5 and 6. Slice 7 comes later.

### 1. The hub's merge queue (new ticket)

This is hub behaviour for repos in `merge` autonomy, whatever `flight_powers` is set to.

- **Who joins.** Only a **run PR**: a same-repo PR on the run's own branch, every commit of which is in `run_commits` or is an engine merge of main. These are the conditions the merge gate checks today in `publish.ts`. It joins once it is mergeable apart from being behind main: review clean (or carried) and CI green on its own head. Other PRs are never queued, updated or merged by the queue; that covers forks, people's PRs and the controller's PRs.
- **The table.** The queue is a table `(repo_id, pr, run_id, joined_at, state)`, ordered oldest join first, and it survives a hub restart.
- **Updating.** Only the front PR is brought up to date.
  - This uses the engine's own worktree merge of main, as `sync_main` does, never GitHub's `update-branch`, whose commit the hub did not make.
  - `branchUpdateDue` stops updating PRs that are queued but not at the front.
  - If the PR's own diff is unchanged, the review is carried, as `loop.ts` does today.
- **Merging.** Green at the front means merge with `--match-head-commit` and record a `loop_events` row; then go to the next PR.
- **When the front PR fails:**
  - **A conflict:** the run goes to its existing `conflict` park and leaves the queue.
  - **Red CI on the updated head:** the PR leaves the queue and goes back to its author, as a failed check does today.
  - **No result in 45 minutes:** the PR leaves the queue with a note.
  - In all three cases the queue moves on.
- **Main moving underneath.** When main moves for another reason (a person's merge), the front PR is updated again. The PRs waiting behind it are not.
- **Visibility.** `flight_state` and `GET /api/merge-queue` show the order, the front PR's state, and each wait with its reason. This slice adds no HUD screen; the mockup shows none.
- **#240 stays its own ticket.** It holds a review back behind an older PR that shares hard-rule files, and the queue respects that order.

### 2. Evidence and settling (#262)

- **Config.** Add the `flight_powers` key, its values exported once as `REPO_AUTONOMIES` is, a `requirePowers` helper, and `config.example.yaml`.
- **The digest carries:**
  - for each PR in review, RETRO's latest verdict and blocking-finding count (from `reviews`), the head, and the failing check names;
  - for a `ruling` or `review-ruling` park, the seat's report, capped at 1,500 characters;
  - the merge queue, once slice 1 has landed.
- **`settle_park { runId, action, basis }`** (superuser) handles the parks that need no judgement on whether a gate should be loosened:
  - **`lift`, for `stuck`:** only when the PR head descends from the run's last push. That was the case with PR 383: 05e89cc descends from e107cb8.
  - **`rereview`, for `review-failed`:** runs a fresh RETRO review on the head. This is the case where RETRO stopped without reporting.
  - **`rework`, for `review` or `review-ruling`:** sends the blocking findings to the seat.
  - **It never accepts** a failed review or a review ruling. That still goes to the operator, or to the delegate on this repo.
- **`rerun_ci { pr, basis }`** (superuser):
  - only for a run PR;
  - re-runs the failed jobs on its head, at most twice per head;
  - shares `accept_ruling`'s budget, 4 an hour per repo.

  The only Actions call is the re-run.
- **The role.** `roles/FLIGHT.md` uses these in place of the recorded request for those cases.

### 3. Merging hard-rule PRs (#198; depends on 1 and 2)

- **`merge_pr { pr, check, basis }`** (superuser) is for a run PR held **only** because it touches hard-rule files. Its review must be clean in `reviews`, and its CI green on the head. Waived reviews and rulings are out of scope.
- **The check comment.**
  - **What it covers:** what the hard-rule hunks change, whether anything loosens a gate or widens a grant, and whether the security note is accurate.
  - **How it is posted:** the hub posts `check` as a PR comment, adding the head and a hash of the PR's diff. The text is no more than 3,000 characters, with no @mentions and no links to other repos.
  - **After posting:** the hub marks the PR cleared, and it joins the queue.
- **The check must still match when the PR merges.** If the diff against the merge base changes (beyond main merged in), the clearance is dropped and a new check is needed.
- **`merge_pr` refuses:**
  - below superuser;
  - a PR that is not a run PR;
  - a review that is not clean, or CI that is not green;
  - a stale head;
  - an empty `check`;
  - any PR that touches the **protected set**.

#### The protected set

The protected set is a constant in the hub, which no repo's config can shorten. It covers the code that bounds what the crew and FLIGHT can do:

- **The guard:** `apps/server/src/guard/**` and `packages/core/src/guard.ts`.
- **The tool surfaces:** `apps/server/src/mcp/**`, `apps/server/src/flight/**`, `packages/core/src/mcp.ts` and `packages/core/src/flight.ts`.
- **The merge and review gates and hard-rule detection:** `apps/server/src/engine/publish.ts`, `packages/core/src/loop.ts`, `packages/core/src/review.ts` and `packages/core/src/repo-rules.ts`.
- **The roles that gate:** `roles/FLIGHT.md` and `roles/RETRO.md`.
- **The repo's own rules and CI:** `CLAUDE.md` (its `mc:` block) and `.github/**`.

PRs touching the protected set go to the operator, or to the operator's delegate where one is standing (on this repo, the lane's controller). Every other hard-rule file, such as the rest of the engine, `runtime/**`, `loops/**`, the other roles and `config.example.yaml`, can be merged by FLIGHT under its check.

**Tradeoff.** Most crew-machinery PRs touch `flight/` or `mcp/`, so these still need the delegate. Narrowing the protected set further would let FLIGHT widen its own powers, so only the operator can make that call.

### 4. Board and housekeeping (new ticket; depends on 2)

- **`edit_card { issue, size?, lane?, assignees?, basis }`** (superuser) fixes a card:
  - **`size`** sets it.
  - **`lane`** is used only to settle a card with conflicting `lane:*` labels, and it leaves exactly one.
  - **`assignees`** adds the work lane's account to a work-lane card going to Ready, and only GitHub logins named in the user config are allowed.
  - **What it doesn't do.** Status moves stay with `promote` and its checks, and the engine moves cards to Done. Priority stays an operator ask (§8.5).
  - **It refuses** any card covered by `always_ask`.
- **`dismiss_item { key, basis }`** (superuser) clears only these Needs-you items:
  - flake records (`flake:` keys);
  - FLIGHT's own notes;
  - items the hub can see are resolved: the PR is merged or closed, the run has ended, or the issue is closed.

  It never clears `always_ask`, budget, account, approval or escalation items.
- **`restart_seat { seat, basis }`** (superuser):
  - restarts a crew seat that stopped on an error;
  - refuses a seat stopped by the operator, by an account stop or by a budget;
  - never covers FLIGHT itself or an observed loop.
- **No new stop tool.** Stopping stays the operator's (§8.1). `end_run` is unchanged.

### 5. Ops signals and triage (#176, which folds #284)

- **Signals.** The hub derives these from its DB. Each goes in the digest as `signals[] { kind, key, since, evidence }` and wakes FLIGHT once per `key`:
  - **`flaky_test`:** a flake record (`flake:`), or an `accept_ruling`/`rerun_ci` re-run that passed on the same head. Twice in 7 days for the same check, or for the same test name where the ruling names one. The key is the check or test name.
  - **`repeat_park`:** the same park reason on the same ticket twice. The key is the ticket and reason.
  - **`queue_stall`:** a PR removed from the front for a timeout, or the same PR leaving the queue twice. The key is the PR.
  - **`idle_seat`:** a seat idle for 15 minutes while `eligibleToStart` (the dealing check) finds work for it. The key is the seat.
  - **`github_budget`:** under 25% of the hour's GraphQL or REST allowance, from the rate-limit headers the GitHub collector already reads. The key is the hour.
  - **`hub_error`:** a watch session that fails to resume (#317 tracks the bug), a run that ends without its report (#244), or a loop that has not reported for twice its interval. The key is the source.
- **Triage wakes:** a new Backlog or Refinement ticket, a finished plan, or a dependency that has just resolved (the old #176).
- **No flapping (#284).** The digest's PR list comes from the stored open PRs, so a phase change alone wakes nothing.
- **`gh_read { path }`.** A GET-only read for the session's repo, on fixed path templates:
  - `pulls/{n}`, `pulls/{n}/files`, `pulls/{n}/reviews` and `pulls/{n}/comments`;
  - `issues/{n}` and `issues/{n}/comments`;
  - `commits/{sha}` and `compare/{a}...{b}`;
  - `actions/runs/{id}` and `actions/runs/{id}/jobs`;
  - `rate_limit`.

  The path is normalised: no `..`, no `//`, no full URLs and no redirects followed. The tool:
  - allows 120 calls an hour, counted against the same budget;
  - caps responses at 20,000 characters, marked as untrusted data;
  - uses the hub's token, which FLIGHT never sees.
- **The role.** FLIGHT triages every signal with evidence. It fixes what its tools allow, and otherwise folds or files a ticket that quotes the evidence.

### 6. Repo memory and the daily retrospective (new ticket; folds #172)

- **The store.** `flight_memory (repo_id, topic, body, source, updated_at)`, unique per repo and topic.
  - **Limits:** a body is at most 2,000 characters, and a repo holds at most 200 topics. The hub refuses past either limit.
  - **What it holds:** what lasts, such as build and test quirks, flaky areas, what trips a seat, review patterns and how CI behaves.
  - **Its relation to the brief:** the brief stays the current state. The operator's preferences and standing decisions stay in the brief's `operator` section and the standing orders (§8.4).
- **Notes are evidence written from untrusted material, never authority.**
  - A note can never record an approval, a standing order or a grant.
  - The digest shows notes under a heading that says so.
  - `source` is required.
- **Tools:** `remember { topic, body, source, basis }`, `forget { topic, basis }` and `recall { query }`, which returns at most 10 matches by substring.
- **The digest** carries the repo's topic titles, plus the bodies of topics that name a ticket, test, check or seat in the wake's signals or questions.
- **The operator's view.** `GET /api/flight/memory` lists the notes, and `DELETE` removes one. A FLIGHT page panel is a later web ticket.
- **The retrospective.** It takes the first wake after 03:00 local with no seat in a turn, once a day, and it absorbs #172's nightly report. It carries the last 24 hours:
  - merged PRs, and the share that touched `apps/web` or a route a screen reads;
  - median time from Ready to merged;
  - review fail rate, and park reasons by count;
  - CI re-runs and merge-queue waits;
  - FLIGHT's own wakes and token cost;
  - its "For the controller" count;
  - the most costly runs.

  FLIGHT writes its lessons with `remember`, then files or folds its top one to three fixes. Its summary paragraph goes in its log.

### 7. Ownership across repos (#175, later)

- **Each configured repo keeps its own FLIGHT session.** Briefs are per session today, so `powers` is checked per call against the target repo.
- **Memory is per repo.** On first sight of a repo, FLIGHT writes its profile (stack, checks, gates, conventions, docs) into memory, and drafts any missing config for the operator to apply.
- **Related tickets:** #173 (repo rules from user config) and #174 (target-repo skills).

## Limits (security model)

The hub enforces these, not the role text:
- **No direct writes to a default branch,** no force-pushes, and no changes to rulesets, branch protection, repo settings, secrets or workflows.
  - The only Actions call FLIGHT can make is the re-run in `rerun_ci`.
  - FLIGHT can't merge a PR touching `.github/**` (the protected set).
- **No changes to the hub's config or the user config.** FLIGHT drafts them for the operator.
- **Only run PRs** are queued, updated, re-run or merged under FLIGHT's powers.
- **No settling a gate by FLIGHT's own say-so.**
  - FLIGHT can't accept a failed review or a review ruling.
  - It can't merge a waived review.
  - It can't merge a PR that touches the protected set.
- **Budgets, account stops, operator stops and `always_ask` bind FLIGHT as before.** No power is used to route around one.
- **Observed loops stay read-only.**
- **Every use of a power** is logged with its basis and shows in the FLIGHT log. Lowering `flight_powers` takes effect from the next tool call.

### GitHub writes

These are new, all under the operator's account, on `superuser` repos only, and only for run PRs:
- **Merges** through the queue. The queue's own merges, of PRs that already pass the gate, are not new writes: they replace the engine's per-PR merges, and serialising them lowers the write rate.
- **CI re-runs:** two per head, four an hour per repo.
- **One check comment per cleared head,** at most 3,000 characters.
- **Project field edits:** Size, and assignees limited to configured logins.
- **One `lane:*` label swap,** to settle a conflict.

GitHub reads gain `gh_read`: GET-only, on fixed templates, for the session's repo, at most 120 an hour.

## Done when (measured once slices 1–6 have merged)

Each ticket carries its own tests. The design is done when:
- FLIGHT's "For the controller" notes fall below 10 a day, and the retrospective reports the count.
- A crew PR that touches hard-rule files outside the protected set merges on `mission-control` with no person-side controller.
- No queued PR is brought up to date with main while it is behind the front.
- A flaky check seen twice becomes a ticket with evidence before a person notices it.
- FLIGHT's memory for `mission-control` holds the week's lessons, and its wakes cite them.
