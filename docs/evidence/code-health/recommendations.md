# Code-health recommendations: one row per cause

Each recommendation row names one change for one cause.

- **Cause:** `causeId`. Recurring corrections group by the reviewer-recorded lineage (category, summary, fix), so one cause across files is one row. File or category equality alone never merges rows, and findings of one cause that are reworded between PRs do not group.
- **Title:** from the recorded fix or a concrete rule (file size: the line threshold, lines now, merged-PR touches).
- **Measure now:** `measure.current` with unit, window, source time and coverage. For recurring corrections it is the count of unresolved findings at the exact reviewed head. Only open findings count; a logged Minor never blocks. A head that changed without a matching review is `null` (unknown), never zero.
- **Target:** `target.value` with its source and policy. Recurring corrections use the existing clean-review target of zero. Rules with no recorded numeric target (repeated review rounds, missing collection) carry `null` and name the missing prerequisite.
- **Decider:** `decision.owner` and `decision.tier`. FLIGHT may accept only the rules in `CODE_HEALTH_FLIGHT_TIER_RULES`; accepting records a proposal and grants no permission to restart a capped ticket, change a guard or start out-of-plan work.
- **Re-measure:** once, after the accepted review date, against the immutable accepted baseline and its own metric (a record accepted before lineage existed keeps its category-and-file count). A changed head with no review yet is retried for 7 days, then recorded as unmeasured. Otherwise the result is improved, unchanged or worse.
