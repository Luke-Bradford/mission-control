# Stalls, stuck runs and open PRs

Read this when a run is parked, crashed or in error, a seat waits on something, or a PR is stuck. Where this file and `roles/FLIGHT.md` differ, the role wins. Each tool's description carries its own limits; this file adds what the descriptions don't say.

A stall is a parked run, a seat waiting on something, or a PR that conflicts with main or is stuck in review. A PR that is only behind main is not a stall: it merges as it is. Clear what your tools allow. Check a seat's claim that a CI failure isn't its fault against the evidence; never take it on trust.

## Open PRs

- Each PR's digest entry carries `seat`, `runId`, `review`, `failingChecks` and `awaitingFlight`. From them, know who moves it next and what it waits on. Read the PR with `mc gh_read` only when they don't say.
- Move each one where a tool lets you: send findings or re-review with `mc settle_park`; sync a conflicting PR with `mc sync_main`; re-run failing CI with `mc rerun_ci`, or settle a CI ruling with `mc accept_ruling`; merge an `awaiting-flight` PR with `mc merge_pr`.
- **Merging.** On superuser repos, `mc merge_pr { pr, basis }` clears an `awaiting-flight` run PR in your lane, and the engine merges it. Non-collaborator forks and operator holds remain protected. Read the hard-rule hunk before you clear a PR. A PR that changes what confines seats gets a Controller check with `mc add_controller_check` before you clear it. That is `apps/server/src/guard/**`, `packages/core/src/guard.ts`, `packages/core/src/runtime.ts`, `packages/core/src/path-grants.ts`, the Codex floor and approval, grants and toolchain files under `apps/server/src/runtime/`, and the push gate in `apps/server/src/mcp/tools.ts`. Clear every other hard-rule PR yourself, your own tools and the engine included, once a review on the most capable model is clean. The Mission Control block in `CLAUDE.md` and `.github/**` are the operator's; `roles/**` and `.claude/**` are never yours either.

## Stuck and failed runs

- **A parked run:** settle it for its park kind, as below (`mc settle_park`, `mc message_seat { unpark: true }`, `mc accept_ruling`).
- **An open PR from a crew run that ended or crashed:** its `prs[].seat` is empty. A crew seat worked its ticket (your start decision, or the seat's activity).
  - No tool resumes it: record `Missing power: resume PR #N on <seat>. For the controller:` once, and track it.
  - A PR the controller or a person opened has no seat either; it is not a failed run.
- **A seat in `error` with no run:** its crashed ticket stays In progress with no run, and no tool re-queues it.
  - Record `Missing power: re-queue #N (run crashed). For the controller:` once.
  - Then start the seat on its next Ready ticket with `mc start_seat`; the hub never deals to a seat in `error`.
- **A seat with `seats[].runId` set and no live session** after an error or a hub restart: `mc resume_seat`. A stopped or paused seat follows the role's step 4.
- **A repeat failure** of the same seat or ticket: read why (the error, signals, `mc read_ci_log`) before acting.

## CI ruling parks

- Check the author's claim against the evidence (`mc read_ci_log`), then settle it with `mc accept_ruling { runId, basis }`.
- The first call has the hub re-run the failed jobs once. End your turn and call again on a later wake; a call while the re-run is still going only says so.
- A pass accepts the ruling; a fail sends the author the failure.
- If the same commit is ruled on again, the tool refuses: it is the operator's. Pass its park up with `mc brief_item { for: "operator" }`, with your evidence and recommendation.

## Review and stuck parks (superuser repos)

Use `mc settle_park { runId, action, basis }`:
- `lift` a stuck park after the push. It shares the two-unparks-per-run limit with `mc message_seat`.
- `rereview` asks for a fresh RETRO review, twice per head.
- `accept` settles a `review` or `review-ruling` park.
- `rework` sends the findings to the seat.
- A `review-failed` park permits only `rereview`. CI `ruling` parks use `mc accept_ruling`.
- Floor-enforcing code needs a reported, unblocked RETRO review on that head.

## Conflicts with main (merge workspace)

- Use `mc sync_main { runId, basis }` for a PR GitHub reports as conflicting with main, or a run parked on a `conflict`. The hub merges main in; on a conflict the author resolves it.
- Don't sync a PR that is only behind main: it merges without main. The tool won't stop you, but a sync restarts its CI for nothing.
- It refuses while the seat is in a turn, with unpushed commits or uncommitted changes, or when a merge of main already waits on the seat. Then record why, and try on a later wake.
- Never ask a seat to merge main.

## Controller-check parks

- At merge, the engine parks a run whose ticket has a `## Controller check` (park kind `controller-check`). It stays parked until the controller records a verdict for that head; a later push needs a new one.
- You can't settle, resume or lift it: `settle_park`, `message_seat` unpark and `merge_pr` don't apply. Never `end_run` it to get past the check.
- Tell the controller with a labelled `mc comms_send` (PR ref) when one parks. It is already in Needs you, so don't brief it again. You may hold that item for at most a day.
- An open check is not a rework reason: the controller's `fail` sends the rework itself.

## Ending a run

- `mc end_run { runId, basis }` frees a developer run: working, parked or stalled on its seat, or parked while set aside. Use it only when ending it keeps the work, and nothing useful can continue.
- On a working run it needs superuser, and it refuses a held run.
- It interrupts the seat's turn before a second check for uncommitted changes. If it refuses then, the turn is already stopped: ask the seat to commit and push.
- It doesn't check for commits that were never pushed: whether the work is kept is your judgement.
- Take `runId` from `flight_state` (`seats[].runId`, `aside[]`, `prs[].runId`).
- To lift a set-aside run's park instead, use `mc message_seat { seat, text, unpark: true, runId }`.
- Never end a run to get around a budget, a review, a ruling or an operator hold.
