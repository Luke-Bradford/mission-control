# Mission Control

The operator's ops room for a crew of coding agents: FLIGHT (head agent) runs the crew, the operator is CAPCOM.
Renamed from Control Centre on 2026-10-18.

## Source of truth

- Spec: `docs/superpowers/specs/2026-10-18-mission-control-design.md`.
- Build loop and FLIGHT: `docs/superpowers/specs/2026-10-20-build-loop-flight-design.md` (the target). Built:
  Plan 7a (`docs/superpowers/plans/2026-10-21-plan-7a-engine-board.md`), RETRO reviews with rework rounds (7b-1),
  FLIGHT 2 (answers seats' questions, starts tickets in `draft` repos), FLIGHT 3 (the hub keeps FLIGHT running and
  wakes it) and a dev's seat freed at review. Not built yet, among others: the merge step (#66, #68, #69), the Done
  move (#50), promotion and planner starts (#70, #71), 7a+'s templates, checks and escalation, and 7d.
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

There is no review bot on this repo. Every PR is reviewed by a fresh agent (task reviews plus a
final whole-branch review on the most capable model) before merge; the operator's standing go-ahead
stands as approval once that review is clean and CI is green.

## Checks

`pnpm -s lint && pnpm -s typecheck && pnpm -s test && pnpm -s build` before any PR.

## Mission Control

How the build loop treats this repo's board. Seats pick tickets from Ready, highest Priority first,
oldest first within a Priority, matching their area labels; FLIGHT may promote complete Backlog
tickets to Ready. Hard-rule files (the ones that confine or drive the crew, plus this file,
`.github/**` and `config.example.yaml`) never auto-merge or auto-Update; the operator merges and updates
those. The hub reads the block below at `origin/HEAD`, so a change here takes effect once merged and
fetched.

```yaml
mc:
  pick_from: [Ready]
  promote_backlog: true
  needs: [done_when, size]
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
  hard_rules: null
  ci: null
  always_ask: []
```
