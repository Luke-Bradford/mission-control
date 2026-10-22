# mission-control

A local hub for configuring, running and supervising AI coding agents across repos. Plan 1
(observe) watches the existing autonomous loops on this Mac and shows their runs, account limits,
GitHub boards and escalations in one web app at `http://127.0.0.1:7420/`. It does not change how
the loops run.

```sh
pnpm install && pnpm build
# configure ~/.config/mission-control/config.yaml (see the runbook), then:
pnpm --filter @mc/server start
```

- **Runbook:** [`docs/runbook.md`](docs/runbook.md) covers install, configuration, running and the launchd job, plus known limits and the first real-run verification.
- **Design spec:** [`docs/superpowers/specs/2026-10-17-mission-control-design.md`](docs/superpowers/specs/2026-10-17-mission-control-design.md)
- **Plan 1:** [`docs/superpowers/plans/2026-10-17-plan-1-observe.md`](docs/superpowers/plans/2026-10-17-plan-1-observe.md)

Layout: `apps/server` (Fastify API and collectors), `apps/web` (React UI), `packages/core` (shared
types and logic), `ops/` (launchd template).

Checks: `pnpm lint && pnpm typecheck && pnpm test`.
