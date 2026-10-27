# Outcome-based seat guards

## Decision

Seat guards constrain outcomes, not ordinary development commands. The operator's hard gates are:

- OS/profile controls prevent secrets and home-folder reads.
- Read-only repositories and other lanes cannot be written.
- Git and GitHub writes use the PR tools.
- Seats have no network access.
- Full test runs serialize through the shared test lock.

Codex permits commands within its OS sandbox except for a small denylist: Git write subcommands, `gh`, background jobs, and full-suite commands that bypass the test lock. Claude exposes broad `Bash` within its sandbox and applies the same denylist in its guard hook. RETRO may use the full suite through the test lock.

## Rollout

Deploy by updating Mission Control to the merged commit and restarting the hub through the normal operator procedure. For the following seven days, inspect guard-refusal telemetry daily and keep the hard-gate tests in CI. Success requires zero refusals for ordinary command reads; refusals for Git or GitHub writes, network access, background commands, cross-seat writes, and lock-bypassing suites remain expected.

If any hard gate regresses, stop rollout, restore the previous hub revision, and escalate the guard hit and reproduction to the operator. If ordinary-read refusals persist during the week, capture the command and approval event, then escalate it for a targeted guard correction rather than restoring a command allowlist.

## Test plan

- Prove ordinary read commands are allowed.
- Retain coverage for each hard gate and Git hardening.
- Run lint, typecheck, changed tests, build, and the full suite.
