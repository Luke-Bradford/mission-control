# Plan: telemetry tickets in progress

Ticket: #1983. Size M.

## Outcome

`GET /api/telemetry` returns the last 14 local calendar days of tickets in progress. Each value
is the count at that day's end; today's value is the count at read time. Days before the stored
history begins are `null`.

## Scope

- `packages/core/src/types.ts` and `packages/core/src/views.ts`: type stored column moves and the
  telemetry series.
- `apps/server/src/collectors/flow.ts`: retain observed board-column moves with each stored flow
  read.
- `apps/server/src/store/schema.ts`, `apps/server/src/store/migrations.ts`, and
  `apps/server/src/store.ts`: persist and read those moves.
- `apps/server/src/telemetry/telemetry.ts`: calculate the local 14-day end-of-day series without
  network or git access.
- `apps/server/test/telemetry.test.ts`, `apps/server/test/flow.test.ts`, and
  `apps/server/test/store.test.ts`: prove the read and persisted source history.

## Acceptance checks

- [ ] Seeded moves give the right end-of-day counts, including an enter-and-leave on one day and
  a day before history that is `null`.
- [ ] The telemetry read uses only Store methods and does no network or git work.
- [ ] `pnpm -s lint`, `pnpm -s typecheck`, `pnpm -s test`, `pnpm -s build`, and `pnpm -s vitest`
  pass at the committed revision.
