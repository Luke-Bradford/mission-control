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

The test waits, with a two-second deadline, for the actual scroll endpoint and asserts that endpoint.
CI then exposed a second assumption: reaching the record bottom does not guarantee its middle
Environment field is still visible. That head failed CI with 6,494 passing browser/core tests and
one failed visibility assertion, despite passing the new endpoint assertion. The original local full
pass is not relabelled as a CI pass.

A realistic long cause-evidence field after Environment reproduces the problem locally, with fonts
loaded: Environment spans y=68–132, above the body's y=139–650, while scrollTop 957 plus clientHeight
511 equals the full 1,468 px scroll height. The corrected inspection keeps the End proof, then follows the normal Tab path into the expanded
record and uses bounded native PageUp/PageDown steps. Each key waits for the browser's native
`scrollend` signal before the next inspection. Merely reaching the first rounded endpoint did not
reliably prepare the next key: diagnostic probes observed no movement even while a record control
held focus. No claim is made about an unmeasured compositor cause. It first checks
that the complete field can fit in the body. The original exact text, horizontal containment and
full vertical visibility assertions remain intact. No code sets scrollTop or calls scrollIntoView.
A broken End, a non-moving scroll region or an unreachable field still fails. Detailed geometry is
retained on failure. The exact Linux geometry was not retained by the old CI assertion, so no
unmeasured font-specific cause is claimed.

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


## Validation after the first CI result

Head `3e26e6573595dd9cca3cb4e17cbd9f8fa6264876` passed its second full local run:
14,665 tests across 534 files and the production build. It then failed CI on the Environment
visibility assumption above. The added long trailing evidence reproduces that same visibility
failure before the native-paging correction. The source now tests both real End behavior and
keyboard inspection of a middle field. Final affected checks, a new full local run and fresh
exact-head CI/review are recorded as they complete. No historical passing result clears a new head.

All 54 affected cases pass after native scroll-completion handling: four real-browser cases, 23
relay cases and 27 publisher cases. Repeated targeted inspection and the new full run are recorded
separately; a focused pass does not clear the failed published-head CI.

The corrected long-record inspection also passes all ten separate targeted invocations. Each
invocation exercises the same six theme/count scenarios; these are repetitions, not ten additional
unique tests. Earlier unsuccessful geometry/paging probes remain diagnostic history. The native
`scrollend` preparation is used for both End and subsequent paging keys, with bounded waits and
listener cleanup. No input, visibility assertion or failed published-head result is waived.
