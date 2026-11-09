# Draft updated body for #759

PRIVATE DRAFT for controller review; no GitHub update performed.

## Outcome

An operator ask is accepted by the hub only with: the question; why it needs the operator (money,
product direction, security exception, irreversible, or a floor approval); context and who FLIGHT
consulted; 2–4 options each with consequence and reversibility; a recommendation; a default and
deadline or a hold condition; cost of delay. The brief renders open without a click, with Accept
recommendation as the primary action, Discuss inline and a stale badge when the item changed after
the brief.

## Why

The operator: “where it needs you, it should be clear with a brief when checked on, specifically
what is needed and its options. Able to discuss.” Roadmap item 5 remains the acceptance contract:
docs/superpowers/specs/2026-10-28-operator-console-roadmap.md, especially decisions at lines 33–35.

The 31 October closure deferred this work for MVP; it did not mean delivery. Reassessment on
current main `9981a828cfd0ebcf480a08b767905d1a138a4c8a`, 3 November 2026, confirms it is partial.

## Already delivered

- AttentionBrief has question/assessment/context, actions, checked sources, recommendation and
  optional options. Ordinary Needs-you briefs already open initially, but omit the complete contract
  and inline comparison/actions. Person cards still require another panel.
- #741 is implemented: server-stamped 40-minute deadline, durable default claim/outbox, outcome
  Comms, cancellation by answer/hold and restart recovery. Preserve this rather than rebuilding it.
- Versioned correlated item discussion, explicit holds, source-bound person replies, typed queue
  proposals, run/review services and exact-head QA/UAT/controller actions exist.
- #1214 supplies supported full FLIGHT access and preserves actual operator/controller floors.
  PR1376 corrected the runaway recovery alias and request-lifetime provenance. It is not an open
  gap in this plan. #993/#1377/#1378 deliver standing guidance and its management UI; they do not
  deliver this complete-brief/choice contract. #925 evidence does not itself approve a brief action.

## Remaining implementation / children

1. **Server, L — Server enforces complete operator briefs and bound, authorized choices.**
   Add complete versioned fields, source/brief identity, freshness, typed action adapters, guarded
   explicit choice dispatch, server-derived FYI eligibility and bound default recovery. Update every
   producer and retain legacy records as readable/refresh-required. Publish this child first.
2. **Web, M — Complete operator briefs open inline with bound Accept and Discuss.**
   Consume the merged server contract in existing Needs-you/Comms/panel surfaces. Show all required
   fields/options, honest typed actions/receipts, inline discussion and stale/error/retry states.
   Preserve current counts, shell and instruction UI. No unrelated page redesign.

The controller substitutes real child issue numbers after reviewing/publishing these drafts.
No children were created by this refinement. The web child depends on the server child; the parent
stays the complete acceptance contract until both are delivered and verified.

## Authority, FYIs and timing

The five genuine operator reasons always wait for an explicit authorized choice; an approval can
never acquire an automatic default. Roadmap line 35 already directs reversible choices within
existing standing authority to become FYI countdowns. No new user policy decision is pending.

Positive eligibility is server-derived: a registered typed adapter proves that the current FLIGHT
actor may perform that exact reversible action now without a new approval. A label, caller bit,
option wording, claimed reversibility or absence from protectedDecisionItem never grants it.
Initial concrete cases are run-bound ordinary guidance and FLIGHT's own direct queue-priority
judgment using its existing guards. A scoped reversible PR operation requires an actual typed
preflight/provenance/state snapshot; generic gh_write availability is insufficient.

Grants, controller verdicts, UAT, breaker recovery, human reply approvals, review waivers, hold
release, human approval-proposal resolvers, merges and branch deletion never default. Existing
direct/full-access routes retain their authority; this work describes a brief's automatic path.

Preserve #741's server-owned 40-minute clock for the same source/action/target/meaning. Cosmetic
rebriefing cannot postpone it. Changed source or action meaning invalidates the old action and
deadline; a newly eligible decision receives a fresh server clock. Held/answered/gone items do not
apply; pending work is source/run-bound and revalidated immediately before actual dispatch.
Legacy unknown records are not fabricated into valid current choices or newly authorized defaults.

## One-click meaning and freshness

Accept selects the stored option through a strict brief/source/option/retry binding and its existing
typed service. Ordinary answers say “Answer sent”, approvals identify their actual scope/head and
evidence, and UAT says “Accepted for this head”, not merged. Discuss remains chat only. Current
ItemPanel's FLIGHT-target choice through chat must be replaced; it is not an action executor.

No generic prose/URL executor is introduced. For an external decision whose supported effect is
recording/delivering an answer, say that. Never report spending, posting or work execution that did
not occur. An Open/Review-only fallback is not delivered one-click acceptance. Any required missing
action/form remains an explicit parent gap; no invented evidence or unsupported-flow waiver.

Store a canonical source fingerprint separately from attentionVersion, which includes the brief
and remains discussion concurrency. Source/head/run/scope changes show stale; legacy/missing source
shows unknown. Refreshing a page does not freshen a brief. Existing protected routes recheck current
authority at dispatch, with correct actor provenance through awaits. Source/current approval and
saved historical evidence remain separate concepts.

## Done when

- [ ] brief_item and all hub producers validate the complete contract; field-specific refusal has
  zero partial brief/draft/hold/pass writes. Legacy data remains honest and readable.
- [ ] 2–4 stable identified options have consequences/reversibility and a matching recommendation;
  consultations, why-you, timing and delay cost are explicit without fabricated facts.
- [ ] Brief/source/action identity and current/stale/unknown reasons are server-owned; stale/held/
  changed targets cannot dispatch or hide a newer same-key ask.
- [ ] Eligible typed FYIs retain #741's 40-minute, cancellation/restart/single-claim behavior;
  protected and unsupported actions cannot default. Final queued dispatch rechecks source/run/holds.
- [ ] Needs-you opens the complete ordinary/person brief and option comparison; primary Accept and
  inline Discuss share the same behavior with Comms and the item panel.
- [ ] All required explicit action families have actual adapters/forms and truthful receipts;
  pending/unknown/failure retains target/input and cannot blindly execute twice.
- [ ] Rendered actual-App before/after evidence covers normal and stress content, supported widths,
  short height, themes, relevant dock states, full text, focus and painted final actions.
- [ ] Both children pass meaningful boundary/action tests, checks, fresh independent review and
  normal CI; exact-head QA records describe actual coverage and remaining limits.

## Design / duplication / ownership

Use existing panels and HUD form patterns under the current visual-QA guide. The old private
complete-brief native draft is proposal history, not accepted production evidence. A bounded card
enhancement needs no new user design-approval wait; a separate major page redesign would need a
native proposal first. No Overview redesign, Board redesign or new inbox-count model belongs here.

The open-ticket audit found no duplicate complete-brief/default/discussion implementation ticket.
#741, holds/discussion, person-source replies, #993 and #925 are reuse seams, not new dependencies
to rebuild. Root/controller owns publication/triage and replaces the draft child references.

## Size / Security / Controller check

Parent coordination: M. Child implementation sizes: server L, web M. Priority P1; retain Refinement
until the reviewed child bodies are published/scheduled. No additional policy approval wait.

Accept performs only actions already available through existing authority and typed services.
Preserve secret checks, operator/delegated identity, controller independence and current-head gates.
No new privilege, GitHub verb, arbitrary executor, dependency, workflow or observed-loop action.
Fixtures/temporary repositories/fake providers and actual rendered panels prove this scope; no
paid crew/provider turn, live breaker or hub restart is required for this ticket.
