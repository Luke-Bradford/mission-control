# PR 1604: exact viewport evidence

Captured 8 November 2026 from an isolated branch preview of head
`db30404915b088f013f732675c1f02115b8d070e`, using a copy of the live hub database.
The live hub was not restarted or changed. This supplements RETRO-CX review
`4562b3cce39dfdf69bd198919690a3eca05a2b08f0649317d536680e3c365a22`;
it does not replace its independent review or CI.

The Overview and Board were captured at exactly 1920 x 940 in light and dark.
All four PNGs were inspected. The header retains the Needs you count. The
Overview has no repeated Needs-you panel and uses the space for existing Crew,
Board, machine, token and activity panels. The collapsed FLIGHT rail has no
waiting count or item list. Both pages fit the viewport horizontally. No browser
page errors occurred. The Board deliberately scrolls within its columns.

Browser requests were confined to this preview and GET only; the event stream
was blocked, hence the Connecting label. No controls were used. These are current
head captures, not new before/after comparisons; the native QA report retains
its existing baseline/head pairs. The open-dock long-message regression was
verified by RETRO-CX and was not repeated in this supplemental capture.

`capture.json` records capture time, dimensions, route, scheme and observed page
text. Its temporary local paths identify capture outputs; the adjacent PNGs are
the retained copies. No application source changed for this evidence.
