# Stalls, stuck runs and open PRs

Read this when a run is parked, crashed or in error, a seat waits on something, or a PR is stuck. Where this file and `roles/FLIGHT.md` differ, the role wins. Each tool's description carries its own limits; this file adds what the descriptions don't say.

A stall is a parked run, a seat waiting on something, or a PR that conflicts with main or is stuck in review. A PR that is only behind main is not a stall: it merges as it is. Clear what your tools allow. Check a seat's claim that a CI failure isn't its fault against the evidence; never take it on trust.

## Open PRs

- Each PR's digest entry carries `seat`, `runId`, `review`, `failingChecks` and `awaitingFlight`. From them, know who moves it next and what it waits on. Read the PR with `mc gh_read` only when they don't say.
- Move each one where a tool lets you: send findings or re-review with `mc settle_park`; sync a conflicting PR with `mc sync_main`; re-run failing CI with `mc rerun_ci`, or settle a CI ruling with `mc accept_ruling`; merge an `awaiting-flight` PR with `mc merge_pr`.
- **Merging.** Use `mc merge_pr { pr, basis }` once CI is green on the head and the review is clean; read a hard-rule hunk first and make sure its review ran on the most capable model. Release your own merge hold with `mc hold_pr`; an operator's hold is theirs, so ask them in one brief once its reason is met.

## Stuck and failed runs

- **A long check holding the test lock:** a check may run for 45 minutes, and seats behind it are refused after 10. A Claude check writes a heartbeat, so "stalled" on a holder means it is wedged: `mc end_run` or `mc operator POST /api/seats/:id/interrupt` frees the lock. Nothing alerts you to a long hold that still has a heartbeat, so look at the lock when seats report it busy.
- **A parked run:** settle it for its park kind, as below (`mc settle_park`, `mc message_seat { unpark: true }`, `mc accept_ruling`).
- **An open PR from a crew run that ended or crashed:** its `prs[].seat` is empty. A crew seat worked its ticket (your start decision, or the seat's activity).
  - Resume the preserved run through `mc operator POST /api/runs/:id/resume`.
  - A PR a person opened by hand has no seat either; it is not a failed run. Decide it like any other PR.
- **A seat in `error` with no run:** its crashed ticket may still be In progress with no run.
  - Preserve its branch and work, then return the ticket to the right board column with the shell (`set_fields` moves a card only to Blocked, or out of Blocked to Backlog).
  - Then start the seat on its next Ready ticket with `mc start_seat`; the hub never deals to a seat in `error`.
- **A seat with `seats[].runId` set and no live session** after an error or a hub restart: `mc resume_seat`. A stopped or paused seat follows the role's step 4.
- **A repeat failure** of the same seat or ticket: read why (the error, signals, `mc read_ci_log`) before acting.

## CI ruling parks

- Check the author's claim against the evidence (`mc read_ci_log`), then settle it with `mc accept_ruling { runId, basis }`.
- The first call has the hub re-run the failed jobs once. End your turn and call again on a later wake; a call while the re-run is still going only says so.
- A pass accepts the ruling; a fail sends the author the failure.
- If the same commit is ruled on again, the tool refuses: it is the operator's. Pass its park up with `mc brief_item { for: "operator" }`, with your evidence and recommendation.

## Review and stuck parks

Use `mc settle_park { runId, action, basis }`:
- `lift` a stuck park after the push. Read the cause before repeating a lift.
- `rereview` asks for a fresh RETRO review, on the current head.
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

- A ticket's `## Controller check` names evidence to produce. You produce it (`mc screenshot_hud`, a CI rerun, a live check) and record the verdict for that exact head with `mc operator` POST `/api/runs/:id/controller-check`. A later push needs new head-bound evidence.
- An open check is not a rework reason: a `fail` verdict sends the rework itself.

## Ending a run

- `mc end_run { runId, basis }` frees a developer run: working, parked or stalled on its seat, or set aside in any phase (an evidence hold never parks, and this ends it). Use it only when ending it keeps the work, and nothing useful can continue.
- It refuses a held run.
- It interrupts the seat's turn before a second check for uncommitted changes. If it refuses then, the turn is already stopped: ask the seat to commit and push.
- It doesn't check for commits that were never pushed: whether the work is kept is your judgement.
- Take `runId` from `flight_state` (`seats[].runId`, `aside[]`, `prs[].runId`).
- To lift a set-aside run's park instead, use `mc message_seat { seat, text, unpark: true, runId }`.
- End a run to unblock work, not to skip a review that found real problems.
