# Plan: FLIGHT status-band numbers

Ticket: #1588. Size M.

## Outcome

`GET /api/flight` returns typed hourly cost, hourly session starts, and the live FLIGHT run's
start time. Missing source records return `null`, never a substituted zero.

## Scope

- `packages/core/src/flight.ts`: add the three `FlightView` fields and their null contract.
- `apps/server/src/flight/cost.ts`: calculate the hourly API-equivalent cost from the same run
  usage records as `wakeCost`.
- `apps/server/src/flight/state.ts`: assemble the hourly figures and live-run start time.
- `apps/server/test/api.test.ts`: fixed-record route coverage for values and no-data nulls.

## Acceptance checks

- [ ] The route serves `costLastHour`, `sessionsLastHour`, and `runStartedAt`, and core types
  expose them.
- [ ] Fixed records prove the last-60-minute cost and session-start count.
- [ ] A FLIGHT seat with no qualifying data receives `null` for all three fields, not `0`.
- [ ] `pnpm -s lint`, `pnpm -s typecheck`, and `pnpm -s test:related` pass at the committed
  revision.
