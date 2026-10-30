---
name: flight-ops
description: How FLIGHT runs the crew day to day. Use on every wake, and whenever a seat, PR, ticket, comms item or the hub itself is stuck, slow or unclear.
---

# FLIGHT operations

Your job: keep every seat unblocked and the work flowing to merged, live code. Think like the lead engineer at the controls. Read the whole system, find the real cause, fix it, then make sure it can't recur. The checks below are the floor, not the ceiling. When something doesn't fit them, investigate: read the code, the logs and the data, and solve it.

## Where to look

| To know | Read |
|---|---|
| What each seat is doing, its run, queue, park text | `GET /api/crew` (`rows[].loop`, `asideRuns`, `queue`, `stateSince`) |
| Your own decisions, wake reasons, notes | `GET /api/flight` |
| What waits on the operator or you | `GET /api/attention` (`brief.for`) |
| What seats said | `GET /api/comms`, `/api/comms/agents/<seat>` |
| Review findings, rounds, tests | `/api/qa`, the reviews tables, RETRO's PR comments |
| Recurring failures and costs | `/api/audit`, `/api/telemetry` |
| Is the hub on the merged code | `POST /api/version/check`, then compare `sha` with main |
| The standing checks and their thresholds | `docs/runbooks/standing-checks.md` |
| How to do anything by hand | `docs/runbook.md` |

The HUD pages show the same data: Overview (crew, pipeline, live log), Board, Agents, FLIGHT, QA (PR readiness), Comms, Map, Telemetry, Audit, Setup (version, Update and its log).

## Order of each wake

1. Red main or a broken gate: fix or revert it first.
2. Open PRs: every one has an owner and is moving (see the playbook).
3. Stuck and failed runs, interrupted seats.
4. Comms: answer every seat question; settle what is resolved.
5. Needs you: settle, act on, or brief each item. The operator gets only the decisions that are theirs, with your recommendation.
6. Free seats: promote and start work, respecting dependencies.
7. Audit: when the same failure appears twice, file or fold a ticket that removes the cause.

## Playbook: what a stop means and how to clear it

| The run says | Cause | Clear it |
|---|---|---|
| `the push or PR for <sha> has not shown up … checks … not run on this commit` | the seat committed after running its checks | have the seat run `pnpm -s lint && pnpm -s typecheck` on the newest commit, then push; lift the park |
| `PR #N has head <a>, not <b>` | the hub's PR copy is stale | once GitHub shows `<b>` as the head, lift the park |
| `an earlier PR is open on this branch` | another seat's ended run opened the PR | a seat continues only its own PR: close the old PR (its branch carries on), then lift; or hand the ticket back to the first seat |
| `could not create a worktree for <branch>` | an ended run's worktree still holds the branch | remove that worktree if it is clean (`git worktree remove`; the branch and unpushed commits stay), then start again |
| `conflicts with main` | main moved under the PR | `sync_main`; the seat resolves; lift if the seat already resolved it and can't push |
| `RETRO-… found blocking issues in 3 reviews` | review round cap | new findings: grant another round with the exact fixes; the same findings repeating: narrow the ticket to what the PR ships, move the rest to tickets |
| `controller check on <sha>` | the ticket asks for evidence | produce it (render the page, run the check), then record the verdict |
| `run ended (the process crashed)` / interrupted | crash or interruption | restart once; on a second failure, read why before restarting |
| `stopped after 3 carry-on resumes without reporting` | the seat lost the thread | message the exact next step (often "push and report"), then lift |
| a ticket In review or In progress with no run | its run ended | start it on its branch; clear what blocks the start (worktree, old PR) |
| a PR green and reviewed, not merging | a clearance or hold | clear hard-rule merges after reading the hunk; merge |
| merged, not live | auto-Update held (hard-rule change) or a stale version cache | `POST /api/version/check`, then Update; confirm the new sha is served |

When a stop isn't here, read the engine's code for its text (`rg` the message in `apps/server/src`), find what clears it, act, and add the row here.

## Dependencies and conflicts

- Work that builds on an unmerged PR waits: hold it with `promote { to: "Backlog", waits_on: <PR> }`, and promote it when the PR merges.
- Two seats on the same files make conflicts: compare a ticket's files with active work before you start it.
- When a dependency merges, release its dependents in the same wake and tell their seats to merge main.

## Comms and the operator

- Seats ask you, never the operator. Answer with the source of your answer.
- Write to the operator with the plain-talk skill: the main thing first, the decision and your recommendation, no hub jargon.
- Bring the operator only what the repo rules or direction give them. Act on everything else and tell them after.

## Repo skills and rules

- Read the repo's `CLAUDE.md` for its areas, hard-rule paths and checks. Hard-rule changes need clearance before merge, and an Update by the operator or a controller after.
- `hud-design`: any web work. Mockups follow research and a plan the operator has seen.
- `plain-talk`: anything a person reads.

## Think beyond the playbook

- A stall that recurs is a hub bug: fix the cause with a ticket that names the evidence, not the symptom.
- Look across the crew, not just at the event that woke you. Check for idle seats with work, a queue behind one seat, and PRs ageing in one stage.
- Check the machine and the GitHub rate limit when things fail together.
- If you can't solve something, say exactly what you tried and what you need.
