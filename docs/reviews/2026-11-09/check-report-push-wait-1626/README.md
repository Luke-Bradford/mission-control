# Fresh evidence after a mechanical push wait

This is a continuation of #1626, prompted by the preserved #1596 author. Neither ticket
is complete: a successful native push is still required. The baseline is main at
`130bdfeaee678663ef9962d3e26f899de92ac959`.

## Actual live observation

The preserved run is `guido-cx:20261109T035107Z`. Its recovery commit is
`f4668907f13d2220b4c141ef3a705afa5dabfa0d`. All three configured checks have genuine
head-bound exit-0 receipts: lint 2436, typecheck 2437 and test:related 2438.

The final related-test execution is `exec-06df1f24-8132-4dc2-b134-4699f9757fe2`,
completed at 17:33:55.692 UTC on 9 November 2026, exit 0 after 747,407 ms. Its actual
summary reports 12,922 passed and 777 capability-gated skips across 432 selected files.
The retained provider output is truncated; its completion event and matching recorder
row are verified separately. There is no successful push receipt yet.

The first composed attempt, b4edc6b, genuinely failed five fake-CLI cases because the
new brief-choice file lacked the existing crew-run capability probe. The author added
that registration in f466890, without changing the five assertions or production guards.
The subsequent configured check passed. These skips do not claim five live-seat fake-CLI
executions; controller/CI environments with the capability still run their assertions.

The previous failed handoff had left the run in CI. The new recovery commit restarted
its ten-minute missing-push clock while the configured check was active. The run entered
the non-ended `stuck` park before the check completed. At 17:34:16.511 UTC its normal
fresh `report_evidence` call was refused as waiting on the operator. The recorder counted
the pass correctly; a separate report/recovery mismatch now blocks publication.

No manual push-gate release, direct push, new author run or fabricated receipt was used.
The last manual resume predates this recovery commit and its check; it addressed the
run's earlier silent stop, not this publication stop.

## Bounded correction

The existing fresh-report recovery path already permits non-ended review, silent,
refused-publication and conflict parks. It now also permits the mechanical `stuck` park.
That one eligibility change lets a genuinely fresh committed report reach the unchanged
validation and publication path. It does not mark checks passed, push a branch, extend
a quota, waive a review or approve a merge.

The existing pending-check refusal still prevents an early handoff. An already reported
head still lacks a fresh commit and stays stopped. Ended runs, account/budget stops,
controller checks, acceptance holds and hard-rule gates remain held. The clone-queue and
post-filesystem-read checks continue to preserve a budget hold arriving during the call.

## Regression and validation phase

The new cases first fail on unchanged baseline: a fresh report from the mechanical stop
returns the operator-wait refusal. The composed regression retains an older failed-check
report, a new recovery commit, a pending recorder call, the mechanical stop, completed
exit 0, a fresh report, and refusal of a second report on the already reported head.
An operator-ended mechanical stop remains held. The budget race is exercised from both
an existing review stop and the mechanical stop.

All 677 MCP and loop cases pass. Lint and workspace typecheck pass; lint reports the
existing 103 warnings and seven infos. Full local test/build, exact-head CI and a fresh
independent most-capable whole-branch review are required before this code goes live.
This record is written before that full validation; it claims none of those future results.

After an approved deployment, the preserved author must submit its fresh report through
the normal tool. Verify the final command event, matching check row and actual push
separately before closing #1626. Preserve this failed observation if the push still fails.

This changes no UI, install input, configured check command, quota or observed loop.
Screenshots do not apply to this evidence-report recovery change.
