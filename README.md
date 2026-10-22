# mission-control

An ops room for a crew of coding agents. A local hub runs agent seats (planner, devs, QA reviewer
and FLIGHT, the head agent) against a GitHub repo and its project board. It watches existing
autonomous loops, and shows runs, account limits, boards and questions in one web HUD at
`http://127.0.0.1:7420/`.

```sh
pnpm install && pnpm build
# configure ~/.config/mission-control/config.yaml (see config.example.yaml and the runbook), then:
pnpm --filter @mc/server start
```

- **Runbook:** [`docs/runbook.md`](docs/runbook.md) covers install, configuration, running, the first crew and known limits.
- **Design:** [`docs/superpowers/specs/2026-10-18-mission-control-design.md`](docs/superpowers/specs/2026-10-18-mission-control-design.md), with the build loop and FLIGHT in [`2026-10-20-build-loop-flight-design.md`](docs/superpowers/specs/2026-10-20-build-loop-flight-design.md).
- **The MVP target:** the HUD mockup [`docs/prototype/mission-control-hud.html`](docs/prototype/mission-control-hud.html) and its [catalogue](docs/prototype/mission-control-hud-catalogue.md).
- **Seat roles:** [`roles/`](roles/) (GUIDO dev, INCO web dev, FAO planner, RETRO reviewer, FLIGHT).
- **Contributing:** [`CONTRIBUTING.md`](CONTRIBUTING.md).

Layout: `apps/server` (API, collectors, crew runtime and engine), `apps/web` (React HUD),
`packages/core` (shared types and logic), `roles/` (seat prompts), `ops/` (launchd template).

Checks: `pnpm -s lint && pnpm -s typecheck && pnpm -s test && pnpm -s build`.
