# FLIGHT central mind — design

**Date:** 2026-10-27

## Decision

The FLIGHT page is the shared command surface between the head agent and the operator. It is not a second Board, a transcript viewer, or four differently arranged summaries of the same state.

The page has four mutually exclusive jobs:

1. **Command** answers “what is true now, and does anything need me?”
2. **Plan** answers “what has FLIGHT committed to do next, what is waiting, and what arrived?”
3. **Notebook** answers “what context and durable knowledge is FLIGHT carrying?”
4. **Record** answers “what happened and what did FLIGHT decide?”

One fact has one canonical detailed presentation. The Command view is deliberately allowed to contain a short, labelled roll-up of those facts: that is the briefing, not a competing editor or exhaustive second list. Every roll-up points to its authoritative detail and never invents state.

## Operating model and research

FLIGHT is closer to an engineering programme lead than a ticket manager. Its home must combine a CTO's outcome and risk view, a PM's sequencing and dependency view, and a stand-up's immediate coordination view. Four established practices inform the design:

- Linear's project updates pair a small health signal with a written account of progress, challenges and next steps, keep the latest update on the overview, put old updates in history, and mark missing/stale updates. FLIGHT therefore needs one fresh synthesis, not multiple status paragraphs.
- The Kanban Guide's minimum flow measures are work in progress, throughput, work-item age and cycle time. Those are the command rail's primary measures because each can change a decision. Counts of drafts or arbitrary activity are not substitutes for flow.
- Shape Up's hill charts distinguish unknown problem-solving from known execution and warn that task percentages and estimates conceal uncertainty. FLIGHT must name the unknown and its next experiment instead of inventing percent complete or an ETA.
- DORA separates delivery throughput from stability/recovery. Delivery pace belongs in the live command context; failures, rework and recovery trends belong in Record and, later, RETRO rather than being blended into a single “productivity” score.

References: [Linear project updates](https://linear.app/docs/initiative-and-project-updates), [The Kanban Guide](https://kanbanguides.org/the-kanban-guide/2025.5/), [Shape Up: Show Progress](https://basecamp.com/shapeup/3.4-chapter-13), [DORA value-stream management](https://dora.dev/guides/value-stream-management/).

This produces a simple test for every element on the page: does it help the operator decide, coordinate, anticipate or verify? If it is merely available data, it belongs elsewhere.

## What was wrong

The previous tab pass was not production-grade information architecture:

- Overview and Plan both rendered the same headline and 24-hour metrics.
- Overview's live work table and Plan's “In flight” lane described the same work from different stores without explaining which was authoritative.
- Horizon and “Coming up,” Active watches and “Blocked, waiting & watched,” and Decided and Working log repeated the same concepts or exact records.
- Plan mixed present work, future work, history, arrivals, watches and raw ledger inspection.
- The Notebook displayed all nine legacy brief slots even though five status slots are retired and FLIGHT cannot update them.
- Markdown was rendered, but the UI did not identify the source, expose the source text, or explain that it is live hub state rather than a file.
- Equal visual weight made raw activity look as important as exceptions and operator decisions.

That made the page longer and denser without making FLIGHT's judgement clearer.

## Users and questions

### Operator

At a glance:

- What does FLIGHT think the situation is?
- What is actively moving, stalled, or blocked?
- What actually needs my judgement or action?
- What will FLIGHT do next, in what order, and what is it waiting for?
- What context is FLIGHT relying on, how fresh is it, and where did it come from?
- What did FLIGHT decide or finish without interrupting me?

### FLIGHT

The UI must be a faithful projection of the same state available through its tools:

- `mc update_brief` owns the headline and current working-context notes.
- `mc track` / `mc ledger` own work, watches, commitments, incoming work and outcomes.
- structured `watch`, `planned`, and `arrival` updates own revisit actions and routing receipts.
- `mc remember` / `mc recall` own durable repo knowledge.
- run, crew, Board, PR and CI state own live execution truth.
- decisions and wake events own the record.

There is no UI-only planning state and no private Markdown file that can drift from the state FLIGHT reads.

FLIGHT reconciles each active workstream into one ledger `work` entry with owner, ticket reference and concrete next action. A due time is a real checkpoint, never a generated ETA. On a wake it refreshes a materially changed headline, and refreshes a headline at least 60 minutes old so the shared briefing does not silently fossilise.

## Source-of-truth map

| Datum | Authority | Canonical page location | Why |
| --- | --- | --- | --- |
| Headline judgement | brief headline | Command | FLIGHT's current synthesis, with freshness |
| Active execution | crew/run/loop/PR state | Command | observed live truth, not FLIGHT prose |
| Operator asks and drafts | attention, notifications, drafts | Command | exceptions that require the operator |
| Ordered next work and dependencies | open ledger plus planned schedule | Plan | FLIGHT's commitments and future order |
| Revisit triggers | structured watch entries | Plan | explicit follow-up state and actions |
| Arrival dispositions | incoming outcomes | Plan | triage receipt, not active work |
| Current working context | writable brief sections only | Notebook | Markdown authored by FLIGHT |
| Durable repo knowledge | repo memory | Notebook | sourced facts, lessons and playbooks |
| Recent outcomes and operating metrics | closed ledger plus metrics | Record | history, never mixed into the forward plan |
| Decisions | decision store | Record | autonomous judgements, with overturn action |
| Wake/system events | agent stream | Record | diagnostic audit, decisions excluded |

## Page structure

### Command — default stand-up, one screen

- A visually dominant **FLIGHT briefing**: headline, operational state, freshness and a stale warning.
- **Last contact**: the latest operator/FLIGHT exchange, stated honestly as awaiting a reply or replied-after-message rather than a read receipt.
- **Operational pulse**: WIP, blocked work, oldest active-item age, review/CI gates, 24-hour throughput, median Ready-to-merged cycle time and operator needs. The first, third, fifth and sixth are the four flow measures; blockers, gates and operator needs explain what to act on.
- **Delivery board**: one row per active workstream, with owner, ticket, delivery stage, latest event, FLIGHT's recorded next action, checkpoint and elapsed time. Missing next actions and checkpoints are visible data-quality gaps; the UI never guesses an ETA.
- **Stand-up focus**: a deliberately short roll-up of risks/blockers, next commitments and watches/investigations. Plan and Comms retain the complete records.
- No history or 24-hour scorecard on Command.

The command rail is intentionally not a performance league table:

| Signal | Exact meaning | Decision it supports |
| --- | --- | --- |
| WIP | crew runs started and not finished | is the crew overloaded or idle? |
| Blocked | live runs stalled, parked, blocked or errored | what must FLIGHT clear first? |
| Oldest | elapsed age of the oldest active run | is work aging without movement? |
| Review / CI | open PRs in review or pending CI | is delivery accumulating at a gate? |
| Throughput | PRs merged in the last 24 hours | is finished work leaving the system? |
| Cycle time | median Ready-to-merged time in the measured window | how long has comparable delivery actually taken? |
| Needs you | unresolved operator-owned decisions or replies | must the human intervene now? |

The labels disclose their denominators and windows. No red/green target is inferred until the repo has an explicit service-level expectation or enough history for a defensible range.

The page should degrade honestly: when FLIGHT is absent or its headline is stale, say so while continuing to show observed live execution.

### Plan — looking ahead

- **Planning board**: a flat, scannable table of ordered commitments, non-live waiting work, deliberate watches and scheduled checks. Every row exposes horizon, workstream, health, owner, next action, dependency/checkpoint, age and references without opening it.
- **Revisit triggers**: structured watches that can carry an exact action.
- **Arrivals**: routing receipts.
- **Operator actions and drafts**: human-owned decisions and a proper working area for prepared replies.

Plan is not a Board clone. Tickets remain authoritative on the Board; Plan records FLIGHT's cross-ticket order, dependencies, uncertainties and commitments the Board cannot express. Raw ledger inspection and duplicate “all items” accordions are not part of this operator surface.

Horizon is evidence-based: Waiting, Watch, Overdue, Today, This week, Next or Later. Health is a separate statement: Blocked, Waiting, Late, Watching, Scheduled or Ready. A due value is a real checkpoint; its absence is displayed as “No checkpoint,” not converted to a guessed date.

### Notebook — shared working memory

- An index explains the two memory horizons and links to every visible section.
- **Working context** shows only the four writable Markdown sections: Project, Crew, Operator and Lessons.
- Every section shows provenance, update time, a stable fragment link, rendered Markdown, and a “Markdown source” disclosure containing the exact stored text.
- **Durable knowledge** shows repo memory with topic, kind, author, source and basis, and preserves operator edit/delete controls.

The current implementation stores notes in the hub database, not `.md` files. The Notebook is therefore the live Markdown view; inventing file links would create a false second authority. A future export can expose a generated, read-only `.md` projection from the same records, but must never become a separately editable copy.

### Record — what happened

- **Outcomes**: recently completed ledger entries and the 24-hour operating scorecard.
- **Decided without you**: FLIGHT decisions with basis and overturn.
- **System log**: Mission Control wake/event lines only. It excludes decisions because they already have a canonical panel.

Record is newest-first where recency matters. It is not the place for future commitments.

## Visual hierarchy

- Intent is the page's strongest typographic element.
- Exceptions precede healthy activity.
- Tables are used for repeated operational fields; cards are reserved for judgement or action.
- Provenance labels distinguish `FLIGHT`, `LIVE`, `MEMORY`, and `SYSTEM` state.
- Panels scroll internally on desktop so every top-level view fits the viewport; narrow/short screens fall back to document scrolling.
- Empty states state what the absence means, not only “nothing here.”
- Primary status, owner, dependency and next action are never behind a disclosure. Disclosures are reserved for source Markdown and diagnostic evidence where the summary remains complete without opening them.

## What FLIGHT maintains

The agent should update a small portfolio of operational artifacts as work changes, rather than produce periodic prose for its own sake:

| Artifact | Update trigger | Required content | Operator value |
| --- | --- | --- | --- |
| Headline | material change; or stale on a wake | current outcome, most important movement or risk | opens the stand-up in one sentence |
| Active workstream | owner, dependency, next move or outcome changes | outcome-oriented title, owner, refs, next action, waits-on, evidence | shows who moves what next |
| Commitment | FLIGHT genuinely accepts future work or changes order | concrete deliverable, priority/order, owner if known, next action, checkpoint if real | makes the forward plan explicit |
| Watch / spike | an uncertainty or risk needs evidence | precise unknown, next experiment/check, revisit trigger, refs and basis | exposes risk before it becomes a blocker |
| Operator ask | only a human can decide or approve | one question, recommendation, options and consequence of delay | makes interruption worthwhile |
| Outcome | work resolves or is dropped | result, evidence and references | preserves accountability and enables learning |
| Working context | sequencing or cross-ticket assumptions change | concise Markdown that the Board cannot express | lets FLIGHT resume and lets the operator inspect its model |
| Durable memory | a fact, lesson or playbook will matter again | source, basis and stable topic | prevents repeat investigation |

FLIGHT reconciles these on event wakes; it does not poll or rewrite unchanged text. A lack of movement is itself a reason to investigate age, unknowns and dependency—not a reason to publish a cosmetic update.

## Missing model, deliberately not faked

The current stores can support the flat plan and honest flow rail, but not every desirable programme view. These are product-model gaps, not invitations for UI inference:

- **Outcome hierarchy:** a first-class initiative/workstream that can group tickets and ledger entries around an operator outcome.
- **Declared health:** On track / At risk / Off track plus the author's short reasoning. Current health is limited to operational status and due/checkpoint evidence.
- **Uncertainty phase:** Unknown / validating / known / executing (or a hill position) and `lastMovedAt`, so an uphill item that has stopped moving can be spotted without pretending it is 40% complete.
- **Milestone and scope movement:** the current milestone, changes in linked scope, and dependencies between workstreams.
- **Briefing delta:** a snapshot of the prior briefing so “what changed since last stand-up” can be computed rather than guessed from recent activity.
- **Probabilistic expectation:** historical cycle-time percentiles or an explicit service-level expectation. Forecast bands should appear only after sufficient comparable history, never as a single invented ETA.
- **Stability/rework series:** unique failed changes, recovery duration and rework rate for the future RETRO view. Raw failure-event counts are not the same thing.

Graphs become worthwhile only when those stores retain a series. The first useful charts would be an aging-WIP scatterplot, throughput/cycle-time trend and scope-versus-completion history. A decorative animated graph or a single-point sparkline would obscure rather than clarify.

## Behaviour and edge cases

- A stale headline is visibly stale; it does not make live run data stale.
- No FLIGHT seat: Command still shows live operations and operator items; FLIGHT-authored regions explain that no seat is running.
- Old servers may omit newer summary fields; Record renders an empty outcome state without crashing.
- Retired brief sections may remain in storage for migration/history but are never presented as current writable Notebook sections.
- A structured watch and a ledger watch may refer to the same subject. The former is shown only as a revisit trigger/action; the latter only as planning state. Labels must make that distinction explicit.
- Hidden tabs remain accessible and correctly labelled; tab focus and `aria-controls` stay coherent.
- Live refresh changes content without changing the selected tab or snapping a panel away from the operator's reading position.

## Acceptance criteria

1. The default Command view contains exactly one headline, one live-work representation and one operator-attention surface.
2. Plan contains no headline, live-work list, 24-hour metrics, recent outcomes or duplicated arrival list.
3. Notebook renders only `FLIGHT_NOTE_SECTIONS`, not retired status sections.
4. Each working-context section has a stable anchor and exposes its exact Markdown source.
5. Record contains recent outcomes and metrics once; its system log contains no decision rows.
6. A field-level inventory finds no detailed datum in more than one top-level tab.
7. Each desktop tab is usable without page-level vertical scrolling at the supported minimum viewport; overflowing panels scroll internally.
8. Loading, no-seat, empty, stale and API-error states are covered by tests.
9. Existing live resources and event topics drive every view; there are no fixtures, placeholder widgets or UI-only saved state in production code.
10. Without leaving Command, the operator can answer the stand-up questions: overall state, what is moving, what is blocked, who owns each active stream, what happens next, whether a checkpoint exists, how old the oldest work is, whether work is clearing the system, and whether FLIGHT has replied to their last message.
11. Plan contains no nested primary records or “all ledger” disclosure; its row fields are visible without interaction.
12. Metrics state their unit and window and never imply an unconfigured target, percent complete or ETA.

## Not in this change

- A speculative editable `.md` file alongside the database.
- Showing private chain-of-thought. The page exposes explicit notes, decisions, evidence and actions only.
- Replacing the Board, Comms, Agent or Telemetry pages.
- Inferring plans from transcripts when FLIGHT has not recorded them.
