# Full-model rule for moved hard-rule reviews

This completes the remaining model-selection requirement of ticket #1596. PR #1655 delivered
queued-review movement, target checks, a durable P0 forecast-brake pass and the Size M rule.
Native review 1366 recorded an overall pass and one late Minor, but its detailed specification
and new-behavior checks explicitly failed for a small hard-rule review. The normal merge
completed before the controller hold request; the refused hold and ended original run are
retained as history. The ticket was reopened rather than treating that missing requirement as done.

## Behavior

The supervisor uses the author's existing hard-rule touch fact only when it names the review's
exact source head and has at least one path. That fact takes precedence over a light profile,
small size or docs/chore label. Claude takes the existing full-model branch; Codex keeps the
configured review-seat model through that same branch. External and second reviews already use
that branch. Stale or empty touch facts keep the ordinary model-selection behavior.

The same head-bound fact is still included in the review brief. No target assignment, verdict,
account threshold, forecast policy, permission, installer trust or observed-loop behavior changes.
This enforces the full-model rule the repository and ticket already require.

## Regression evidence

On unchanged production-source baseline `d1ddc28ea9a66629ebdb723683c4ce17f604410a`, the new
process-backed cases fail for both Size S docs and chore reviews moved to a seat with a light
model: the launched run records `haiku` instead of the required `opus`. The stale-head and
empty-path controls pass on that baseline. All four pass with the supervisor correction.

Each case checks the initial persisted model and the actual fake-provider CLI `--model` argument;
the target's default model differs from the full model. These are real supervisor process tests,
not a standalone imitation of the model expression. The initial four-case filter skips the other
93 cases by selection; it does not substitute a sandbox capability skip for execution. The
existing Size M, profile, external, second-review and Codex cases remain in the complete suite.

Full committed-head lint, types, tests and build, exact-head CI and a fresh most-capable review
are required before this correction merges. The parent ticket remains open until those checks
prove the complete requirement. No live seat or immutable earlier review is changed for the proof.
