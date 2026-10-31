---
name: flight-ops
description: How FLIGHT runs the crew day to day on this repo. Use once per run (and again after a context reset), and whenever a seat, PR, ticket, comms item or the hub is stuck, slow or unclear.
---

# FLIGHT operations

Your job: keep every seat unblocked, and keep the work flowing to merged, live code. Find the real cause of a stall, get it fixed through a tool, a seat or a ticket, and stop it recurring. The playbook below is the minimum. When a stall doesn't fit it, investigate: read the code in your checkout, the CI logs and `mc flight_state`, then solve it.

`roles/FLIGHT.md` sets the order of each wake ("How you run the crew") and what is not yours. Where this skill and the role differ, the role wins.

## Where to look

| To know | Use |
|---|---|
| Seats, runs, parks, open PRs, questions, recent decisions | `mc flight_state` (`seats[]`, `aside[]`, `prs[]`) |
| Your tracked work | `mc ledger` |
| What seats said | `mc comms_inbox`, `mc comms_read` |
| A PR: diff facts, reviews, threads | `mc read_pr`, `mc gh_read` |
| Why CI failed | `mc read_ci_log` |
| Tickets | `mc list_tickets`, `mc read_ticket` |
| The GitHub rate limit | `mc gh_read { path: "rate_limit" }` |
| What a page shows | `mc screenshot_hud` |
| The standing checks and thresholds | `docs/runbooks/standing-checks.md` |

`docs/runbook.md` and the hub's HTTP routes are for the operator and the controller. You have no network, so read them only to understand what a controller would do.

## Playbook: what a stop means and how to clear it

Unparks share a limit of two per run. Rows marked **(#1214)** need a power you don't have yet. Until #1214 ships, record `Missing power: <action>. For the controller:` once with `mc log_decision`, track it, and move the seat on to its next Ready ticket. Use `mc start_seat` for that in a draft workspace only, and never on a seat the operator stopped or paused. In a merge workspace the hub deals the work; your part is to promote.

| The run says | Cause | Clear it |
|---|---|---|
| `have not all passed on this exact commit` | a check listed in the refusal is missing or failed on the head | the hub has already told the seat. If it hasn't acted, `mc message_seat` with the commands the refusal lists. When the seat says it ran them on the head, lift with `mc settle_park { action: "lift" }`. A parked run never pushes, so the engine retries the push only after the lift |
| `PR #N has head <a>, not <b>` | the hub's copy of the PR is stale, or the push hasn't landed | check the head with `mc read_pr`. Once it shows `<b>`, `mc settle_park { action: "lift" }` |
| `an earlier PR is open on this branch` | another seat's ended run opened the PR; a seat continues only its own | **(#1214)** close the old PR, then unpark; or give the ticket back to the seat that opened it |
| `could not create a worktree for <branch>` (a `start_seat` refusal) | an ended run's worktree still holds the branch | **(#1214)** remove that clean worktree, then start again |
| `conflicts with main` | main moved under the PR | `mc sync_main { runId }`. If the seat already resolved it and can't push, `mc message_seat { unpark: true }` |
| `found blocking issues in` | the review-round cap | new findings: `mc settle_park { action: "rework", note }` (3 per head, 9 per run). The same findings again: ask the planner (`mc comment_ticket`) to narrow the ticket, file the rest, then `mc settle_park { action: "accept" }` |
| `controller check on <sha>` | the ticket asks for evidence only the controller produces | the controller's to settle. Tell the controller once with a labelled `mc comms_send` (PR ref). It is already in Needs you. Never `end_run` it |
| `run ended (the process crashed)` / interrupted | a crash | the run has ended, and its park can't be lifted or unparked. **(#1214)** resume its PR, or re-queue its ticket. Meanwhile record the missing power and move the seat on. On a second failure of the same seat or ticket, read why first |
| `stopped after 3 carry-on resumes without reporting` | the seat lost the thread | `mc message_seat { unpark: true, text }` with the exact next step (often "push and report") |
| a ticket In review or In progress with no run | its run ended with a PR open | **(#1214)** start it on its branch. Never start a different seat on it while that PR is open |
| a PR that widens your own powers (`apps/server/src/flight/**`, `roles/FLIGHT.md`, this skill) | it needs the controller's eyes, not a hold | read the hard-rule hunk and clear it, then add `## Controller check` to its ticket with `mc add_controller_check` so the controller's verdict reaches the seat. A merge hold blocks that verdict (PRs 1033 and 1213 needed a two-step workaround) |
| a PR green and reviewed, not merging | it waits on clearance | `mc merge_pr` for an `awaiting-flight` PR in your lane, after reading the hard-rule hunk. Not yours: `roles/**`, `.github/**`, the Mission Control block in CLAUDE.md, operator holds, controller checks |
| merged, not live | auto-Update held (hard-rule change) or a stale version cache | not yours to Update. A held Update is already in Needs you. Otherwise record `Missing power: Update the hub to <sha>. For the controller:` once |

For a stop not listed here, find its text with `rg -F '<text>' apps/server/src packages/core/src`, read what clears it, and act. Write what you learned with `mc remember { kind: "playbook", … }`. If the skill itself should change, file a ticket.

## Dependencies and conflicts

- Work that builds on an unmerged PR waits. Hold it with `mc promote { issue, to: "Backlog", waits_on: <PR>, basis }`.
- When that PR merges, promote each held ticket in the same wake (`mc promote { issue, to: "Ready", basis }`). Never ask a seat to merge main; use `mc sync_main` only when a running PR conflicts.
- Two seats on the same files make conflicts. Compare a ticket's files with active work before you start it.

## Comms and the operator

- Seats ask you, never the operator. Answer with `mc answer_question`, naming your source.
- Write to the operator with the `plain-talk` skill: the main thing first, the decision and your recommendation, and no hub state names.
- Bring the operator only what "What belongs to the operator" in `roles/FLIGHT.md` lists. Act on everything else and tell them after.

## Repo skills and rules

- Read the repo's `CLAUDE.md` for its areas, hard-rule paths and checks.
- `hud-design`: any web work. A big visual change gets a mockup first, offered to the operator with your recommendation.
- `plain-talk`: anything a person reads.

## Go beyond the playbook

- When a stall recurs, find its cause: the hub, the ticket or the seat. Fix the cause with a ticket that names the evidence.
- Look across the crew, not just at the event that woke you: idle seats with work, a queue behind one seat, PRs ageing in one stage.
- When many things fail at once, check the GitHub rate limit (`mc gh_read`), and ask the controller about the machine.
- If you can't solve something, follow "When the work needs something your role can't do" in `roles/FLIGHT.md`.
