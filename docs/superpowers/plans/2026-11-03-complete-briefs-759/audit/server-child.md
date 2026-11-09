# Draft child: Server enforces complete operator briefs and bound, authorized choices

Publication status: PRIVATE DRAFT for controller review. No issue number, implementation or approval is claimed.

Parent: #759. Priority: P1. Size: L. Area: server. Owner: server/core implementer.
Source baseline: `9981a828cfd0ebcf480a08b767905d1a138a4c8a` (3 November 2026).
Dependency: parent contract/refinement; publish this child first. The web child consumes its merged contract.

## Outcome

Every new operator decision accepted by the hub contains the question, why it needs the operator,
context, who FLIGHT consulted, 2–4 identified options with consequence and reversibility, a
recommendation, explicit no-answer/timing behavior and cost of delay. The hub binds the brief and
each choice to its actual source and target. Stale, unknown or held choices perform no action.

Genuine decisions about money, product direction, a security exception, an irreversible action or
a floor approval wait for an explicit authorized choice. Reversible actions already within FLIGHT's
standing authority can become server-derived FYI countdowns. Keep #741's 40-minute clock, durable
single application, cancellation by answer/hold and restart recovery.

## Why / delivered baseline

AttentionBrief already stores ask, assessment/context, actions, checked sources and a recommendation.
brief_item accepts absent options and optional option/recommendation IDs. General source freshness
and bound choice execution are missing. Person replies and queue proposals have useful typed checks.
Discussion has concurrency/deduplication, but explicitly instructs FLIGHT not to execute a choice.
Do not use discussion as Accept. Generic seat messages currently address the current occupant of a
seat; pending defaults store only seat ID/answer. A delayed choice must not reach a replacement run.

#993/#1377/#1378 supply standing guidance and its UI; #925 supplies QA evidence and current-head
acceptance. Reuse them without rebuilding them. Roadmap item 5 and line 35 remain the acceptance
direction. No user policy decision or extra provider gate is pending.

## Complete content and compatibility contract

Use a versioned shared brief type. Proposed names are implementation guidance, not existing API fields:

- Retain nonblank ask, assessment, did, checked, recommendation and original source text/reference.
- whyOperator: one of money, product-direction, security-exception, irreversible, floor-approval,
  with a concrete explanation. Required for a genuine operator decision. Never manufacture a reason
  for a routine FYI; the server derives that variant from an eligible action.
- consulted: explicit array of who/finding/ref entries. [] means nobody consulted. Checked source
  evidence is separate. These entries are FLIGHT-reported facts, not authority or proof of a tool call.
- Require 2–4 options, unique stable IDs, label, answer, consequence and reversibility kind/detail.
  Require recommendedOptionId to match exactly one option, plus a recommendation rationale.
- Require costOfDelay, including an honest explanation when time/money is unknown.
- Timing is either explicit waiting condition/no automatic action, or the server-owned FYI deadline.
  A waiting description does not itself hide/hold an item; use existing hold services for that effect.
- Reuse BRIEF_INPUT_MAX=8000, BRIEF_LABEL_MAX=80 and existing 2–4 option limits. Reject invalid input
  before storing drafts, briefs, holds or pass state. Errors identify the missing field and correction.
  Keep legitimate content whole within limits; never shorten it to manufacture validity.
- Bound new explanatory fields with BRIEF_INPUT_MAX, option labels with BRIEF_LABEL_MAX and
  consultation lists with the existing 20-entry structured-evidence convention. Reuse the existing
  ID grammar and transport limits; publish exact constraints in the shared schema/tool description.
- Keep for:flight triage lightweight. For an operator FYI presentation, do not manufacture a passed
  human approval or let presentation ownership make an action authorized. Account explicitly for
  questionWithOperator/passQuestion behavior when deriving this variant.
  Ordinary for:flight intake retains its existing valid shape: it does not need operator-only
  why/consultations/options/action-intent fields merely to keep an item in FLIGHT's handling.
- Old records remain readable with completeness/freshness unknown and refresh-required reason.
  Do not backfill invented consultations, authority, options, deadlines, source revisions or actions.

## Server-owned source and action binding

Expose the database brief ID plus a server-computed source revision. Do not accept either as a
client-authoritative assertion. Keep attentionVersion for discussion; it includes the brief and
therefore cannot be the brief's independent source fingerprint.

Canonical source readers cover:

| Source | Bound facts |
| --- | --- |
| Seat question / labelled Comms | Source/question/message ID and revision/text, sender/recipient, ticket, exact target run, open/passed/answered state |
| Run/review/PR | Configured repo, run, park/review identity, current PR/head, requested approval scope and relevant hold/check state |
| Person | Existing notification/source revision and exact draft/reply binding; preserve current source validation |
| Queue | Stored proposal or direct-judgment intent, seat/config snapshot, current cards/priorities/queue/focus/allocation facts |
| Note/escalation/other supported source | Actual retained identity and decision facts, status and revision; unavailable facts mean unknown |

Exclude read/ack presentation state, elapsed-time counters, poll timestamps and the brief itself.
Include applicable rules/config/standing-instruction revisions so changed direction or scope cannot
silently reuse a prior action. Do not parse natural-language instructions into invented grants.
Freshness reads are derived and do not write/rebrief. Display current/stale/unknown with a reason.
Do not prepare actions, perform remote per-card GitHub fanout or write source snapshots on GET.
Preparation occurs at intake; normal reads compare retained facts against existing local read models
and their revisions. Any remote freshness needed for execution is checked by the typed service at
dispatch. Show verification time/unknown state honestly; a preview capability is not a permission token.

An option may supply a strict typed action intent. A server adapter prepares it using current source
facts and existing service checks. Persist a server-owned PreparedBriefAction containing kind,
canonical arguments, source revision, target/run, preparation actor, effect/reversible-state snapshot
and meaning key. No arbitrary URL/method/body, shell command or prose-to-route executor is accepted.

## Positive FYI eligibility

A default is eligible only if its registered adapter proves that the current authenticated FLIGHT
actor could perform this particular reversible action now without another approval. Preparation
does not execute it, consume a grant, change ownership or claim a default. At dispatch, resolve a
current live FLIGHT actor again and rerun the same guards. Preserve preparation and execution actor
identities separately; an ended actor never becomes anonymous operator authority.

No client bit, FYI label, reversible wording, free-text basis, generic tool availability or
!protectedDecisionItem establishes eligibility. Existing negative protections remain additional
vetoes. Unknown/unimplemented actions have no default capability and return a precise reason.

Initial adapters:

| Adapter | Positive service facts / guards / result |
| --- | --- |
| ordinary-run-guidance | Initial intent is continue-within-existing-guidance with source Comms/question identity, seat and exact run, not arbitrary approval text. The server renders the existing conditional stalled-Comms guidance: act only within current authority, otherwise remain blocked. Use existing sendComms/messaging services, exact configured same-session recipient/run and current source. No unpark, interrupt, approval, question resolver or hold release is bundled in. Validate text and current actor; recheck stop/pause/park, pendingRunApproval and relevant holds in the actual queued delivery. A genuine human decision/source remains protected and unresolved. Additional free-text answers need a typed source/action proof; successful messaging alone does not establish eligibility. Outcome: guidance delivered, never approval/work completed. |
| direct-queue-priority-swap | FLIGHT's own judgment through prepareQueueReorder/reorderQueue, not a human approval proposal/resolver. Retain gate, currentBoard, validate, validateAllocation and final seat/queue rechecks: workspace/rules capability, Away, current priorities/adjacency, Ready, focus, profile, eligibility, always_ask and active/taken work. Snapshot both original priorities. Existing partial-write recovery remains authoritative; never replay an uncertain swap. |
| scoped PR operation, only when its preflight is implemented | Reuse the existing gh_write execution/auth/audit/breaker path. A concrete bounded case is reversing FLIGHT's own mistaken PR closure: structured service-owned closure provenance, fresh same-session repo/PR/head/state, no superseding work or human hold, and current existing guards. Persist typed operation provenance; do not parse free-text audit rows as authority. Unknown closure ownership/state is unavailable. Generic PR comment/edit/label/close/ready/delete verbs are not automatically defaultable. If no actual source requires this adapter in the initial producer inventory, report it as unsupported rather than pretending it shipped. |

Never default grants, controller verdicts, UAT, breaker recovery, human reply approval, review waivers,
hold release, human approval-proposal resolvers, merges or branch deletion. The direct queue adapter
must not consume/approve an existing operator proposal even though business validation is shared.
Normal direct/full-access actions retain their current authority and behavior.

## Bound explicit choice API and action adapters

Add POST /api/attention/:key/choice with strict body { briefId, sourceRevision, optionId, requestId }.
The server selects stored canonical action arguments. A choice with additional required input uses
a typed family-specific input union; it cannot override repo/head/scope/target captured by the brief.
Reusing a request ID with different option/arguments returns 409. A completed duplicate returns its
existing receipt. Do not route this through discussion or infer an action from option labels.
The recommended option of a new actionable operator brief must be fully specified for its typed
adapter. Missing required scope/head/evidence/reason/input makes it incomplete/refused with a clear
correction, not a pretend one-click Open action. Optional operator editing can retain a typed form;
it does not excuse an unspecified recommendation. Every required family in the table below needs
its actual adapter and acceptance test before the child/parent is called complete.

Preserve operator-token, same-origin, seat/delegated-actor and independent-controller checks. Share
the existing typed services with their routes; do not dispatch as an anonymous operator or relax the
original strict routes. Existing direct route calls need no new brief envelope.

| Explicit choice family | Existing action to reuse / authoritative outcome |
| --- | --- |
| Ordinary answer | Run-bound seat/FLIGHT messaging; answer sent, not completed work |
| Review rework / waiver | Run message/resume services with exact park/review/head and existing waiver floors |
| Queue proposal | resolveQueueReorder for explicit approve/deny only, preserving stored snapshot/serialization |
| Person reply | Existing source-bound reply/draft Post or local Copy/handled paths; retain source re-read and approval checks |
| Controller check | Run/external PR controller-check service, exact sha/verdict/evidence and required fail note; preserve protected-controller independence |
| UAT | Existing PR UAT accept/send_back service with actual current head/evidence and required send-back note; accepted does not mean merged |
| Floor grant | Existing flight-approvals service with displayed exact rule/scope/until/reason, expiry/usage checks and actual operator click |
| Merge hold/release | Existing run/external PR service and head/owner checks; release supplies no other approval |
| Breaker recovery | Existing explicit operator recovery only, retaining PR1376's decoded alias and request-lifetime provenance guard |
| External decision without execution handler | Record/deliver the chosen decision only where that is the real supported effect. Never claim spending, posting or other external execution. Navigation alone is not acceptance; any required unsupported acceptance family remains an explicit parent gap. |

Read response includes content/completeness, freshness/reason, timing, capability/action label and
receipt status. Use 400 for invalid/missing content, existing 401/403 authority failures, 404 for gone
sources/targets, 409 for stale/held/conflicting choice, and existing upstream failure semantics.
Receipts distinguish answer sent, action applied, queued/pending, refused and unknown/unconfirmed.
No choice or discussion acknowledgment may lift a protected hold or invent a passed check.
For run-bound delivery, add an internal expectedRunId precondition to the appropriate message/
supervisor delivery service and check it both on enqueue and in the final queued write. The current
MessageBody has no such field, and message_seat's runId is currently for unpark only: do not misuse
either as an existing ordinary-message binding. Preserve unrelated direct message behavior.

## Timing, atomicity and failure/recovery

- Keep #741's server-owned 40-minute wait. A presentation-only rebrief preserves it when canonical
  source, recommended action/option, target and arguments remain the same. Changed source/action
  meaning invalidates the prior action/deadline; a newly eligible ask starts its own server clock.
  Use typed meaning keys, not semantic language classification or brief.at alone.
- Reuse the durable default ledger/outbox. Manual choice and timer race on one brief/source choice
  identity; only one can claim it. Bind settlement/ack to that identity so an old claim cannot hide
  a changed same-key source. Validate before claiming and immediately before actual dispatch.
- Persist exact binding, current execution provenance, request ID and state for pending delivery.
  No live authorized actor or a held target means pending/no dispatch, not a fabricated operator.
- Keep #741's transactional outcome Comms and single claim. If transport is pending, the receipt
  says so. A changed source after a claim cancels further dispatch and cannot mark the new source
  answered or an unperformed action completed. Hold release requires refreshed source validation.
- Preserve existing service serializers/recovery. Persist external dispatch state before effect;
  uncertain external completion stays unknown and is reconciled by its typed service, not blindly
  retried. Local retry IDs do not promise exactly-once external effects.
- Discuss remains versioned chat, never a choice. A message saying approve/yes is not an approval
  token, a waiver, a grant or a resolver invocation.

Storage implementation should expose brief row IDs and retain server metadata in versioned structured
data. Use durable prepared-action/choice records (or equivalent focused tables) keyed by a server
decision epoch, with option/source/action/target/run and state. Reuse the epoch when a presentation
rebrief has the same meaning key; otherwise create a new one. The unique local settlement/claim is
that epoch, not a mutable label, seat ID, new brief timestamp or client request ID alone. Extend the
default outbox with this binding rather than rebuilding #741. Retain existing rows/history. Old
pending deliveries without provable source/action/run binding become refresh-required/unverifiable;
do not silently attach them to today's run or replay them with fabricated authority/deadlines.

## Producer and file map

- Core types/catalogue: packages/core/src/types.ts, flight.ts and shared exports; preserve actual
  constants in hud.ts. A focused brief-contract module is appropriate if it reduces duplication.
- FLIGHT intake: apps/server/src/flight/tools.ts (BriefItemArgs/briefItem/tool description).
- Hub producers: comms-decisions.ts and queue-reorder.ts. Explain generated consultations/unknown
  delay honestly; no producer is exempted by casting it to AttentionBrief.
- Storage/read model: store.ts (brief ID/history, source/action/choice/outbox state), hud.ts,
  attention-subjects.ts and attention-holds.ts. Keep person-source and existing hold services.
- Dispatch: small shared brief-choice/action module; api.ts owns protected route entrypoints.
  Reuse comms.ts, crew-pause.ts/supervisor final delivery, flight/access.ts, flight/runaway.ts,
  queue-reorder.ts, flight-approvals.ts, external-pr-control.ts and existing engine services.
- Timing: decision-defaults.ts, scheduler.ts/main.ts wiring; preserve normal timers and no extra daemon.
- Guidance: update the actual brief_item catalogue/role instructions when necessary; no new approval tier.

## Tests / Done when

- [ ] Production intake refuses every missing/blank required field, duplicate/missing IDs and invalid
  recommendation before any brief, draft, hold or pass write. Valid 2/4-option and boundary text survives.
- [ ] Every producer and persisted legacy variant has a tested completeness/freshness outcome.
- [ ] Source edits, target-run replacement, PR head/scope changes and released holds invalidate old
  choices; read/clock/cosmetic rebrief changes do not. GET/refresh never launders an old brief.
- [ ] Positive ordinary guidance and direct queue swap exercise actual service checks/effects, not
  an eligible=true fixture. Typed PR case tests fresh provenance if that adapter is implemented.
- [ ] Forged FYI/display text, arbitrary URLs/commands and every protected action cannot default.
- [ ] Current actor end/rotation, config/rules/standing-guidance change, pause/stop/park/approval,
  source/target change across awaits and the final delivery queue perform no unauthorized dispatch.
- [ ] Manual/default races, duplicate request IDs, restart, hold/answer cancellation, 40-minute
  preservation/reset and partial/unknown delivery produce truthful durable receipts without replay.
- [ ] Each explicit action family exposed by the web contract has actual route/service tests,
  including independent-controller and person-source refusal. Discussion never executes a choice.
- [ ] Existing direct operator/full-access calls and #741 behavior retain regression coverage.
- [ ] Lint, workspace types, bounded affected tests, fresh independent review and normal CI pass.

Extend flight-tools.test.ts, store.test.ts, decision-defaults.test.ts, comms-decisions.test.ts,
attention-holds/attention-hold-routes tests, queue-reorder.test.ts, person-replies.test.ts, relevant
api/external-merge/flight-approvals tests and fake-provider final-delivery cases. Demonstrate a red
boundary for new guards before the green implementation. No full local suite without lane agreement.

## Controller check / Security

Fixtures and temporary repositories/fake providers can prove this contract. No paid/live crew,
observed-loop, real GitHub write, live breaker action or hub restart is required. No new deployment gate.
The child changes hard-rule/runtime/tool behavior where touched: follow existing independent review
and repository clearance rules. Preserve #1214's full same-user workflow boundary. The default
registry describes this automatic path; it is not a new restriction on direct FLIGHT/controller access.

New default eligibility cannot grant authority, consume a missing approval or rewrite history.
Secrets, source text and consultation claims remain untrusted data. Parent #759 remains open until
this contract and the dependent web outcome are delivered with honest current-head evidence.
