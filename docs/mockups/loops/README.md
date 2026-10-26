# Loops and Agent views: build targets (operator-approved 26 Oct 2026)

- `loop-chain.html` — **Setup › Loops**: a loop as one horizontal chain generated from its config. Each step shows who runs it and its gate (what must be true to move on). Every failure goes back no further than Build, on nested return paths that never cross (CI fail ≤3, review changes ≤3, and a real file conflict after a merge sync). At any cap FLIGHT decides (re-plan, reassign, split, or ask CAPCOM). "With run" overlays one ticket's position, the return paths it used and their counts. The re-plan path (design wrong → Plan, ≤1, via FLIGHT) is proposed, not built.
- `run-trace.html` — the full trace of one run: the loop with edge counts, a step-by-step timeline, tokens per step, stop rules against caps, and what comes next. Used by the audit seat and for debugging a ticket.
- **Agent page** (no separate mockup): a cut-down version of the chain as a vertical checklist: the steps, the direction of what is coming up, and time and tokens per step and per loop. Each visit is a line, so going back to Build shows as a new line and repeats are counted (see the checklist panel in `loop-chain.html`).
- `research.md` — what Anthropic and the graph-engineering write-ups say about loops and graphs, and what it means here.

Today's loop behaviour, from the hub: Plan (Sizes M, L and XL unless the repo sets `planRequired: false`; gate: the ticket has `## Plan`) → Build (developer seat holds the ticket; gate: evidence reported) → CI checks (gate: required checks green; on fail back to Build; `CI_TRIES` = 3) → Review (RETRO, fresh seat; on changes back to Build; `REVIEW_ROUNDS` = 3) → Merge (engine; on a conflict the run parks for FLIGHT and the hub syncs with main: a clean sync goes back to CI, a real file conflict to Build) → Done. At a cap the run parks for FLIGHT.

Pages load D3 (and ELK in run-trace) from jsDelivr with SRI hashes, and fonts from Google Fonts, only when opened.
