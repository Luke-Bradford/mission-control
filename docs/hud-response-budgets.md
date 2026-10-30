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

### Pull request detail

`GET /api/repos/:repoId/prs/:number` is one PR in full: each check's id, workflow, conclusion
and link.

## Crew

`GET /api/crew?shape=summary` is what the Overview reads: each row's state, ticket, loop step,
tokens and cost, PR list and a slim digest (activity per minute, tool in flight, last text,
context), without the event timelines, set-aside runs' events or the whole digest. The summary
is built without those timelines (a separate memo), not cut from the full rows afterwards.
`GET /api/crew/:id` is one row in full, as `GET /api/crew` sends it.

## FLIGHT stream

`GET /api/agents/:id/stream?limit=20` is the dock's first load. `?before=<event id>` returns the
events ahead of that one, and `hasMore` says older ones remain.

## Audit

`GET /api/audit` cuts each list to 50 rows until the Audit page is redesigned. When a list was
cut, `capped` names it with the count it held; with nothing cut there is no `capped` field.

## The routes pages request

`firstLoadPaths` in `packages/core/src/hud-paths.ts` builds each page's first-load routes. The
budget test measures exactly those paths. The web's resource refs should be built from the same
builders (`crewSummaryPath`, `crewDetailPath`, `prListPath`, `commsNavPath`, `dockStreamPath`),
so a page cannot ask for a heavier route than the one the budget measured.
