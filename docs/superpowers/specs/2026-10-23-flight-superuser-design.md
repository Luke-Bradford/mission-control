# FLIGHT as the crew's superuser

**Status:** design, 2026-10-23. It replaces the "FLIGHT has no merge tool" and "For the controller" parts of
`2026-10-20-build-loop-flight-design.md`. Where the two differ, this one wins.

## Why

The operator, 2026-10-22: "FLIGHT must be able to do anything needed to keep everything moving, as the
controller does." And again on 2026-10-23: "flight needs to be a super user". He also said it should be
unblocking issues, triaging faults with evidence, building a memory of its repos, owning them and optimising,
"not just a cron with a set of tools".

The evidence from 22–23 Oct:
- **FLIGHT wrote 220 log notes in 24 hours, and 114 begin "For the controller:".** It saw the problem and
  had no power to act on it, so a person-side controller acted instead. By topic, the notes asked for:
  - merges, hard-rule merges included (98 notes);
  - CI re-runs, checks and rulings (92);
  - review and ruling parks (62);
  - board fields, which are Size, Status, assignee and lane (15).
- **It can't see what it would need in order to triage.** It has no review verdicts or CI history, no
  flake record, no GitHub budget and no merge-queue state (#262).
- **Its memory is one brief:** nine sections of at most 4,000 characters each, rewritten about 150 times a
  day. It holds the current state, not what was learned. So the same lessons, such as the flaky keeper
  test, the strict-mode merge treadmill and the stuck park after a push, get rediscovered and handed back.
- **Nothing serialises merges.** The `main` ruleset requires an up-to-date branch. With no GitHub merge
  queue (it is not offered for personal accounts), every PR chases main, so CI re-runs and reviews get
  carried repeatedly.

## What FLIGHT becomes

FLIGHT is the operator's ops lead for every repo it is configured on. It keeps work flowing, merges what is
ready, finds faults and gets them fixed with evidence, and learns. The person-side controller becomes a
fallback, not a dependency. A "For the controller:" note is now a sign of a missing power. The retrospective
(slice 4) counts these notes and files the gap as a ticket.

### Powers per repo

```yaml
repos:
  - id: mission-control
    flight:
      powers: superuser   # observe | standard | superuser; default standard
```

- **`observe`:** reads and briefs only.
- **`standard`:** today's tools.
- **`superuser`:** everything below.

`superuser` is opt-in per repo. It is set on `mission-control`. Other repos stay on `standard` until the
operator sets them.

## Slices

Each slice is one ticket, and it folds the open tickets named against it. Build order is 1, 2, 3, then 4
and 5 in parallel.

### 1. Merges, and the hub's merge queue (folds #198, #240)

- **The queue.**
  - **Who joins:** a PR joins once it is mergeable apart from being behind main. That means its review is
    clean or an accepted ruling, and CI is green on its own head.
  - **Order:** oldest join time first.
  - **Updates:** the hub brings only the front PR up to date with main (`update-branch`, or the engine's
    merge of main in a merge workspace) and waits for its CI.
    - The others are not updated while they wait. That ends the treadmill.
    - If the PR's own diff is unchanged, the review is carried, as `loop.ts` does today.
  - **Merges:** green at the front means merge with `--match-head-commit`, then go to the next PR.
  - **Conflicts:** the PR goes back to its author (a seat run's `conflict` park, or an operator item for a
    PR with no run), and the queue moves on.
  - **Hard-rule PRs:** a PR touching a hard-rule file that an older queued PR also touches waits behind it
    (#240), so the merge resolution is reviewed.
- **The `merge_pr { pr, check, basis }` tool** covers PRs the engine holds for a person: hard-rule touches,
  waived reviews and CI rulings.
  - **On a `superuser` repo** FLIGHT posts its hard-rule check as a PR comment, then puts the PR in the
    queue. The check covers what changed, whether it loosens a gate or widens a grant, and whether the
    security note is accurate.
  - **It refuses:**
    - a red or stale head;
    - a review that is not clean;
    - a PR that changes FLIGHT's own powers, unless a review by a fresh agent (not FLIGHT) is clean. See
      Limits.
- **FLIGHT and the HUD** see the queue: its order, the front PR's state and the conflicts.

### 2. Settling, and the evidence to do it (folds #262)

- **New tools:**
  - **`settle_park { runId, outcome, basis }`** covers `review`, `review-ruling` and `stuck` parks.
    - `accept` carries the review, or lifts a stuck park whose head descends from the run's push.
    - `rework` sends the findings to the seat.
  - **`rerun_ci { pr, jobs?, basis }`** re-runs failed jobs, at most twice per head.
  - **`edit_card { issue, status?, size?, priority?, lane?, assignees?, basis }`** sets any board field.
    Assignees are limited to configured crew accounts.
  - **`dismiss_item { key, basis }`** clears a Needs-you item that isn't the operator's.
  - **`stop_seat` and `restart_seat`.**
- **The digest carries:**
  - each PR's review verdict, blocking-finding count, head and failing check names;
  - a ruling park's report text;
  - the merge queue.

### 3. Ops sight and triage (folds #176, #284, #317)

- **Fault signals.** The hub derives these and puts them in the digest, each once per cause:
  - **A flaky test:** the same test name fails, then passes on a re-run of the same head, twice in 7 days.
  - **A repeat park:** the same park reason on the same ticket twice.
  - **Queue stalls:** a PR at the front for over 30 minutes, or a conflict loop.
  - **Idle seats:** a seat idle for 15 minutes while work it could take exists.
  - **GitHub API budget:** below 25% of the hour's allowance.
  - **Errors:** hub errors, a watch session that fails to resume, a loop that stops reporting.
- **Read-only GitHub:** `gh_read { path }` makes a GET against the REST API for configured repos, capped
  per hour. It gives FLIGHT the evidence it lacks without network access in its sandbox.
- **Triage is FLIGHT's job.** For each signal it gathers evidence (`read_ci_log`, `gh_read`, its repo
  memory), then fixes what its tools allow. Otherwise it files or folds a ticket with the evidence: a CI log
  excerpt, commits, `loop_events` rows. A flaky test becomes a ticket with the failing runs listed.
- **Waking.** FLIGHT wakes on new signals, new Backlog items (#176) and real PR changes only (#284).

### 4. Repo memory and learning

- **Memory store.**
  - **Shape:** per repo, a set of topic notes (`flight_memory`: repo, topic, body, updated, source). Each
    note is at most 2,000 characters, and there are at most 200 per repo.
  - **Contents:** what is true and was learned. For example, build and test quirks, flaky areas, which seat
    trips on what, review patterns, the operator's preferences for this repo, and how CI behaves.
  - **The brief stays.** It is the working state; memory is what lasts.
- **Tools:**
  - `remember { repo, topic, body, basis }` creates or replaces a note;
  - `forget { repo, topic, basis }` removes one;
  - `recall { repo, query }` searches a repo's notes.
  - Each wake's digest carries the titles of the repo's notes, plus the bodies of notes linked to the
    current signals.
- **A daily retrospective wake.** At a quiet hour FLIGHT gets the day's measures:
  - throughput (merged PRs, and the share that touched a screen);
  - cycle time;
  - review bounce rate and park reasons;
  - flakes and queue waits;
  - its own wake count and token cost;
  - its "For the controller" notes.

  It writes lessons to memory and files or folds the top one to three fixes. The operator sees a short
  summary on the FLIGHT page.

### 5. Ownership across repos (folds #175)

- **One FLIGHT, every repo.** It runs for all the hub's configured repos, each under its own `powers`.
  Observed loops stay read-only unless the operator acts in the moment; FLIGHT briefs their items.
- **Repo profile.** On a first sight of a repo, FLIGHT builds its memory: stack, checks, gates, conventions
  and docs. It drafts any missing configuration for the operator (#175).

## Limits (security model)

These are enforced by the hub, not by the role text.

- **No direct writes to a default branch,** no force-pushes, and no changes to rulesets, branch protection,
  repo settings, secrets or Actions.
- **No changes to the hub's config or the user config.** FLIGHT drafts them for the operator.
- **A PR that changes FLIGHT's own powers needs a clean review by a fresh agent before FLIGHT may merge
  it.** Those paths are `apps/server/src/{flight,mcp,guard}/**`, `packages/core/src/{flight,guard,mcp}.ts`
  and `roles/FLIGHT.md`. On repos below `superuser` such PRs go to the operator.
- **Budgets, account stops and `always_ask` bind FLIGHT as before.** No power is used to route around one.
- **Observed loops** stay read-only.
- **Every use of a power is logged** with its basis and shows in the FLIGHT log. The operator can drop a
  repo to `standard` or `observe` at any time.

### GitHub writes

These are new, all under the operator's account and only on repos set to `superuser`:
- merges (through the queue);
- `update-branch` on queued PRs;
- CI job re-runs;
- project field edits;
- assignee changes, limited to configured crew accounts;
- PR comments for hard-rule checks.

GitHub reads gain `gh_read`, which is GET-only and limited to configured repos.

## Done when

- FLIGHT's "For the controller" notes fall below 10 a day, and the retrospective reports the count.
- A PR from the crew merges without a person-side controller, hard-rule PRs included, on `mission-control`.
- Every merge goes through the queue, and no PR is updated with main more than once while waiting.
- A flaky test seen twice becomes a ticket with evidence, without a person noticing it first.
- FLIGHT's memory for `mission-control` holds the lessons from the last week, and its wakes cite them.
