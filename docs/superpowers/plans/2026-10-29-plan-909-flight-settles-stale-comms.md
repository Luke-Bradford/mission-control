# Plan: FLIGHT settles stale Comms (#909)

## Files

- `apps/server/src/store.ts`
- `apps/server/src/flight/tools.ts`
- `apps/server/test/flight-tools.test.ts`
- `apps/server/test/hud.test.ts`
- `docs/runbook.md`

## Acceptance criteria

- [ ] FLIGHT can use `dismiss_item` with a reason to settle only a `comms-open:` question or blocker.
- [ ] A settled Comms item no longer appears in attention, does not contribute to the FLIGHT-not-triaging aggregate, and cannot re-escalate.
- [ ] Labelled messages older than the rollout cutoff do not create a Comms-open item.
- [ ] `dismiss_item` still refuses guard, budget, approval, operator-decision, and other protected item kinds.
- [ ] The tool description and runbook explain the Comms settlement path.
- [ ] Lint, typecheck, changed tests, and build pass.
