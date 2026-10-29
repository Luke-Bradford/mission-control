# Plan: run loop view metadata (#896)

## Files

- `packages/core/src/types.ts`
- `apps/server/src/api.ts`
- `apps/server/test/api.test.ts`

## Acceptance criteria

- [ ] `RunLoopView` includes a run's `startedAt`, nullable `endedAt`, and the CI/rework limits selected for that run.
- [ ] `GET /api/runs/:id/loop` derives those fields from its stored run and profile, independent of the agent's bounded recent-runs response.
- [ ] A completed, older run absent from `/api/agents/:id/runs` still returns its timestamps and profile limits from its loop view.
- [ ] A running run returns `endedAt: null`.
- [ ] Lint, typecheck, changed tests, and build pass.
