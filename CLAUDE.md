# Mission Control

The operator's ops room for a crew of coding agents: FLIGHT (head agent) runs the crew, the operator is CAPCOM.
Renamed from Control Centre on 2026-10-18.

## Source of truth

- Direction (why and how to choose, for FLIGHT and every seat): `docs/direction.md`.
- Spec: `docs/superpowers/specs/2026-10-18-mission-control-design.md`.
- Build loop and FLIGHT: `docs/superpowers/specs/2026-10-20-build-loop-flight-design.md` (the target). Built:
  Plan 7a (`docs/superpowers/plans/2026-10-21-plan-7a-engine-board.md`), RETRO reviews with rework rounds (7b-1),
  FLIGHT 2 (answers seats' questions, starts tickets in `draft` repos), FLIGHT 3 (the hub keeps FLIGHT running and
  wakes it), a dev's seat freed at review, the merge step, the Done move, promotion and planner starts. Not built
  yet: 7a+'s templates, checks and escalation, and 7d.
- The MVP is the HUD mockup: `docs/prototype/mission-control-hud.html`, catalogued verbatim in
  `docs/prototype/mission-control-hud-catalogue.md`. Build what they show; sample work data in them
  (repos, people, Windows paths) is illustration only.
- Older Control Centre specs and plans in `docs/superpowers/` are history; the Mission Control spec
  wins where they differ.

## Rules specific to this repo

- Observed loops configured in `config.yaml` are read-only: never stop, pause, restart or modify
  them, their launchd jobs or their worktrees unless the operator asks in the moment.
- Never stop or restart a running hub to test something: preview on a free port with
  `MC_PORT=<port>`, `MC_DB=<copy of the DB>` (copy with `sqlite3 <db> ".backup <copy>"`) and
  `MC_NO_LOOP_WRITES=1` (Pause/Resume answer 409, so the preview never writes into a live loop).
- Deployment-specific rules (which loops are live here, the hub's launchd job and port) belong in
  an uncommitted `CLAUDE.local.md`.
- Mission Control never restarts itself; merged changes go live when the operator updates.
- Agents act on GitHub under the operator's account. The only GitHub writes the server makes are the ones
  the spec allows; anything new that writes to GitHub needs a security note in its PR.

## Review

There is no review bot on this repo. Every PR is reviewed by a fresh agent (RETRO, or a fresh
reviewer) before merge, and the operator's standing go-ahead stands as approval once that review is
clean and CI is green.

- **Small changes** (Size XS or S, or a `chore`, `test` or `docs` ticket): one review pass is enough,
  on any capable model.
- **Features, bug fixes and anything Size M or larger:** the final whole-branch review runs on the most
  capable model.
- **Tech sweeps:** periodic sweeps catch what a light review missed.

## Skills

The repo's skills are in `.claude/skills/`. Load the one that fits the work; the roles point to them.

- `hud-design`: any plan, build or review that touches `apps/web`.
- `plain-talk`: any text a person reads (a Comms message, a ticket, PR text, a review finding, a run report, a Needs-you brief).
- `flight-ops`: FLIGHT loads it when a seat, PR, ticket or the hub is stuck or unclear, and after a context reset; its reference files cover each situation.

## Checks

Seats run the `checks` in the Mission Control block below; the push gate requires them, and CI runs the full suite.
A PR made outside the crew also runs `pnpm -s test && pnpm -s build` first.

## Mission Control

How the build loop treats this repo's board. Seats pick tickets from Ready, highest Priority first,
oldest first within a Priority, matching their area labels; FLIGHT may promote complete Backlog
tickets to Ready. Hard-rule files (the ones that confine or drive the crew, plus this file,
`.github/**` and `config.example.yaml`) need FLIGHT clearance on superuser repos before the engine merges;
standard repos keep their operator/controller merge path. CI workflows and this Mission Control block
still need the operator, with one exception: the controller may narrow or revert a change to this
block that it made itself when that change breaks the crew, and tells the operator after.
Hard-rule changes never auto-Update; the operator or controller runs Update.
The hub reads the block below at `origin/HEAD`, so a change here takes effect once merged and fetched.

```yaml
mc:
  pick_from: [Ready]
  promote_backlog: true
  needs: [done_when, size]
  checks: ["pnpm -s lint", "pnpm -s typecheck"]
  templates:
    "type:feature": feature
    "bug": bugfix
    "chore": small-change
    "test": small-change
    "docs": small-change
    "research": research
  areas:
    "area:server": ["apps/server/**"]
    "area:web": ["apps/web/**"]
    "area:core": ["packages/core/**"]
  hard_rules:
    - "apps/server/src/away.ts"
    - "apps/server/src/guard/**"
    - "apps/server/src/mcp/**"
    - "apps/server/src/runtime/**"
    - "apps/server/src/engine/**"
    - "apps/server/src/flight/**"
    - "apps/server/src/update.ts"
    - "apps/server/src/config.ts"
    - "apps/server/src/crew-apply.ts"
    - "packages/core/src/away.ts"
    - "packages/core/src/guard.ts"
    - "packages/core/src/flight.ts"
    - "packages/core/src/runtime.ts"
    - "packages/core/src/loop.ts"
    - "packages/core/src/review.ts"
    - "packages/core/src/repo-rules.ts"
    - "packages/core/src/flight-model.ts"
    - "packages/core/src/guard-model.ts"
    - "packages/core/src/review-model.ts"
    - "packages/core/src/runtime-model.ts"
    - "packages/core/src/repo-rules-model.ts"
    - "packages/core/src/rule-paths.ts"
    - "packages/core/src/loop-shared.ts"
    - "loops/**"
    - "roles/**"
    - "CLAUDE.md"
    - ".github/**"
    - "config.example.yaml"
    - ".codex/**"
    - ".claude/**"
  ci: null
  always_ask: []
```
