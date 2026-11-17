# Pipeline delivery and the 24-hour measurement (#925)

What landed for each of the ticket's five items, and how to measure the outcome. A seat cannot read the hub database, so the measurement is run by FLIGHT or the controller on a copy.

## Baseline (ticket, 29 October, last 24 hours)

- CI: 300 runs, 34 failed; about 25 failures on crew branches were real (typecheck, route table, role tests).
- Reviews: 199 passes on 63 PRs; 147 (74%) had a blocking finding; 50 of 388 blocking findings asked for evidence the seat cannot produce.

## What landed

| # | Item | Primary PR and where | Tests (tracked files) | Later follow-ups (not the primary delivery) |
| --- | --- | --- | --- | --- |
| 1 | Pre-push gate (lint, typecheck, related tests) | PR 1339, merge `c3192017a` | `apps/server/test/related-check.test.ts`, `apps/server/test/mcp-tools.test.ts` | PR 1485 (gate-refused push gives way to rework), PR 1919 (every spelling of the check takes the test lock); exact-head rule in `docs/reviews/2026-11-13/repeated-review-findings.md` |
| 2 | Controller check is a merge step, not a finding | PR 952, `controllerCheckHold` and `ticketControllerCheck` in `apps/server/src/engine/engine.ts`; `roles/RETRO.md` line 23 | `apps/server/test/engine.test.ts`, `apps/server/test/api.test.ts`, `apps/server/test/flight-tools.test.ts` | commit `edcf13795` (edit_issue keeps the section), test `apps/server/test/flight-tools.test.ts` |
| 3 | UI checks without the controller (**revised**) | No FLIGHT tool for a PR head. PR 1316 (`8bd999eab`): a review of a web PR gets a preview hub of its head (`apps/server/src/preview/review.ts`), rendered in both themes (`PREVIEW_THEMES` in `apps/server/src/preview/browser.ts`). Hub itself: commit `6e3d58bdc`. FLIGHT's `screenshot_hud` covers the live hub. | `apps/server/test/review-preview.test.ts`, `apps/server/test/review-shots.test.ts`, `apps/server/test/supervisor-review.test.ts`; hub: `apps/server/test/previews.test.ts` | none |
| 4 | One CI run proves a flake fix | PR 1333, `.github/workflows/repeat-test.yml` (`397a7a299`), merged into PR 1339's branch | `apps/server/test/repeat-test.test.ts` | none |
| 5 | Round cap (**revised**) | PR 1776 added the review-rounds hold for FLIGHT (`reviewsHeld` in `apps/server/src/spend/waste.ts`); PR 1471 (`24cee2dce`) made a late finding Minor unless it is Critical. PR 1951 made a FLIGHT settle close the hold. FLIGHT settles with accept, a second review or rework (`roles/FLIGHT.md` line 71). | `apps/server/test/waste.test.ts`, `apps/server/test/engine.test.ts` ("past the round cap" cases), and this PR's `apps/server/test/role-design.test.ts` (the RETRO rule: only Critical late findings stay blocking) | PR 1471 had no test change; this PR adds its focused regression test |

Item 5's primary PR 1471 reached main without a test change. This PR is its recorded focused-test follow-up: `role-design.test.ts` keeps the RETRO rule that a late finding is Minor unless it is Critical. The adjacent hold and settle remain covered by `waste.test.ts` and `engine.test.ts`. Items 3 and 5 landed under other tickets' PRs, in revised form.

Standing decisions behind the two revisions: item 3 renders the PR head through the review preview instead of a FLIGHT tool; item 5 holds for FLIGHT instead of sending the ticket back to planning. If "back to planning" is still wanted, it is a new ticket.

## Measuring the window

Make a copy, never read the live file:

```
sqlite3 <hub db> ".backup <copy>"
node --experimental-strip-types apps/server/scripts/pipeline-window.ts --db <copy> --repo mission-control --from <ISO time> [--hours 24]
```

It places each CI job by `at`, the recorded CI-result timestamp. It reports crew-PR CI job failures split into lint/typecheck/build and tests, the blocking findings that match wording asking for controller-only evidence (candidates: read each), and how many reviews named a `Controller check:`. The `check` summary job is left out; a PR with no crew run is not counted. Test: `apps/server/test/pipeline-window.test.ts`.

## 24-hour result

Not yet measured. FLIGHT or the controller adds the output here, then judges the ticket's first Done-when line.
