# Plan: FLIGHT extra review rework round

## Plan

- [ ] Add a focused FLIGHT tool test proving a capped review park can be reworked once, carries an optional fix note to the author, and resumes the run.
- [ ] Record a single per-head rework grant in the loop state and have the review-cap calculation honour it only for that head.
- [ ] Refuse a repeat grant for that head with controller guidance, while preserving budget, ruling and operator-hold refusals.
- [ ] Update the `settle_park` tool contract and runbook guidance.
- [ ] Run the affected test, lint, typecheck, changed-test suite, and build.
