# Pipeline delivery and the 24-hour measurement (#925)

What landed for each of the ticket's five items, and how to measure the outcome. A seat cannot read the hub database, so the measurement is run by FLIGHT or the controller on a copy.

## Baseline (ticket, 29 October, last 24 hours)

- CI: 300 runs, 34 failed; about 25 failures on crew branches were real (typecheck, route table, role tests).
- Reviews: 199 passes on 63 PRs; 147 (74%) had a blocking finding; 50 of 388 blocking findings asked for evidence the seat cannot produce.

## What landed

| # | Item | Where | Tests |
| --- | --- | --- | --- |
| 1 | Pre-push gate (lint, typecheck, related tests) | merge `c3192017a` adds the related-test push check; the exact-head rule followed later (`docs/reviews/2026-11-13/repeated-review-findings.md`) | push-gate tests under `apps/server/test` |
| 2 | Controller check is a merge step, not a finding | `controllerCheckHold`, `controllerCheck`, `ticketControllerCheck` in `apps/server/src/engine/engine.ts`; `edcf13795` keeps the section on edit; `roles/RETRO.md` line 23 | `apps/server/test/engine.test.ts` |
| 3 | UI checks without the controller (**revised**) | No FLIGHT tool for a PR head. A review of a web PR gets a preview hub of the PR head (`apps/server/src/preview/review.ts`, `6e3d58bdc`); RETRO's preview browser renders it in both themes (`PREVIEW_THEMES` in `apps/server/src/preview/browser.ts`). FLIGHT's `screenshot_hud` covers the live hub. | preview tests under `apps/server/test` |
| 4 | One CI run proves a flake fix | `.github/workflows/repeat-test.yml`, `397a7a299` | the workflow itself |
| 5 | Round cap (**revised**) | A change past its review rounds is held for FLIGHT (`reviewsHeld`, `settleReviewRounds` in `apps/server/src/spend/waste.ts`); FLIGHT settles with accept, a second review or rework (`roles/FLIGHT.md` line 71). `24cee2dce` (5 November) made the cap end in accept unless a finding is Critical. | `apps/server/test` waste and review-round tests |

Standing decisions behind the two revisions: item 3 renders the PR head through the review preview instead of a FLIGHT tool; item 5 holds for FLIGHT instead of sending the ticket back to planning. If "back to planning" is still wanted, it is a new ticket.

Check the test files with `git ls-files` before relying on a name above.

## Measuring the window

Make a copy, never read the live file:

```
sqlite3 <hub db> ".backup <copy>"
node --experimental-strip-types apps/server/scripts/pipeline-window.ts --db <copy> --repo mission-control --from <ISO time> [--hours 24]
```

It reports crew-PR CI job failures split into lint/typecheck/build and tests, the blocking findings that match wording asking for controller-only evidence (candidates: read each), and how many reviews named a `Controller check:`. The `check` summary job is left out; a PR with no crew run is not counted. Test: `apps/server/test/pipeline-window.test.ts`.

## 24-hour result

Not yet measured. FLIGHT or the controller adds the output here, then judges the ticket's first Done-when line.
