# Plan: FLIGHT controller decisions (#1079)

## Files

- `packages/core/src/flight.ts`
- `apps/server/src/flight/ledger.ts`
- `apps/server/src/flight/state.ts`
- `apps/server/test/api.test.ts`

## Acceptance criteria

- [ ] `GET /api/flight` returns every last-24-hour decision matching `For the controller:` in `controllerDecisions`, newest first.
- [ ] The main `decisions` list remains capped by `FLIGHT_VIEW_LIMIT`.
- [ ] A matching decision older than 24 hours is neither counted nor returned in `controllerDecisions`.
- [ ] `metrics.forTheController` and `controllerDecisions` use the same match rule and bounded scan.
- [ ] Lint, typecheck, changed tests, and build pass.
