# The crew's roles

Each seat runs one role. A role is a prompt (this folder), plus defaults for its model, mode, loop and mc tools (`BUILTIN_ROLES` in `packages/core/src/runtime.ts`). A seat in `config.yaml` names its role, and can override the model, account and area. `crew.roles` in user config adds a role or replaces one.

## Built

| Call sign | Title | What it does | Mode | Default model | Loop | Area |
|---|---|---|---|---|---|---|
| **FLIGHT** | Flight Director: controller | Keeps the work moving. Answers seats' questions, promotes and plans tickets, clears stalls, files gaps, briefs the operator on what is theirs. One per hub. | read-only | Opus | watch | none |
| **GUIDO** | Backend developer | Builds server and core tickets test-first, in its area, and reports for review. | writer | Sonnet | build | `apps/server/**`, `packages/core/**`, `docs/**` |
| **INCO** | Frontend developer | Builds HUD and web tickets test-first, in its area, and reports for review. | writer | Sonnet | build | `apps/web/**`, `docs/**` |
| **FAO** | Planner | Reads a ticket and the code, and writes the `## Plan` a developer builds from. | read-only | Opus | plan | none |
| **RETRO** | Reviewer (QA) | Reviews each PR in a throwaway copy, and sends blocking findings, each with its exact fix, back to the author. Posts `mc/review`. | scratch | Opus | review | none |

## Planned (in the mockup, not built yet)

| Call sign | Title | What it would do |
|---|---|---|
| **AUDIT** | Auditor | Runs a nightly read-only report: why runs cost cycles, with a few evidence-backed proposals (#172). |
| **NETWORK** | Researcher | Answers research tickets from code, docs and the web, citing every claim. |
| **FIDO** | Architect | Plans changes that span areas, and splits them into per-area tickets. |
| **SURGEON** | QA engineer | Writes and runs tests beyond the ticket's own: regression and end-to-end. |
| **BOOSTER** | DevOps | Looks after CI, builds and releases. |

**CAPCOM** is the operator: decisions, approvals, and anything tagged @CAPCOM.

## How work flows

FAO plans → GUIDO or INCO builds → RETRO reviews (findings go back to the author first) → the hub merges once RETRO is clean and CI is green → FLIGHT keeps it all moving.

Lanes (`lane:home` and `lane:work`) decide which machine builds a ticket. Areas decide which seat. See `docs/superpowers/specs/2026-10-22-lightweight-loops-and-lanes.md`.
