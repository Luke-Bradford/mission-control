# Outcome-based seat guards

## Decision

Seat guards constrain outcomes, not ordinary development commands. The operator's hard gates are:

- OS/profile controls prevent secrets, home-folder reads and access to other seats' worktrees.
- Read-only repositories cannot be written; writers stay inside their assigned area.
- Git writes use the mc commit and sync tools.
- Seats have no network or GitHub CLI access.
- Detached/background commands are refused so work stays attached to its current tool call.
- Full test runs, including proportionate reviewer runs, serialize through the shared test lock.

Codex sends ordinary commands to the shared guard and then its OS sandbox. Claude exposes broad Bash inside the equivalent sandbox and uses the same guard hook. The role prompt explains the workflow and available Mission Control tools; it is not a command allowlist.

## Test plan

- Prove ordinary local commands reach the sandbox.
- Retain coverage for each hard gate and Git hardening.
- Run lint, typecheck, changed tests, build, and the full suite.

## Rollout

- Merge and deploy through Mission Control's normal operator-controlled Update flow; Mission Control does not restart itself.
- Watch guard-refusal telemetry for seven days. Success means zero refusals for ordinary read-only local commands while the retained hard gates continue to fire in their covered cases.
- If an ordinary local read is refused, capture the bounded command excerpt and correct the parser or approval path without weakening a hard gate.
- If a retained hard gate regresses, stop the rollout, revert the guard change and escalate with the failing command and rule.
