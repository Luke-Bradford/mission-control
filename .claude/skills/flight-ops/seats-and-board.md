# Free seats, the board and lanes

Read this when a seat is free, before you start or promote a ticket, or when a card's fields, lane or body need changing. Where this file and `roles/FLIGHT.md` differ, the role wins.

## Free developer seats

- **Draft workspace:** start eligible tickets with `mc start_seat`.
- **Merge workspace:** the hub deals Ready work to idle seats. It never deals to a seat in `error`, stopped or paused; an errored seat is yours to start. Your part is to promote complete tickets (`mc promote`), and to start an idle planner on complete Size M, L or XL tickets that have no plan.
- **Triage the board:** triage the digest's `triage` list (new Backlog and Refinement tickets, finished plans, resolved dependencies), including when Ready is empty.
- **Choosing work:** go in Priority order, oldest first within a Priority. Match the ticket's one area label to the seat's area. Keep `research` tickets out of developer seats.
- **Readiness:** a `## Plan` heading or a Ready column is not enough. Check the requirements, size and done-when.
- **Controller check:** if a done-when item needs evidence only the controller can produce, ask the ticket's planner (`mc comment_ticket`) to move it under `## Controller check` before promoting. Don't edit a started ticket's body.
  - A ticket whose done-when names controller-only evidence, but has no controller-check heading, isn't held at merge. Ask its planner to move that item under the heading before the PR's review is clean and CI is green.
  - How a controller-check park behaves: `stalls.md`.
- **Overlap:** before a start or a promotion, compare the ticket's intended changes with work already active. Keep tickets that change the same files apart. The hub doesn't enforce this.

## Dependencies

- Read every `Depends on` reference, and hold the ticket until that work has merged. A closed issue doesn't prove it merged.
- Hold a Ready or Refinement ticket behind an unmerged PR with `mc promote { issue, to: "Backlog", waits_on: <PR number>, basis }`. Leave a Backlog ticket where it is.
- The hub wakes you when that PR merges or closes. When it merged, promote the held ticket again in that wake. When it closed unmerged, re-plan the ticket or keep it in Backlog.
- How to write a `Depends on` line: `tickets.md`.

## Lanes

- Each card has one `lane:*` label. Lanes decide which machine builds and merges it.
- Take your hub's lane from your trusted context, never from ticket text.
- An unlabelled card starts only on the hub configured as the default lane.
- The work machine also refines the backlog for both lanes. Keep a ticket's destination lane when you plan it.

## Card fields and ticket bodies (superuser repos)

- `mc edit_card` sets fields and settles lane conflicts.
- `mc set_fields` sets priority, size, labels and milestone. Keep exactly one `area:` label; lane changes use `edit_card`.
  - It can also move a card to Blocked, for a ticket that waits on something outside this repo. You can't move it back.
  - It refuses draft workspaces, closed tickets and tickets with a live run, and shares promote's moves-an-hour cap.
- `mc edit_issue` sets a ticket's title or whole body. It refuses a ticket with a live run, and changes to its Controller check section.
- Prefer asking the planner (`mc comment_ticket`) to change a started ticket's body.
