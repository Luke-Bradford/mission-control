# Implementation and contract map

This map explains correction source c7b33e77; it is not an acceptance or independent-review verdict.
Checked source/test phases and commands belong in [checks.md](checks.md). The source is not published.

| Contract | Implementation | Boundary coverage written |
| --- | --- | --- |
| Complete operator content; lightweight FLIGHT triage | core brief types/catalogue, `brief-schema.ts`, `flight/tools.ts`, FLIGHT role | Missing fields, forged FYI, stable identities, long source retention, lightweight triage, atomic pass rollback in flight-tools tests |
| Source identity distinct from discussion identity | `brief-source.ts`, `brief-prepare.ts`, HUD projection | Read bits excluded, cosmetic clock retained, direction/run/hold/head changes invalidating old intent |
| Stable decision epoch and retained receipt | `brief-choices.ts`, Store settings/transactions and brief row IDs | Competing manual/timer claims, request reuse, later same-key changes, auth refusals, pending/unknown restart handling |
| Exact final provider delivery | `brief-routine.ts`, Supervisor expectedRunId and beforeWrite | Real keeper/fake CLI queue run/source/pause probes; direct messages retain their existing contract |
| Typed explicit dispatch | `brief-api.ts`, exhaustive `brief-dispatch.ts`, private async dispatch context and existing typed handlers | Floor grant, independent controller, review, UAT, merge hold, breaker, person, queue and answer acceptance/refusal paths |
| Positive automatic path | `decision-defaults.ts`, scheduler/main lazy wiring | Fixed within-authority guidance and the actual direct queue validation/allocation/write path; protected and unbound work cannot default |
| Actual generated briefs | `comms-decisions.ts`, queue proposal's atomic producer | Complete generated content, honest unknown delay, real target/actor checks, no action preparation or writes from GET |

The action catalogue describes canonical intents, not permissions. The shared existing route entry
checks still run on explicit choices, including operator/same-origin/seat restrictions, declared
FLIGHT provenance, protected-controller independence and the breaker's separate recovery workflow.
Direct full-access calls keep their existing contracts. Authenticated choices never send arbitrary
URLs, methods, command strings or producer-selected payloads to an executor.

A confirmed authentication refusal is retained by request ID but does not consume the real
operator's epoch. An action whose external completion cannot be confirmed remains unknown and is
never automatically replayed. The current typed service retains responsibility for reconciliation;
a local request ID does not promise exactly-once GitHub/provider effects.

The additional explicit `run-resume` adapter uses the already-supported operator `/runs/:id/resume`
workflow for a displayed budget/other resumable park. It binds the exact run and park kind to the
source revision, never defaults, and leaves review, controller, UAT, merge-hold and breaker cases to
their dedicated adapters and existing floors. It grants no new direct-route authority.

An ordinary answer sends to the displayed run and resolves only that displayed question after
confirmed delivery. It does not close other questions. Automatic ordinary guidance resolves no
question, lifts no hold, interrupts no turn and performs no approval. The server supplies its fixed
conditional within-existing-authority text; producer prose supplies no capability.

The optional scoped PR-operation FYI adapter is unsupported. No initial producer requires it.
There is no closure-provenance service that could safely prove the conditional own-mistaken-close
example; the strict catalogue refuses unknown actions rather than turning arbitrary gh verbs into
default authority. All unconditional explicit families in the published contract remain required.

The dependent web #1390 will render the complete content, source state, real effects and receipts,
and send the bound choice envelope. Existing shipped panels/direct routes remain compatible during
the server-first rollout. No Overview layout, UI proposal or existing web source is changed here.

Written recovery cases also cover a confirmed effect whose outbox bookkeeping was
interrupted: its original completion receipt is settled without requiring a new actor or transport.
An interrupted dispatch remains unknown even if its actor and target have ended. Default execution
resolves the actual same-session FLIGHT actor for each target, retaining preparation, original claim
and current execution identities separately. The existing runaway write accounting/trip path runs
after each automatic effect; no new limit is introduced.

Priority actions retain the server-read original Priority pair in `reversibleState` as well as the
service proof. Ordinary guidance's proof includes the actual fixed guidance text, so a later service
text change cannot inherit an old action proof/deadline. Source facts include current head-bound
controller/UAT/merge-hold and review/CI state, while read bits, elapsed counters and poll times are
excluded. Choice receipt transitions emit attention updates even when recovery makes no new claim.

Broad author checks on the earlier lineage and focused correction checks have different scopes.
Do not read this file map as a claim that every case was rerun after the three Important corrections.
The original independent Changes-required verdict and exact later checks remain in checks.md.
