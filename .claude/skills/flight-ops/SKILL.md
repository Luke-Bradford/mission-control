---
name: flight-ops
description: FLIGHT only. Use when a seat, PR, ticket, comms item or the hub is stuck, slow or unclear, and after a context reset.
---

# FLIGHT operations

Your job: keep every seat unblocked, and keep the work flowing to merged, live code. Find the real cause of a stall, get it fixed through a tool, a seat or a ticket, and stop it recurring. The playbook below is the minimum. When a stall doesn't fit it, investigate: read the code in your checkout, the CI logs and `mc flight_state`, then solve it.

`roles/FLIGHT.md` sets the order of each wake ("How you run the crew") and what is not yours. Where this skill or its reference files and the role differ, the role wins.

## Reference files

Each is in this folder. Read one when its situation arises, not every wake.

| File | Read it when |
|---|---|
| `digest.md` | a wake's format is unclear, or before you call `mc flight_state` |
| `stalls.md` | a run is parked, crashed or in error, a seat waits, or a PR is stuck, conflicting or ready to merge |
| `seats-and-board.md` | a seat is free, before a start or promotion, or a card's fields, lane or body need changing |
| `triage.md` | `items` holds anything, or you pass an item up or dismiss one |
| `tickets.md` | before you fold work into a ticket or file one |
| `ledger.md` | you reconcile the ledger, or write the brief or headline |
| `retrospective.md` | you write or remove a repo note, or the daily `retrospective` arrives |

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

Unparks share a limit of two per run. Some stops need a power you don't have yet (#1214 tracks them). For those, record `Missing power: <action>. For the controller:` once with `mc log_decision`, track it, and move the seat on to its next Ready ticket. Use `mc start_seat` for that, never on a stopped or paused seat without the operator's word. In a merge workspace the hub deals the work, except to a seat in `error`, which you start; your part is to promote.

| The run says | Cause | Clear it |
|---|---|---|
| `have not all passed on this exact commit` | a check listed in the refusal is missing or failed on the head | the hub has already told the seat. If it hasn't acted, `mc message_seat` with the commands the refusal lists. When the seat says it ran them on the head, lift with `mc settle_park { action: "lift" }`. A parked run never pushes, so the engine retries the push only after the lift |
| `PR #N has head <a>, not <b>` | the hub's copy of the PR is stale, or the push hasn't landed | check the head with `mc read_pr`. Once it shows `<b>`, `mc settle_park { action: "lift" }` |
| `an earlier PR is open on this branch` | another seat's ended run opened the PR; a seat continues only its own | record `Missing power: close PR #N, or give its ticket back to the seat that opened it. For the controller:` once, and move the seat on |
| `could not create a worktree for <branch>` (a `start_seat` refusal) | an ended run's worktree still holds the branch | record `Missing power: remove the clean worktree holding <branch>. For the controller:` once, and move the seat on |
| `conflicts with main` | main moved under the PR | `mc sync_main { runId }`. If the seat already resolved it and can't push, `mc message_seat { unpark: true }` |
| `found blocking issues in` | the review-round cap | new findings: `mc settle_park { action: "rework", note }`. The same findings again: ask the planner (`mc comment_ticket`) to narrow the ticket, file the rest, then `mc settle_park { action: "accept" }` |
| `controller check on <sha>` | the ticket asks for evidence only the controller produces | the controller's to settle. Tell the controller once with a labelled `mc comms_send` (PR ref). It is already in Needs you. Never `end_run` it |
| `run ended (the process crashed)` / interrupted | a crash | the run has ended: its park can't be lifted or unparked, and no tool resumes it. Record `Missing power: resume PR #N on <seat>. For the controller:` once (with no PR: `re-queue #N (run crashed)`), and move the seat on. On a second failure of the same seat or ticket, read why first |
| `stopped after 3 carry-on resumes without reporting` | the seat lost the thread | `mc message_seat { unpark: true, text }` with the exact next step (often "push and report") |
| a ticket In review or In progress with no run | its run ended with a PR open | record `Missing power: resume PR #N on <seat>. For the controller:` once. Never start a different seat on it while that PR is open |
| a PR that changes what confines seats (`apps/server/src/guard/**`, `packages/core/src/guard.ts`, `packages/core/src/runtime.ts`, `packages/core/src/path-grants.ts`, `codex-floor.ts`, `codex-approval.ts`, `grants.ts` and `toolchain.ts` under `apps/server/src/runtime/`, and the push gate in `apps/server/src/mcp/tools.ts`) | the controller checks it before merge | Add an item under `## Controller check` with `mc add_controller_check` first; the engine then parks the PR for the controller. Read the hunk and clear it with `mc merge_pr`; a merge hold would block the controller's verdict from reaching the seat. Clear every other hard-rule PR yourself, your own tools and the engine included, once a review on the most capable model is clean. The Mission Control block in `CLAUDE.md` and `.github/**` are the operator's; `roles/**` and `.claude/**` are never yours either |
| a PR green and reviewed, not merging | it waits on clearance | `mc merge_pr` for an `awaiting-flight` PR in your lane, after reading the hard-rule hunk. Not yours: `roles/**`, `.claude/**`, `.github/**`, the Mission Control block in CLAUDE.md, operator holds, controller checks |
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
