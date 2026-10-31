# HUD response budgets

Every HUD page shows its data within 1 s of opening and moves under 500 KB (gzipped) on first
load; no single response is over 300 KB. `apps/server/test/response-budget.test.ts` builds each
page's first-load responses from a large fixture and fails above those numbers. It runs with the
server suite in CI.

A page fetches what it shows, not whole histories. Each list answers with a bounded, summary shape
and the full row is one request away.

## Comms

`GET /api/comms/agents/:id` is the conversation list: `contacts[]`, one line per contact (last
message, `count`, `unread`, all from SQL counts), plus the newest 50 `messages` and `inbox`.
`hasMore` / `inboxHasMore` say older ones exist. `?summary=1` returns the conversation list and
counts only (no `messages` or `inbox`): the nav rows' read, so opening Comms does not load a page
of messages per seat.

`GET /api/comms/counts` is one call for every seat's nav figures: `[{ id, contacts, recent24h,
unread, directUnread }]` in crew order. `contacts` is the seat's all-time messages with its
contacts (the sum of `contacts[].count` on its agent page, crew channel excluded: the number the
nav row shows), `recent24h` the messages from the last 24 hours that involve the seat, and
`unread` and `directUnread` the ones its agent page shows. It replaces reading each seat's page.

`/api/comms/agents/:id/contacts/:contact`, `/api/comms/pairs/:a/:b`, `/api/comms/crew` and
`/api/comms/flight` return one conversation, newest 50 first load. All take `?limit=` (1..200) and
`?before=<message id>` (messages strictly older than it), and answer `hasMore`. `unread` and
`cursor` always cover the whole conversation, not the page.

## Pull request lists

`GET /api/repos/:repoId/prs` returns open PRs plus those updated in the last 7 days. `?days=N`
reaches back N days, `?all=1` returns every PR, `?linked=1` keeps the ticket-linked ones. Each row
carries its checks as `{ name, kind, state, attempt }`; `?detail=1` returns the full rows.
`?shape=summary` is the list shape: repo, number, title, url, branch, head, ticket, state, draft,
review, `ci` rollup and timestamps, with no checks, assignees, closing issues or size fields.

`GET /api/repos/:repoId/prs/titles?numbers=4,9` is the number and title of each stored PR among
those numbers (1 to 50), lowest number first; a PR the hub has not stored is left out. It is what
a link needs to name a PR, without the list.

### Pull request detail

`GET /api/repos/:repoId/prs/:number` is one PR in full: each check's id, workflow, conclusion
and link.

## Crew

`GET /api/crew?shape=summary` is what the Overview reads: each row's state, ticket, loop step,
tokens and cost, PR list and a slim digest (activity per minute, tool in flight, last text,
context), without the event timelines, set-aside runs' events or the whole digest. The summary
is built without those timelines (a separate memo), not cut from the full rows afterwards.
`GET /api/crew/:id` is one row in full, as `GET /api/crew` sends it. No crew row carries the
digest's `toolStarts` or `attemptUsage`; the web reads neither.

## FLIGHT stream

`GET /api/agents/:id/stream?limit=20` is the dock's first load. `?before=<event id>` returns the
events ahead of that one, and `hasMore` says older ones remain.

## Notifications and the away digest

`GET /api/notifications/events?after=<id>` returns only the events after that id (the whole list
when the id is not in it, so a client resyncs). `GET /api/away/digest?meta=1` returns
`{ active, startedAt? }` without building the digest.

## Events and compression

The hub emits `agents`, `health` and `attention` after a ta, studio or GitHub tick only when what a page would
show changed (a hash of the crew rows, of the attention items' keys and owners, and of the collector rows
without their recorded time; `lastOkAt` moves in 10-minute steps). The first tick after a start always sends. While no browser
is connected the check is skipped and the topics go out as before.

API JSON and web assets of 8 KiB or more are sent as brotli (or gzip) when the client's
`Accept-Encoding` allows it; fonts and images other than SVG are not.

## Audit

`GET /api/audit` cuts each list to 50 rows until the Audit page is redesigned. When a list was
cut, `capped` names it with the count it held; with nothing cut there is no `capped` field.

## The routes pages request

`firstLoadPaths` in `packages/core/src/hud-paths.ts` builds each page's first-load routes. The
budget test measures exactly those paths. The web's resource refs should be built from the same
builders (`crewSummaryPath`, `crewDetailPath`, `prListPath`, `commsNavPath`, `dockStreamPath`),
so a page cannot ask for a heavier route than the one the budget measured.
