# Plan: QA API review rounds

## Plan

1. Extend the QA findings read model and response with the stored review-round summaries for each PR.
2. Keep findings in the selected history window, except unresolved findings on PRs whose current snapshot is open.
3. Prove the endpoint retains an old unresolved finding on an open PR, excludes an old resolved finding, and returns clean and failing rounds with their verdicts and counts.
4. Update the QA runbook entry with the response and retention rules.

## Acceptance criteria

- [ ] An unresolved finding older than 90 days on an open PR is returned.
- [ ] A resolved finding of the same age is not returned.
- [ ] A clean review round and a failing review round both return their round, head SHA, verdicts, blocking count, minor count, and time.
- [ ] Lint, typecheck, affected tests, full tests, and build pass.

## Files

- `apps/server/src/store.ts`
- `apps/server/src/api.ts`
- `apps/server/test/api.test.ts`
- `packages/core/src/views.ts`
- `docs/runbook.md`
