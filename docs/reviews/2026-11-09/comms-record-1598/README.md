# Comms record server reads

One SQLite backup of the live hub supplied six ticket-count reads at 09:18 UTC on 9 November. The candidate was the server implementation on this branch, based on main 03ef6b52. The first Store startup, including the new indexes and retention counter, took 21.84 ms. Reads took 3.08–4.77 ms. Every result had 359 ticket rows, 2,509 assigned ticket links, three unassigned referenced messages, 15,755 JSON bytes and the same SHA-256. A PR message can belong to more than one closing ticket, so assigned links are not a unique-message count.

Only aggregate counts, timings and the result hash are retained. The copied database, message text and per-ticket result are private and are not included. No live write, model call or observed-loop action was made by the measurement.

The live read-only date check found 2,838 messages, from 23 October 2026 at 06:38 UTC to 9 November at 05:08 UTC. The Comms table first entered this repository in 6b3f514a on 23 October, before the current 90-day ordinary-message retention age. The count reader covers the existing reference history; reference totals now survive future body retention. Already deleted records from before this migration cannot be reconstructed, and no missing historical total is invented.

Acceptance checks cover hub paging, empty/nonempty FLIGHT/controller pairs, more than the feed's last 100 messages, qualified/short/PR references, duplicate closing-issue references, ambiguous multi-repo legacy references, recorded sender kinds and unknown legacy provenance, question/answer/set-aside fields, closure without an answer, tied-time question paging and cross-repo exclusion. An additional acceptance check reproduced shrinking totals after actual retention; totals now survive repeated sweeps and a database reopen, including both ordinary and question-message retention paths.

The existing web rendering and timeline kinds are unchanged. New question fields and sender metadata are additive. Full local tests, exact-head CI, independent most-capable review and merge remain separate gates; this receipt does not claim them.

## Shared contact contract: review 1344

CommsContact now declares optional hasMessages, matching the additive server response and preserving older callers. The controller-pair route test reads both empty and populated summaries through CommsAgentResponse and accesses the flag through that shared type. Before the contract correction, server typecheck fails at both accesses because the field is absent. Afterward, 35 Comms and record tests pass, along with lint, all workspace typechecks and build. Production response behavior is unchanged. Fresh pushed-head CI and independent review remain required.
