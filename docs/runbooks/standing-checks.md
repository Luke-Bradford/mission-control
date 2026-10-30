# Standing checks

The jobs and checks that keep the crew's work moving: who does each one today, and the ticket that moves it into hub code. This applies on every machine. FLIGHT works through them each wake (see `roles/FLIGHT.md`, "How you run the crew"). Until the hub does a check itself, the controller runs `scripts/controller-monitor.sh`, which raises each check as a line of text.

The operator's rule (30 Oct 2026): PRs are blockers for other work, so they never wait without an owner and a stated reason. An interruption gets acted on within minutes, not half an hour. The operator gets decisions with a recommendation, not status.

## PR flow

| Check | Trigger | Action | Today | Moves to |
|---|---|---|---|---|
| PR with no run | an open crew PR whose run ended or crashed, for 10 min | resume or restart its seat; if no tool can, record a missing power | FLIGHT, controller (`pr-stuck`) | #1182, #1197 |
| PR parked | a PR's run parked for 10 min | settle it as its park kind allows | FLIGHT, controller (`pr-stuck`) | #1182, #1197 |
| PR ready but not merging | reviewed, CI green, not merged after 5 min | clear it (`merge_pr`), or record what holds it | FLIGHT, controller (`needs-merge`) | #1197 |
| Controller check waiting | a run parked on a controller check | the controller renders or checks it and records the verdict at once | controller (`controller-check`) | #1072 |
| Request to the controller | a FLIGHT item addressed to the controller | act within 15 min | controller (`controller-ask`) | #1182 |
| Work built on an open PR | a ticket whose base code is in an unmerged PR | hold it with `promote { to: "Backlog", waits_on: <PR> }`, and promote it when the PR merges | FLIGHT | #1195 |

## Seats

| Check | Trigger | Action | Today | Moves to |
|---|---|---|---|---|
| Interrupted seat | a run crashed, was interrupted, or ended in error, for 2 min | restart it once; on a second failure, find the cause | FLIGHT, controller (`seat-down`) | #1182 (the hub resumes it itself) |
| Paused or stopped seat with work | a seat paused or stopped for 30 min with work queued | brief the operator with a recommendation; start it only on the operator's word | FLIGHT, controller (`seat-down`) | #1204 |
| Every developer seat idle | all developer seats idle for 10 min with Ready work | find the cause (pause, park, dependency, guard) and clear it | FLIGHT, controller (`idle`) | #1053, #1182 |

## Hub and repo

| Check | Trigger | Action | Today | Moves to |
|---|---|---|---|---|
| Red main | main's CI failed | fix or revert first; PR work waits | FLIGHT | existing signal |
| Merge not live | a PR merged 10+ min ago whose commit isn't in the running hub | refresh `POST /api/version/check`, then Update; confirm the served sha and asset hash | controller | #1182 |
| Hard-rule change merged | a merge touching hard-rule paths | the operator or controller runs Update; never auto | controller | #1070 |
| Orphan branch | a remote branch with no open PR and no live run (not `main`, not `archive/*`) | delete it; the PR page keeps its commits | controller (`branch-orphan`, every 30 min) | #1207 |
| GitHub rate limit | the account's GraphQL or core quota is low, or secondary limits refuse calls | pause heavy reads; look up board items one issue at a time | controller | #1182 (a wake fact) |

## Running the monitor

```sh
MC_REPO=Luke-Bradford/mission-control zsh scripts/controller-monitor.sh
```

- It reads the hub's operator token from `~/.local/share/mission-control/operator-token`, and the hub from `MC_HUB` (default `localhost:7420`).
- It needs `gh` signed in to the account that owns the repo, plus `jq`.
- Run it with zsh (it uses associative arrays). It prints one line per event. Act on each line or route it to FLIGHT.
- Its state files sit beside the token, so a restart re-reads recent FLIGHT notes and doesn't repeat old events.
