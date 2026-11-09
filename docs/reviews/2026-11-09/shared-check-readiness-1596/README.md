# Shared check readiness for the existing review-reassignment run

The preserved author run for #1596 completed its native related check with 12,646 passing tests,
two failures and 771 skipped tests. Its work and run remain intact. This change repairs shared test
preparations; it does not complete #1596 or the native workflow proof in #1626.

## Evidence scrolling

The evidence test pressed native End and inspected the drawer after a fixed 100 ms. Replaying the
author's exact diagnostic against its unchanged product source measured scrollTop 690 at 100 ms
and 881 after the animation completed. A stronger endpoint assertion then failed on the old wait:
the visible scroll extent was 1,090 px instead of the required 1,391 px. This demonstrates that the
fixed delay can read an unfinished keyboard scroll; it does not establish that every historical
failure had the same timing.

The test now waits, with a two-second deadline, for the actual scroll endpoint. It asserts that
endpoint and retains the original exact text, horizontal containment and full vertical visibility
assertions. No code sets scrollTop or forces the target into view. If native End does not work, the
same assertions still fail. All four evidence-dialog browser cases pass after correction.

## Relay setup

The attack fixture used the default one-second poll to wait for two authenticated peers. A real
1.5-second delayed fake connection, still within the production ten-second HELLO deadline,
reproduces the original zero-versus-two readiness failure. Setup now waits within HELLO_TIMEOUT_MS.
The delayed-connection regression and all 22 existing attack cases pass. Attack, quarantine, cursor
and replay assertions remain unchanged. Stopping a pending fake socket cancels its scheduled open.

## Canonical install fixture

The first composed full run finished with 14,664 passing tests and one failure in the publisher
install fixture. The named installed case also fails in isolation. On this Mac, `tmpdir()` returns
`/var/folders/...`, while its real path begins `/private/var/folders/...`. The production shared-store
guard deliberately rejects non-canonical roots. The publisher fixture now resolves its newly created
temporary directory, matching the existing checkout fixture. No production guard, install input
check, expected install outcome or assertion changes.

## Validation and limits

All 27 affected cases pass on configured Node 26.13.0: four real-browser cases and 23 relay cases.
The first full run is a failure, not a clean pass: 14,664 passed and one canonical-path fixture
failed across 534 files. Its automatic build step did not run. Lint, workspace typecheck and a
separate production build passed before that full run. All 27 publisher cases then pass with the canonical fixture. Lint and workspace typecheck pass
again; lint reports 103 existing warnings and seven infos. The second full validation, fresh CI
and independent review are recorded separately as they finish. No unfinished result is claimed.

The original crew worktree, native run, check receipts and push evidence are not altered by this
controller checkout. After this shared correction is merged, the preserved author still needs its
configured checks and real push. This partial fix closes neither #1596 nor #1626 and supplies no
approval, review waiver, quota override, install exception or source-ownership exception.
