# Plan: telemetry reads under one second

Ticket: #2176. Size M.

## Outcome

Each range of `GET /api/telemetry` completes in under one second against a copy of the live
database.

## Scope

- `apps/server/src/store/`: add the index and batched store reads used by telemetry.
- `apps/server/src/repo/files.ts`: read uncached commit line counts in one Git invocation per
  worktree.
- `apps/server/src/api.ts`: group commit-line work by worktree and use the batched reads.
- `apps/server/test/`: prove the indexed ticket lookup, batched line cache lookup, and grouped
  Git read.

## Acceptance checks

- [ ] The ticket start lookup uses an index on the ticket and start time.
- [ ] A telemetry request reads cached line counts in one database query and uncached commits in
  one Git call per worktree.
- [ ] The focused telemetry, store, files, and API tests pass, then the configured checks pass.
