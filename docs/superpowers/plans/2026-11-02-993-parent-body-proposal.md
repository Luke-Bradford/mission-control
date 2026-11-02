# Proposed replacement body for #993

Draft only. Root/controller files the children and replaces their tokens before any GitHub write.

## Outcome

The operator gives FLIGHT a global standing order in plain words from the FLIGHT page.
Examples: "one builder at a time until the machine guard lands", "QA page before more Map lenses",
or "no Codex reviews this week". Each order is saved, numbered, dated and visible until revoked.
Every FLIGHT wake carries active orders after direction and before memory.
When an order changes a promotion, hold, split or pick order, FLIGHT logs a linked `re-plan` decision.

This parent also includes #763, folded on 31 October: operator or FLIGHT instructions to a named seat.
They are saved, dated, revocable and placed after that repo's CLAUDE.md and AGENTS.md.
The operator sees and edits them on Agent and FLIGHT's Crew view.
Global operator orders outrank memory and seat instructions; operator seat entries outrank FLIGHT entries.
Only the operator can revoke an operator entry. Revoked history stays readable from old decisions.

## Why

The operator asked on 29 October to talk to agents and change the workstream through FLIGHT.
One-time messages and mutable repo memory do not provide durable, visible orders or a record of their effect.
The 31 October closure was an MVP deferral, not delivery. Both instruction panels still say unavailable
in apps/web/src/flight/KnowsTab.tsx:5–23 at source baseline f7ee4e26.

#763's old statement that focus lacks UI is obsolete. Queue focus already has UI and persistent selectors.
Keep that behavior and bring its author/clear/precedence paths into the shared instruction model.
Do not rebuild focus or count it as delivered plain-language standing instructions.

## What to change

Keep this card as the P1 feature parent. Deliver two children with one area label each:

1. Server/core/runtime, Size L: shared durable store, protected APIs, FLIGHT seat tools/audit/notices,
   focus compatibility, verified direction and every-wake injection, typed re-plan references.
2. Web, Size M, depending on the server child: replace Knows placeholders, status-strip visibility,
   Agent/Crew instruction readers and actions, focus provenance and decision/history links.

The concrete repo plan is docs/superpowers/plans/2026-11-02-plan-993-standing-orders.md.
Global orders remain global; do not invent cross-repo restrictions contrary to #1214.
Use existing seat/session authority and authenticated declared provenance.
Header presence remains FLIGHT provenance after common validation, including when its run ends during parsing.
The UI preserves its current hierarchy and shared form patterns. Major visual changes need a mockup first,
as the repo already requires. Coordinate Agent/form files with #1361 and #1362.

## Done when

- [ ] Global orders and seat instructions have stable IDs, authors, dates, immutable replacement and retained revoked history.
- [ ] Operator-only order writes and protected seat-entry revocations are enforced through supported authenticated APIs/tools.
- [ ] FLIGHT has only seat instruction tools, with one visible audit decision per change and a durable notice to a live/busy seat.
- [ ] Every initial, repeated, rotated, resumed and operator-message FLIGHT wake includes all active orders after verified direction, before memory.
- [ ] New/revoked orders trigger a wake; failed delivery retries without losing orders or creating an unchanged-order wake loop.
- [ ] Seat instructions follow repo CLAUDE.md/AGENTS.md on start/resume; operator entries outrank FLIGHT's and all safety floors remain binding.
- [ ] Existing focus UI/API/selectors work through shared precedence, including operator null clears, config migration/reload and all queue rechecks.
- [ ] A typed re-plan decision references a saved global order and remains readable after revocation.
- [ ] FLIGHT status/Knows and Agent/Crew show dated entries and add/edit/revoke actions, with meaningful failure and keyboard states.
- [ ] Automated store/API/tool/prompt/focus/UI checks and normal repository validation pass, with reviewed-head QA evidence.

## Controller check

Automated fixtures prove delivery to provider boundaries and state/UI behavior.
An actual provider's later response is optional observation during authorised crew work, not a new live-check gate.
Keep the paid crew idle for refinement and fixtures. Never restart the running hub or alter observed loops for testing.
Existing independent checks for changes to FLIGHT's own authority still apply.

## Size

Parent split: server L, web M. The earlier M estimate did not include the full folded #763 delivery.

## Security

Orders and instructions add guidance; they cannot loosen repo rules, safety floors or hard-rule approvals.
Operator provenance protects global writes and operator entries. Full same-user FLIGHT shell access remains
#1214's accepted workflow boundary, not OS isolation. No new GitHub writes or paid schedule/provider action.

## Reassessment — 2 November 2026

Not delivered at f7ee4e26. Both folded outcomes are now specified in the repo-native implementation plan.
Checked all open cards: #1362, #1361, #1360, #1214, #1196, #1178, #993, #933,
#925, #759, #715, #677, #656 and #45. None duplicates this missing feature.
#677 retains its site-review ownership; #759 owns briefs; #1361/#1362 own Agent layout/shared forms.
Overview remains separate and first. Controller owns filing/triage. This refinement does not authorise a crew start.
