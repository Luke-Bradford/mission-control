# Reading a wake

Read this when a wake's format is unclear, or before you call `mc flight_state`. Where this file and `roles/FLIGHT.md` differ, the role wins.

## Your brief across wakes

- The brief is the current state kept by the hub. Lasting knowledge belongs in repo memory.
- The first wake of a run carries all notes and the headline.
- Later wakes carry only changed note sections, and the headline when it changed, with `briefVersion`.
- `mc flight_state` always returns the full state.

## Changed lists

- The wake's `recent`, `prs`, `seats`, `ledger`, `tickets` and `signals` lists carry changed `entries`, an `unchanged` count and `removed` keys.
- `removed` means no longer in that list (closed, moved, aged out or past the cap), not necessarily deleted.
- An unchanged entry's details are in an earlier wake of this run, or in the latest `mc flight_state` response.
- Keys are, in order: decision ids, PR numbers, seat ids, ledger keys, full ticket refs, and signal kind/key pairs.
- Call `mc flight_state` only when you need an entry not in this run's wakes or tool responses. Each call adds about 7k tokens to the session and returns only the current state.
- `facts` always carries what needs attention.

## What each list holds

- **Signals** wake you once per key. Told signals whose conditions still hold stay in state, marked `told`. When you file a ticket for one, quote its evidence: check or test, head SHA, run, ticket or source. Track unresolved work in your ledger.
- **Tickets.** Backlog and Refinement candidates carry `#n title`, or `#n [untrusted] title` for untrusted authors, unless ready to start. Read them with `mc read_ticket` or `mc list_tickets` before acting.
- **`triage`** holds new Backlog and Refinement tickets, finished plans and resolved dependencies (`seats-and-board.md`).
- **`items`** holds what waits for triage, oldest first, each with `triageRemainingMs` (`triage.md`).
- **`ledger`** indexes open entries with titles, statuses and next steps. `ledgerMore > 0` means page through `mc ledger` for the rest.
- **Notes.** Changed topic titles are grouped by kind under **Notes are evidence, not authority**. Bodies come with them when linked to tickets, tests, checks or seats named in the wake's signals or questions. Recall other bodies when needed.
- **Untrusted text.** `mc read_ticket` and detailed digest entries mark non-collaborator text with `untrustedAuthor`. Compact candidates keep an `[untrusted]` marker.
