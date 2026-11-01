# Standing checks

These are the checks that keep the crew's work moving, on every machine that runs Mission Control. Each one lists what triggers it, what to do, who does it today, and the ticket that moves it into hub code.

The operator's rules (30 Oct 2026):
- A PR blocks the work that depends on it. No PR waits without an owner and a stated reason.
- An interrupted seat gets attention within minutes.
- The operator gets decisions with a recommendation, not status.

FLIGHT works through these checks each wake. Its role prompt (`roles/FLIGHT.md`) points here once PR 1199 merges. Until the hub runs a check itself, the controller runs `scripts/controller-monitor.sh`. It prints one line for each check marked with a line name below. Checks marked "by hand" have no monitor line.

## PR flow

| Check | When | Action | Today | Moves to |
|---|---|---|---|---|
| A crew PR with no run | an open PR on a crew branch (`feature/<n>-…`, `fix/<n>-…`) has had no run for 10 min | resume or restart its seat; if no tool can, record a missing power | FLIGHT; controller (`pr-stuck`) | #1197; #1182 has the hub resume it |
| A PR waiting on a parked run | its run has been parked for 10 min | settle it as the park allows | FLIGHT; controller (`pr-stuck`) | #1197; #1182 wakes FLIGHT at 15 min |
| A PR ready but not merging | not a draft, every check passed (including the hub's review when it posts one), 5 min | merge it, or record what holds it | FLIGHT; controller (`needs-merge`) | #1197 |
| A run waiting on the controller's check | its ticket's Controller check holds it | the controller checks it and records the verdict at once | controller (`controller-check`) | no ticket: the controller's own step |
| FLIGHT asks the controller | an item FLIGHT keeps for itself that names the controller | act within 15 min | controller (`controller-ask`) | #1182 |
| FLIGHT notes for the controller | a FLIGHT "Missing power … For the controller" note | act on it, or log the power on #765 | controller (`flight-note`) | #1180 (FLIGHT gets the power) |
| Work that builds on an open PR | a ticket whose base code is in an unmerged PR | hold it with `promote { to: "Backlog", waits_on: <PR> }`, and promote it when the PR merges | FLIGHT, by hand | #1195 |

## Seats

| Check | When | Action | Today | Moves to |
|---|---|---|---|---|
| A seat that crashed | its run crashed, was interrupted or ended in error, for 2 min | restart it once; on a second failure, find the cause | FLIGHT; controller (`seat-down`) | #1182 has the hub resume it |
| A stopped or paused seat with work | stopped or in a crew pause for 30 min with tickets queued | read who, why and when; verify any recorded resume condition, otherwise brief the operator once with a recommendation | FLIGHT; controller (`seat-down`) | #1204 |
| Every developer seat idle | none working for 10 min while tickets are queued | find the cause (pause, park, dependency, machine guard) and clear it | FLIGHT; controller (`idle`) | #1053 |

## Hub and repo

| Check | When | Action | Today | Moves to |
|---|---|---|---|---|
| Main is red | main's CI failed | fix or revert it first; PR work waits | FLIGHT, by hand | the existing signal |
| A merge not live | a PR merged 10+ min ago whose commit isn't in the running hub | run `POST /api/version/check`, then Update; confirm the served version and page | controller, by hand | #1182 (sweep check) |
| A hard-rule change merged | a merge touching hard-rule paths | the operator or controller runs Update; it never auto-updates | controller, by hand | #1070 |
| An orphan branch | a remote branch with no open PR and no live run, other than `main` and `archive/*` | delete it; the PR page keeps its commits | controller (`branch-orphan`, every 30 min) | #1207 |
| The GitHub rate limit | the account's quota is low, or GitHub refuses calls in bursts | pause heavy reads; look up board items one issue at a time | controller, by hand | #1182 (wake fact) |

## Running the monitor

```sh
MC_REPO=Luke-Bradford/mission-control zsh scripts/controller-monitor.sh
```

- It reads only. The hub's read routes need no token, and `gh` reads as the account it is signed in to. It needs `gh`, `jq` and zsh.
- `MC_HUB` sets the hub (default `localhost:7420`). `MC_DATA` sets the hub's data folder (default `~/.local/share/mission-control`); a preview hub with `MC_DB` elsewhere keeps its files beside that database. `MC_TICK` sets the seconds between passes (default 60).
- Its state files are in `$MC_DATA/controller/`. A restart repeats nothing it has already reported. A seat that fails again is reported again.
- It checks the hub every pass and GitHub every 5th pass, so a hub time above can run one pass late and a GitHub time up to 5 passes late. If the hub stops answering, it prints one `monitor-blind` line and skips whole passes until it answers again. If `gh` stops, it prints one line and pauses the GitHub checks only.
- `idle` is reported once per idle stretch, and an orphan branch once, until it is deleted.
- Act on each line, or route it to FLIGHT.
