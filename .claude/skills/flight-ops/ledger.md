# Ledger, brief and headline

Read this when you reconcile the ledger, or write the brief or headline. Where this file and `roles/FLIGHT.md` differ, the role wins. Paging, filters and field limits are in the tool descriptions.

## What the ledger is for

- It is the operator's concise operational picture, not private scratch space. Keep current: in-flight work, blocked or waiting dependencies, agreed coming work, incoming items and recently completed outcomes.
- The Board owns individual tickets; your ledger owns the programme view across them. Don't mirror the backlog, or create an entry for every card.
- Track a workstream when the operator needs its outcome, owner, movement, dependency or order without reconstructing that story from tickets.
- A useful open entry answers, in plain language:
  - what outcome is being moved;
  - who owns the next move, and what happens next;
  - what it waits on;
  - what evidence or checkpoint will make you revisit it.
- Use stable keys, short titles and a concrete next step. Update the status when it changes. Close an entry with `mc untrack` and an outcome when it resolves.
- Ledger edits share a cap of 60 an hour and are not logged.

## Kinds

- A `commitment` is ordered future work FLIGHT has actually undertaken, not a possible backlog item.
- A `watch` names an uncertainty, risk or investigation, and the evidence that will settle it.
- Put ticket and PR links in `refs`, not in prose. Put the evidence for your judgement in `basis`.

## Reconcile each wake

- Each active workstream you coordinate needs one matching `work` entry, with its owner, ticket reference and a concrete next action.
- Update it when ownership, dependency or next action changes. Close it when the work resolves.
- An honest missing `due` is better than a false promise.
- Reconcile around four questions: where are we heading, what moved, what is stuck or aging, and what decision is genuinely needed.
- If an active item has not moved, investigate the unknown or dependency instead of rewriting a vague status.
- Don't report percent complete from ticket counts, and don't turn elapsed time into an ETA.
- Where the approach itself is uncertain, record the unknown as a `watch`, with the next experiment, spike or evidence that would make it known.

## Brief and headline

- Keep `headline` current with `mc update_brief { section: "headline", text, basis }`. Refresh it on a wake where `headlineAgeMin` is at least 60, even if the synthesis is similar.
- The FLIGHT page opens on your headline and ledger summary, with short lists and metrics, and full ledger details linked by key. It is the first thing the operator reads, so keep both current.
- Use the brief's notes for workstream context a board can't express: sequencing, cross-ticket assumptions, and what needs the operator's attention. Keep status in the ledger, and remove notes that are no longer true.
- Batch changes into one rewrite per section. Brief edits are logged for you, so don't also `mc log_decision` them.
- Use the ledger for work, watches, commitments and incoming triage. Use `update_brief`'s watch upsert for structured operator cards with an exact draft or lock-hold action.
- Most discussion belongs in Comms. Read stored context with `mc comms_read`. Use labelled `mc comms_send` messages for direct questions, handoffs and blockers, with a ticket or PR ref where one exists.
- Keep lasting project facts, crew knowledge, lessons and playbooks in repo memory (`retrospective.md`).
