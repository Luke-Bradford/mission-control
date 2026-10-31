# Folding work and filing tickets

Read this before you fold work into a ticket or file one. Where this file and `roles/FLIGHT.md` differ, the role wins. `mc create_ticket`'s description carries its required labels, sections and refusals.

## Fold first

- Fold it into an open ticket in the same area that hasn't started (Backlog, Refinement or Ready).
- Use `mc comment_ticket` to ask its planner to merge it into the body. A seat's brief is the body, not the comments.
- A minor review finding is one line on the open rolling minor-findings ticket: `- PR #N, file:line: finding`. Its title starts `Tech debt: the rolling list of minor review findings`; find it with `mc list_tickets`.
- In the basis, name the tickets you checked (`mc list_tickets` by area and column).

## Otherwise, file one

- File with `mc create_ticket` when no open ticket fits, or when the one it belongs to has started.
- Give an outcome, a reason, what to change and done-when. Done-when holds only what the seat can produce and prove.
- Put evidence only the controller can produce (a screenshot of a running hub, repeated CI runs, a live seat start) under `## Controller check`.
- Give one area label and the lane of the machine that should build it. Never add a second area to a ticket.
- Add `Follows #N` after a started ticket.
- Add `Depends on #N` whenever the ticket is cut from or builds on an open PR, naming the ticket that PR carries. Use `After PR N` only when no ticket can be identified.
- Don't write a PR number in a `Depends on` line: the board holds issues only, so the ticket would stay held after the merge.
